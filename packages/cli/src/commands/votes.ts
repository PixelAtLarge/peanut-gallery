import pc from 'picocolors';
import { LABELS } from '@pixelatlarge/peanut-gallery-core';
import { loadConfig, readJson, workPath, writeJson } from '../config.js';
import { addLabels, commentOnIssue, getCommentReactions, getIssueCommentsAfter, issuesWithLabel, listIssueComments, removeLabel, type IssueComment } from '../github.js';
import type { RunRecord } from './apply.js';
import { jobSummary } from '../ci.js';

const MARK = /<sub>peanut-gallery proposal `([^`]+)`(?: · options round (\d+))?<\/sub>/;
const PR_URL = /https:\/\/github\.com\/[^\s)]+\/pull\/(\d+)/;

/**
 * Rebuild run records from the comparison comments peanut-gallery posted on an issue, so votes
 * work without the local .peanut-gallery/runs.json (a CI runner, another machine).
 */
export function runsFromComments(issue: number, comments: IssueComment[]): RunRecord[] {
  const out: RunRecord[] = [];
  for (const c of comments) {
    const m = MARK.exec(c.body);
    if (!m) continue;
    const id = m[1];
    const ref = { issue, commentId: c.id, url: c.url };
    const base = { branch: '', screenshots: [], status: 'pr-opened' as const, createdAt: c.createdAt, issueCommentIds: [ref] };
    if (m[2]) {
      const title = /^### \d+ options? for: (.+)$/m.exec(c.body)?.[1]?.trim() ?? id;
      for (const line of c.body.matchAll(/^\*\*([A-Z]\d*)\*\* — (.+?)(?: · (https:\/\/\S+))?$/gm)) {
        const pr = line[3] ? PR_URL.exec(line[3]) : null;
        out.push({ ...base, issueCommentIds: [{ ...ref }], proposalId: `${id}_${line[1].toLowerCase()}`, title: `${title} — ${line[2].trim()}`, variantOf: id, variantLabel: line[1], ...(pr ? { prUrl: pr[0], prNumber: Number(pr[1]) } : {}) });
      }
    } else {
      const title = /^### Proposed update: (.+)$/m.exec(c.body)?.[1]?.trim() ?? id;
      const pr = /Pull request: (\S+)/.exec(c.body)?.[1];
      const prm = pr ? PR_URL.exec(pr) : null;
      out.push({ ...base, proposalId: id, title, ...(prm ? { prUrl: prm[0], prNumber: Number(prm[1]) } : {}) });
    }
  }
  return out;
}

/** Local records first; add anything only GitHub knows about, and comment refs local records lack. */
export function mergeRuns(local: RunRecord[], remote: RunRecord[]): RunRecord[] {
  const all = local.map((r) => ({ ...r, issueCommentIds: [...r.issueCommentIds] }));
  for (const r of remote) {
    const have = all.find((x) => x.proposalId === r.proposalId);
    if (!have) all.push(r);
    else for (const c of r.issueCommentIds) if (!have.issueCommentIds.some((x) => x.commentId === c.commentId)) have.issueCommentIds.push(c);
  }
  return all;
}

const VERDICT = (key: string) => new RegExp(`<!-- peanut-gallery:verdict ${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\S+) -->`, 'g');

/** The last verdict peanut-gallery posted for `key` among these comments, if any. */
export function lastVerdict(comments: { body: string }[], key: string): string | null {
  let last: string | null = null;
  for (const c of comments) for (const m of c.body.matchAll(VERDICT(key))) last = m[1];
  return last;
}

/** Post a verdict on a PR only when it differs from the last one (CI runs this on every reply). */
async function postVerdictOnce(repo: string, pr: number, key: string, verdict: string, body: string): Promise<boolean> {
  const comments = await listIssueComments(repo, pr).catch(() => []);
  if (lastVerdict(comments, key) === verdict) return false;
  await commentOnIssue(repo, pr, `${body}\n\n<!-- peanut-gallery:verdict ${key} ${verdict} -->`);
  return true;
}

export interface VoteSummary {
  proposalId: string;
  title: string;
  prUrl?: string;
  after: number;
  before: number;
  replies: { issue: number; author: string; text: string; lean: 'after' | 'before' | 'unclear' }[];
  verdict: 'after' | 'before' | 'mixed' | 'no-votes';
}

export async function votesCommand(opts: { label?: boolean; local?: boolean } = {}): Promise<VoteSummary[]> {
  const cfg = loadConfig();
  let all = readJson<RunRecord[]>(workPath('runs.json'), []);
  if (!opts.local) {
    // Also read what's on GitHub: proposals posted from CI or another machine.
    const remote: RunRecord[] = [];
    for (const n of await issuesWithLabel(cfg.repo, cfg.labels?.proposal ?? LABELS.proposal).catch(() => [] as number[])) {
      remote.push(...runsFromComments(n, await listIssueComments(cfg.repo, n).catch(() => [])));
    }
    all = mergeRuns(all, remote);
  }
  const runs = all.filter((r) => r.issueCommentIds.length && !r.variantOf);
  // Variant rounds: tally letters on the shared options comment.
  const rounds = new Map<string, RunRecord[]>();
  for (const r of all.filter((r) => r.variantOf && r.issueCommentIds.length)) rounds.set(r.variantOf!, [...(rounds.get(r.variantOf!) ?? []), r]);
  for (const [pid, vs] of rounds) {
    const labels = vs.map((v) => v.variantLabel!);
    const tally = Object.fromEntries(labels.map((l) => [l, 0])) as Record<string, number>;
    const seen = new Set<number>();
    const replies: { author: string; text: string; pick: string | null }[] = [];
    for (const c of vs.flatMap((v) => v.issueCommentIds)) {
      if (seen.has(c.commentId)) continue;
      seen.add(c.commentId);
      for (const reply of await getIssueCommentsAfter(cfg.repo, c.issue, c.commentId)) {
        if (reply.body.includes('peanut-gallery proposal')) continue;
        const pick = classifyOption(reply.body, labels);
        if (pick) tally[pick]++;
        replies.push({ author: reply.author, text: reply.body.split('\n')[0].slice(0, 140), pick });
      }
    }
    const best = labels.slice().sort((a, b) => tally[b] - tally[a])[0];
    const total = Object.values(tally).reduce((a, b) => a + b, 0);
    console.log(`\n${total ? pc.green(`OPTION ${best}`) : pc.dim('no votes')}  ${pc.bold(vs[0].title.split(' — ')[0])} ${pc.dim(`[${pid}] ${labels.map((l) => `${l}:${tally[l]}`).join(' · ')}`)}`);
    for (const v of vs) if (v.prUrl) console.log(pc.dim(`  ${v.variantLabel} ${v.prUrl}`));
    for (const rep of replies) console.log(`  ${rep.pick ? pc.green(rep.pick.padEnd(6)) : pc.dim('  ?   ')} ${pc.dim(`${rep.author}:`)} ${rep.text}`);
    if (opts.label && total) {
      for (const v of vs) v.status = v.variantLabel === best ? 'accepted' : 'rejected';
      const issues = Array.from(new Set(vs.flatMap((v) => v.issueCommentIds.map((c) => c.issue))));
      for (const n of issues) await addLabels(cfg.repo, n, [cfg.labels?.accepted ?? LABELS.accepted]).catch(() => {});
      const win = vs.find((v) => v.variantLabel === best);
      if (win?.prNumber) await postVerdictOnce(cfg.repo, win.prNumber, `${pid}:options`, best, `✅ Reviewers picked option **${best}** (${labels.map((l) => `${l}: ${tally[l]}`).join(', ')}). Ready to merge.`).catch(() => {});
    }
  }
  if (!runs.length) {
    console.log(pc.yellow('No proposals have been posted for voting yet. Run `peanut-gallery apply` first.'));
    return [];
  }
  const out: VoteSummary[] = [];
  for (const r of runs) {
    let after = 0;
    let before = 0;
    const replies: VoteSummary['replies'] = [];
    for (const c of r.issueCommentIds) {
      const re = await getCommentReactions(cfg.repo, c.commentId);
      after += re['+1'] + re.heart + re.rocket;
      before += re['-1'] + re.confused;
      for (const reply of await getIssueCommentsAfter(cfg.repo, c.issue, c.commentId)) {
        if (reply.body.includes('peanut-gallery proposal')) continue; // our own
        const lean = classify(reply.body);
        if (lean === 'after') after++;
        if (lean === 'before') before++;
        replies.push({ issue: c.issue, author: reply.author, text: reply.body.split('\n')[0].slice(0, 140), lean });
      }
    }
    const verdict: VoteSummary['verdict'] = !after && !before ? 'no-votes' : after > before ? 'after' : before > after ? 'before' : 'mixed';
    const s: VoteSummary = { proposalId: r.proposalId, title: r.title, prUrl: r.prUrl, after, before, replies, verdict };
    out.push(s);
    const tag = verdict === 'after' ? pc.green('AFTER') : verdict === 'before' ? pc.red('BEFORE') : verdict === 'mixed' ? pc.yellow('MIXED') : pc.dim('no votes');
    console.log(`\n${tag}  ${pc.bold(r.title)} ${pc.dim(`[${r.proposalId}] 👍 ${after} · 👎 ${before}`)}`);
    if (r.prUrl) console.log(pc.dim(`  ${r.prUrl}`));
    for (const rep of replies) console.log(`  ${lean(rep.lean)} ${pc.dim(`#${rep.issue} ${rep.author}:`)} ${rep.text}`);

    if (opts.label && (verdict === 'after' || verdict === 'before')) {
      const accepted = cfg.labels?.accepted ?? LABELS.accepted;
      const rejected = cfg.labels?.rejected ?? LABELS.rejected;
      const [label, other] = verdict === 'after' ? [accepted, rejected] : [rejected, accepted];
      for (const c of r.issueCommentIds) {
        await addLabels(cfg.repo, c.issue, [label]).catch(() => {});
        await removeLabel(cfg.repo, c.issue, other).catch(() => {});
      }
      if (r.prNumber) {
        await postVerdictOnce(cfg.repo, r.prNumber, r.proposalId, verdict, verdict === 'after' ? `✅ Reviewers preferred **After** (👍 ${after} · 👎 ${before}). Ready to merge.` : `🛑 Reviewers preferred **Before** (👍 ${after} · 👎 ${before}). Consider closing or revising.`).catch(() => {});
      }
      r.status = verdict === 'after' ? 'accepted' : 'rejected';
    }
  }
  if (opts.label) writeJson(workPath('runs.json'), all);
  if (out.length) {
    jobSummary(['### 🥜 Votes', '', '| Change | 👍 After | 👎 Before | Verdict |', '| --- | --- | --- | --- |', ...out.map((v) => `| ${v.prUrl ? `[${v.title.replace(/\|/g, '\\|')}](${v.prUrl})` : v.title.replace(/\|/g, '\\|')} | ${v.after} | ${v.before} | ${v.verdict === 'no-votes' ? 'no votes yet' : v.verdict} |`), ''].join('\n'));
  }
  return out;
}

/**
 * Detect an option label ("B", "option b", "go with A2") among known labels.
 * Single letters are only accepted as "option X", an uppercase standalone X, or a reply that is just X —
 * so the article "a" in "I think a bigger button" doesn't count as a vote for A.
 */
export function classifyOption(body: string, labels: string[]): string | null {
  const text = body.trim();
  const lower = text.toLowerCase();
  const positions: { label: string; at: number }[] = [];
  for (const l of labels) {
    const ll = l.toLowerCase();
    const esc = ll.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const explicit = new RegExp(`option\\s*${esc}(?![a-z0-9])`).exec(lower);
    if (explicit) { positions.push({ label: l, at: explicit.index }); continue; }
    const bare = new RegExp(`(^|[^a-z0-9])${esc}(?![a-z0-9])`, 'i');
    if (l.length === 1) {
      const upper = new RegExp(`(^|[^A-Za-z0-9])${l.toUpperCase()}(?![A-Za-z0-9])`).exec(text);
      const alone = new RegExp(`^${esc}[.!]?$`).test(lower.replace(/\s*(please|pls|for sure|definitely)\s*[.!]?$/, ''));
      if (upper) positions.push({ label: l, at: upper.index });
      else if (alone) positions.push({ label: l, at: 0 });
    } else {
      const m = bare.exec(text);
      if (m) positions.push({ label: l, at: m.index });
    }
  }
  if (!positions.length) return null;
  return positions.sort((a, b) => a.at - b.at)[0].label;
}

export function classify(body: string): 'after' | 'before' | 'unclear' {
  const t = body.toLowerCase();
  const a = /\b(after|new one|new version|the update|ship it|lgtm|👍|looks better|prefer the change)\b/.test(t);
  const b = /\b(before|old one|original|revert|keep it as is|👎|prefer the old)\b/.test(t);
  if (a && !b) return 'after';
  if (b && !a) return 'before';
  if (a && b) return t.indexOf('after') < t.indexOf('before') ? 'after' : 'before';
  return 'unclear';
}

function lean(l: 'after' | 'before' | 'unclear') {
  return l === 'after' ? pc.green('after ') : l === 'before' ? pc.red('before') : pc.dim('  ?   ');
}

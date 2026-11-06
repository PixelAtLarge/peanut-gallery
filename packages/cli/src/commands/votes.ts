import pc from 'picocolors';
import { LABELS } from '@peanut-gallery/core';
import { loadConfig, readJson, workPath, writeJson } from '../config.js';
import { addLabels, commentOnIssue, getCommentReactions, getIssueCommentsAfter } from '../github.js';
import type { RunRecord } from './apply.js';

export interface VoteSummary {
  proposalId: string;
  title: string;
  prUrl?: string;
  after: number;
  before: number;
  replies: { issue: number; author: string; text: string; lean: 'after' | 'before' | 'unclear' }[];
  verdict: 'after' | 'before' | 'mixed' | 'no-votes';
}

export async function votesCommand(opts: { label?: boolean } = {}): Promise<VoteSummary[]> {
  const cfg = loadConfig();
  const all = readJson<RunRecord[]>(workPath('runs.json'), []);
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
      if (win?.prNumber) await commentOnIssue(cfg.repo, win.prNumber, `✅ Reviewers picked option **${best}** (${labels.map((l) => `${l}: ${tally[l]}`).join(', ')}). Ready to merge.`).catch(() => {});
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
      const label = verdict === 'after' ? (cfg.labels?.accepted ?? LABELS.accepted) : (cfg.labels?.rejected ?? LABELS.rejected);
      for (const c of r.issueCommentIds) await addLabels(cfg.repo, c.issue, [label]).catch(() => {});
      if (r.prNumber) {
        await commentOnIssue(cfg.repo, r.prNumber, verdict === 'after' ? `✅ Reviewers preferred **After** (👍 ${after} · 👎 ${before}). Ready to merge.` : `🛑 Reviewers preferred **Before** (👍 ${after} · 👎 ${before}). Consider closing or revising.`).catch(() => {});
      }
      r.status = verdict === 'after' ? 'accepted' : 'rejected';
    }
  }
  if (opts.label) writeJson(workPath('runs.json'), all);
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

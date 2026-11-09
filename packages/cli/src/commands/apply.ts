import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import pc from 'picocolors';
import { LABELS, type Proposal, type ProposalRun } from '@pixelatlarge/peanut-gallery-core';
import { implementProposal } from '../agent.js';
import { loadConfig, readJson, workPath, writeJson, WORK_DIR, type ResolvedConfig } from '../config.js';
import { startDevServer, type RunningServer } from '../devserver.js';
import { addLabels, blobImageUrl, commentOnIssue, createPr, git, updatePrBody, type FeedbackIssue } from '../github.js';
import { flatten, type FlatAnnotation } from '../interpret.js';
import { authHint, hasCredentials } from '../llm.js';
import { auditChangedFiles } from '../policy.js';
import { effectivePolicy, readProjectGuidance } from '../design.js';
import { checksMarkdown, runChecks, type CheckResult } from '../checks.js';
import { undefinedClassesCheck } from '../builtin-checks.js';
import { renderComparePage, renderSummaryPage, type ComparePair } from '../compare.js';
import { applySummaryMarkdown, jobSummary } from '../ci.js';
import { expandHeaders, normalizePreview, previewEnabled, productionUrl, waitForPreview } from '../preview.js';
import { captureShots, renderHtmlToPng, type ShotResult, type ShotTarget } from '../screenshots.js';
import { pathOf } from './pull.js';

export interface ApplyOptions {
  only?: string[];
  pr?: boolean; // default true
  draft?: boolean;
  screenshots?: boolean; // default true
  comment?: boolean; // default true: post comparison back to issues
  /** Apply contested proposals using the model's recommended position instead of skipping them. */
  includeContested?: boolean;
  /** Spend cap in USD for this invocation; stops before a proposal whose estimate would exceed it. */
  budget?: number;
  /** Print the cost estimate and exit without building. */
  dryRun?: boolean;
  port?: number;
  /** Swap the coding agent (tests/e2e harness). Defaults to the Claude Agent SDK. */
  implement?: typeof implementProposal;
  proposals?: Proposal[];
  issues?: FeedbackIssue[];
}

export interface RunRecord extends ProposalRun {
  title: string;
  issueCommentIds: { issue: number; commentId: number; url: string }[];
  agentSummary?: string;
  costUsd?: number;
  /** Proposal size and agent model, so later cost estimates can learn from this run. */
  effort?: Proposal['effort'];
  model?: string;
  createdAt: string;
  /** Set when this run is one option of a `variants` round. */
  variantOf?: string;
  variantLabel?: string;
  /** Local copy of the compare folder (screenshots + compare.html) in the main checkout. */
  localCompareDir?: string;
  /** Preview deployment the "after" screenshots came from, when preview is on. */
  previewUrl?: string;
  /** Labels of shot targets, in order, so variant rounds can line up columns. */
  targetLabels?: string[];
  /** Results of the configured `checks` on this change. */
  checks?: { name: string; ok: boolean; required: boolean }[];
}

/** Shared state for a batch of proposal runs (config, annotations, the "before" server). */
export interface RunContext {
  cfg: ResolvedConfig;
  root: string;
  issues: FeedbackIssue[];
  annotations: FlatAnnotation[];
  runs: RunRecord[];
  basePort: number;
  before: RunningServer | null;
  /** USD spent by agent runs in this invocation. */
  spent: number;
}

export async function createRunContext(opts: { issues?: FeedbackIssue[]; port?: number } = {}): Promise<RunContext> {
  const cfg = loadConfig();
  const issues = opts.issues ?? readJson<FeedbackIssue[]>(workPath('feedback.json'), []);
  const root = await git(['rev-parse', '--show-toplevel']);
  if (await git(['status', '--porcelain']).then((s) => s.length > 0)) {
    console.log(pc.yellow('Note: working tree has uncommitted changes; proposals branch from the committed base branch.'));
  }
  return {
    cfg,
    root,
    issues,
    annotations: flatten(issues),
    runs: readJson<RunRecord[]>(workPath('runs.json'), []),
    basePort: opts.port ?? cfg.dev?.port ?? 4310,
    before: null,
    spent: 0,
  };
}

export async function applyCommand(opts: ApplyOptions = {}): Promise<RunRecord[]> {
  const allProposals = opts.proposals ?? readJson<Proposal[]>(workPath('proposals.json'), []);
  const proposals = opts.only?.length ? allProposals.filter((p) => opts.only!.some((o) => p.id === o || p.id.endsWith(o))) : allProposals;
  if (!proposals.length) {
    console.log(pc.yellow('No proposals to apply. Run `peanut-gallery interpret` first.'));
    return [];
  }
  if (!(await hasCredentials())) throw new Error(authHint());
  const ctx = await createRunContext(opts);
  const budget = opts.budget ?? ctx.cfg.budget;
  printEstimate(ctx, proposals, budget);
  if (opts.dryRun) return [];
  const results: RunRecord[] = [];
  try {
    for (const [idx, p] of proposals.entries()) {
      console.log(pc.bold(`\n━━ ${idx + 1}/${proposals.length} ${p.title} ${pc.dim(`[${p.id}] ${supportLine(p)}`)}`));
      if (p.contested && !opts.includeContested) {
        await gateContested(ctx, p, opts);
        continue;
      }
      if (!withinBudget(ctx, p.effort, budget)) break;
      const rec = await runProposal(ctx, p, idx, opts);
      if (rec) results.push(rec);
    }
  } finally {
    await ctx.before?.stop();
  }
  if (ctx.spent) console.log(pc.dim(`\nagent spend this run: $${ctx.spent.toFixed(2)}${budget ? ` of $${budget.toFixed(2)} budget` : ''}`));
  jobSummary(applySummaryMarkdown(results.map((r) => ({ title: r.title, prUrl: r.prUrl, issues: Array.from(new Set(r.issueCommentIds.map((c) => c.issue))), status: r.status, costUsd: r.costUsd })), ctx.spent, budget));
  return results;
}

/** Rough per-proposal agent cost by effort, refined by what previous runs actually cost. */
/**
 * Starting guesses per proposal size, in USD, for the default agent model. Calibrated from real
 * runs: a small single-component change on a small prototype cost about $0.90 with Sonnet; larger
 * codebases mean more reading, so the defaults sit a little above that.
 */
export const DEFAULT_COST: Record<Proposal['effort'], number> = { small: 1.0, medium: 2.0, large: 4.0 };

export interface CostEstimate {
  usd: number;
  /** How many past runs the estimate was learned from (0 = defaults). */
  basis: number;
}

/**
 * Estimate one agent run. With two or more past priced runs (from `.peanut-gallery/runs.json`),
 * learn a project-specific multiplier: each past cost is divided by its size's default, and the
 * median ratio of the 20 most recent runs scales this proposal's default. Runs with the same agent
 * model are preferred when there are enough of them. Older records without a size count as medium.
 */
export function estimateCostDetail(ctx: Pick<RunContext, 'runs'>, effort: Proposal['effort'], model?: string): CostEstimate {
  const base = DEFAULT_COST[effort] ?? DEFAULT_COST.medium;
  const priced = ctx.runs.filter((r) => typeof r.costUsd === 'number' && r.costUsd > 0);
  const sameModel = model ? priced.filter((r) => r.model === model) : [];
  const pool = (sameModel.length >= 2 ? sameModel : priced).slice(-20);
  if (pool.length < 2) return { usd: base, basis: 0 };
  const ratios = pool.map((r) => r.costUsd! / (DEFAULT_COST[r.effort ?? 'medium'] ?? DEFAULT_COST.medium)).sort((x, y) => x - y);
  const mid = ratios.length / 2;
  const median = ratios.length % 2 ? ratios[Math.floor(mid)] : (ratios[mid - 1] + ratios[mid]) / 2;
  return { usd: Math.round(base * median * 100) / 100, basis: pool.length };
}

export function estimateCost(ctx: Pick<RunContext, 'runs'>, effort: Proposal['effort'], model?: string): number {
  return estimateCostDetail(ctx, effort, model).usd;
}

export function withinBudget(ctx: RunContext, effort: Proposal['effort'], budget?: number): boolean {
  if (!budget) return true;
  const est = estimateCost(ctx, effort, ctx.cfg.models.apply);
  if (ctx.spent + est <= budget) return true;
  console.log(pc.yellow(`  ⏸ budget: spent $${ctx.spent.toFixed(2)} + est. $${est.toFixed(2)} would exceed $${budget.toFixed(2)} — stopping. Re-run with --budget to continue.`));
  return false;
}

function printEstimate(ctx: RunContext, proposals: Proposal[], budget?: number) {
  const model = ctx.cfg.models.apply;
  const rows = proposals.map((p) => ({ p, est: p.contested ? 0 : estimateCost(ctx, p.effort, model) }));
  const total = rows.reduce((a, r) => a + r.est, 0);
  const { basis } = estimateCostDetail(ctx, 'medium', model);
  const source = basis ? `learned from ${basis} past run${basis === 1 ? '' : 's'}` : 'default rates; learns from your runs';
  console.log(pc.dim(`\nestimate (agent ${model}, ${source}): ${rows.map((r) => `${r.p.effort}≈$${r.est.toFixed(2)}`).join(' + ')} ≈ $${total.toFixed(2)}${budget ? ` · budget $${budget.toFixed(2)}` : ''}`));
  if (budget && total > budget) console.log(pc.yellow(`estimate exceeds budget; will stop partway. Use --only to pick proposals or raise --budget.`));
}

async function gateContested(ctx: RunContext, p: Proposal, opts: ApplyOptions) {
  const c = p.contested!;
  console.log(pc.yellow(`  ⚑ contested — ${c.reason}`));
  c.positions.forEach((pos, n) => console.log(`    ${n}. ${pos.summary} ${pc.dim(`— ${pos.reviewers.join(', ')}`)}`));
  const already = ctx.runs.find((r) => r.proposalId === p.id && r.status === 'decision-needed');
  if (opts.comment !== false && opts.pr !== false && !already) {
    const rec: RunRecord = { proposalId: p.id, title: p.title, branch: '', screenshots: [], issueCommentIds: [], status: 'decision-needed', createdAt: new Date().toISOString() };
    for (const n of p.issueNumbers) {
      const cm = await commentOnIssue(ctx.cfg.repo, n, decisionComment(p));
      rec.issueCommentIds.push({ issue: n, commentId: cm.id, url: cm.url });
    }
    ctx.runs.push(rec);
    writeJson(workPath('runs.json'), ctx.runs);
    console.log(pc.yellow(`  posted "decision needed" to ${p.issueNumbers.map((n) => '#' + n).join(', ')}`));
  }
  console.log(pc.dim(`  skipped. Resolve with \`peanut-gallery decide ${p.id} <n>\`, build options with \`peanut-gallery variants ${p.id}\`, or re-run with --include-contested`));
}

/**
 * Implement one proposal on its own branch, capture before/after, optionally open a PR and
 * post the comparison to the source issues. Returns null when the agent produced no changes.
 */
export async function runProposal(
  ctx: RunContext,
  p: Proposal,
  idx: number,
  opts: ApplyOptions & { variantOf?: string; variantLabel?: string },
): Promise<RunRecord | null> {
  const { cfg, root, annotations } = ctx;
  const suffix = opts.variantLabel ? `-${opts.variantLabel.toLowerCase()}` : '';
  const branch = `${cfg.branchPrefix}${slug(p.title)}-${(opts.variantOf ?? p.id).split('_').pop()}${suffix}`;
  const wt = join(root, WORK_DIR, 'worktrees', branch.replace(/[\/]/g, '__'));

  // 1. isolated worktree from base
  if (existsSync(wt)) await git(['worktree', 'remove', '--force', wt]).catch(() => rmSync(wt, { recursive: true, force: true }));
  await git(['branch', '-D', branch]).catch(() => {});
  await git(['worktree', 'add', '-b', branch, wt, cfg.baseBranch]);
  linkNodeModules(root, wt);
  console.log(pc.dim(`  worktree ${relative(root, wt)} on ${branch}`));

  // 2. implement with the agent
  // Guidance comes from the worktree, i.e. what's committed on the base branch.
  const guidance = readProjectGuidance(wt, cfg.projectGuidance);
  const policy = effectivePolicy(cfg.agent, cfg.designSystem);
  const usingDs = !!cfg.designSystem;
  console.log(
    pc.dim(`  implementing with ${cfg.models.apply}…`) +
      pc.dim([usingDs ? ' design system' : '', guidance.files.length ? ` guidance: ${guidance.files.join(', ')}` : ''].filter(Boolean).join(' ·')),
  );
  const agent = await (opts.implement ?? implementProposal)(p, annotations, {
    cwd: wt,
    model: cfg.models.apply,
    sourceHints: cfg.sourceHints,
    agentNotes: cfg.agentNotes,
    designSystem: cfg.designSystem,
    projectGuidance: guidance.files.length ? guidance : undefined,
    policy,
    readRoots: [join(root, 'node_modules')],
    onProgress: (l) => console.log(pc.dim(`    ${l}`)),
  });
  // Count the spend now: a run that is later discarded or makes no edits still cost money.
  ctx.spent += agent.costUsd ?? 0;
  const changed = await git(['status', '--porcelain'], wt);
  // Defence in depth: whatever the agent did, a change that touches protected files never becomes a PR.
  const touched = changed.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop()!);
  const violations = auditChangedFiles(touched, policy);
  if (violations.length) {
    console.log(pc.red(`  ✖ change discarded — it touched protected files:\n${violations.map((v) => `    - ${v}`).join('\n')}`));
    await git(['worktree', 'remove', '--force', wt]);
    await git(['branch', '-D', branch]).catch(() => {});
    return null;
  }
  if (!agent.ok || !changed) {
    console.log(pc.red(`  ✖ no changes produced (${agent.ok ? 'agent made no edits' : agent.summary})`));
    await git(['worktree', 'remove', '--force', wt]);
    await git(['branch', '-D', branch]).catch(() => {});
    return null;
  }
  await git(['add', '-A'], wt);
  await git(['commit', '-q', '-m', `${p.title}\n\n${p.summary}\n\npeanut-gallery proposal ${p.id}; refs ${p.issueNumbers.map((n) => '#' + n).join(', ')}`], wt);
  console.log(pc.green(`  ✔ implemented`) + pc.dim(agent.costUsd ? ` ($${agent.costUsd.toFixed(2)}, ${agent.turns} turns)` : ''));

  // 2b. your checks (drift checker, linter, a11y…) on the committed change
  let checkResults: CheckResult[] = [];
  const undefinedSetting = cfg.builtinChecks?.undefinedClasses ?? true;
  if (undefinedSetting) {
    const r = await undefinedClassesCheck(wt, cfg.baseBranch, { required: undefinedSetting === 'required' });
    if (r) checkResults.push(r);
  }
  if (cfg.checks?.length) checkResults.push(...(await runChecks(cfg.checks, wt, { changedFiles: touched, base: cfg.baseBranch, proposalId: p.id })));
  if (checkResults.length) {
    for (const r of checkResults) {
      const line = `  ${r.ok ? '✔' : r.required ? '✖' : '⚠'} check: ${r.name}${r.ok ? '' : r.timedOut ? ' (timed out)' : ` (exit ${r.exitCode ?? '?'})`}`;
      console.log(r.ok ? pc.green(line) : r.required ? pc.red(line) : pc.yellow(line));
    }
  }
  const requiredFailed = checkResults.filter((r) => r.required && !r.ok);

  const record: RunRecord = {
    proposalId: p.id,
    title: p.title,
    branch,
    screenshots: [],
    issueCommentIds: [],
    status: 'applied',
    agentSummary: agent.summary,
    costUsd: agent.costUsd,
    effort: p.effort,
    model: cfg.models.apply,
    createdAt: new Date().toISOString(),
    variantOf: opts.variantOf,
    variantLabel: opts.variantLabel,
    checks: checkResults.length ? checkResults.map((r) => ({ name: r.name, ok: r.ok, required: r.required })) : undefined,
  };

  // 3. before/after screenshots
  const outDir = join(wt, WORK_DIR, 'compare', p.id);
  const prototypeUrl = ctx.issues.find((i) => i.session.annotations.some((a) => p.annotationIds.includes(a.id)))?.session.prototypeUrl;
  const targets = shotTargets(p, annotations, prototypeUrl);
  /** Capture before/after, build compare.html + summary.png, and commit them on the branch. */
  const shoot = async (beforeUrl: string, afterUrl: string, afterHeaders?: Record<string, string>): Promise<string> => {
    const shot = { ...cfg.screenshot, outlineColor: cfg.resolvedTheme.accent };
    const b = await captureShots(beforeUrl, targets, outDir, { ...shot, prefix: 'before' });
    const a = await captureShots(afterUrl, targets, outDir, { ...shot, prefix: 'after', headers: afterHeaders });
    const pairs: ComparePair[] = targets.map((t, i) => ({
      label: shotLabel(t, b[i], a[i]),
      before: relative(outDir, b[i].file),
      after: relative(outDir, a[i].file),
    }));
    writeFileSync(join(outDir, 'compare.html'), renderComparePage(p, pairs, { repo: cfg.repo, issueNumbers: p.issueNumbers }, cfg.resolvedTheme));
    writeFileSync(join(outDir, 'summary.html'), renderSummaryPage(p, pairs, cfg.resolvedTheme));
    await renderHtmlToPng(join(outDir, 'summary.html'), join(outDir, 'summary.png'));
    record.screenshots = pairs.map((x) => ({ label: x.label, before: x.before, after: x.after }));
    record.targetLabels = targets.map((t) => t.label);
    record.comparePath = relative(wt, join(outDir, 'compare.html'));
    // keep a local copy so `compare` and `variants` can work without checking out the branch
    const local = workPath('compare', p.id);
    rmSync(local, { recursive: true, force: true });
    cpSync(outDir, local, { recursive: true });
    record.localCompareDir = relative(root, local);
    await git(['add', '-f', join(WORK_DIR, 'compare', p.id)], wt);
    await git(['commit', '-q', '-m', `peanut-gallery: before/after for ${p.id}`], wt);
    console.log(pc.green(`  ✔ before/after`) + pc.dim(` ${record.comparePath}`));
    return relative(wt, join(outDir, 'summary.png'));
  };
  /** Before from the base branch (or prototypeUrl), after from a dev server in this worktree. */
  const shootLocally = async (): Promise<string | undefined> => {
    try {
      if (!ctx.before) ctx.before = await resolveBeforeServer(cfg, root, ctx.basePort);
      const after = await startDevServer(cfg.dev!, wt, ctx.basePort + 1 + idx, (s) => console.log(pc.dim(`  ${s}`)));
      try {
        return await shoot(ctx.before.url, after.url);
      } finally {
        await after.stop();
      }
    } catch (err) {
      console.log(pc.yellow(`  ⚠ screenshots skipped: ${(err as Error).message.split('\n')[0]}`));
      return undefined;
    }
  };
  const usePreview = previewEnabled(cfg.preview) && opts.pr !== false && opts.screenshots !== false;
  let summaryRel: string | undefined;
  if (opts.screenshots !== false && !usePreview) summaryRel = await shootLocally();

  // 4. push + PR + comment back
  if (opts.pr !== false) {
    await git(['push', '-u', 'origin', branch, '--force'], wt);
    const bodyWith = (img: string, note = '') => [
      `${img}${note ? `${note}\n\n` : ''}## ${p.title}`,
      `**${supportLine(p)}**`,
      '',
      p.summary,
      p.contested ? `\n> ⚑ This change was contested — ${p.contested.reason} Applied position ${p.contested.recommended}: ${p.contested.positions[p.contested.recommended].summary}` : '',
      opts.variantOf ? `\n> Option **${opts.variantLabel}** of a \`peanut-gallery variants\` round for proposal \`${opts.variantOf}\`. See the combined comparison on the issue.` : '',
      '',
      '### What changed',
      agent.summary,
      agent.denied.length ? `\n<details><summary>${agent.denied.length} tool call(s) blocked by policy</summary>\n\n${agent.denied.map((d) => `- ${d}`).join('\n')}\n</details>` : '',
      usingDs || guidance.files.length
        ? `\n<sub>Built with ${[usingDs ? 'the configured design system' : '', guidance.files.length ? `guidance from ${guidance.files.join(', ')}` : ''].filter(Boolean).join(' and ')}.</sub>`
        : '',
      '',
      requiredFailed.length ? `> ❌ Opened as a draft: required check${requiredFailed.length > 1 ? 's' : ''} failed (${requiredFailed.map((r) => r.name).join(', ')}).\n` : '',
      checksMarkdown(checkResults),
      '### Reviewer feedback addressed',
      ...annotations.filter((a) => p.annotationIds.includes(a.id)).map((a) => `- #${a.issueNumber}: “${a.text.split('\n')[0]}” _(${a.reviewer})_`),
      '',
      record.comparePath ? `Interactive comparison (slider / toggle): \`${record.comparePath}\` on this branch — \`npx peanut-gallery compare ${p.id}\`` : '',
      record.previewUrl ? `After screenshots from the preview deployment: ${record.previewUrl}` : '',
      '',
      `Refs ${p.issueNumbers.map((n) => '#' + n).join(', ')}`,
      '',
      `<sub>Generated by peanut-gallery · proposal \`${p.id}\` · effort ${p.effort} · confidence ${(p.confidence * 100).toFixed(0)}%</sub>`,
    ].join('\n');
    const imgFor = (rel?: string) => (rel ? `![before / after](${blobImageUrl(cfg.repo, branch, rel)})\n\n` : '');
    const title = opts.variantLabel ? `${p.title} (option ${opts.variantLabel})` : p.title;
    const draft = opts.draft || requiredFailed.length > 0;
    let pr: { url: string; number: number };
    if (!usePreview) {
      pr = await createPr({ repo: cfg.repo, head: branch, base: cfg.baseBranch, title, body: bodyWith(imgFor(summaryRel)), cwd: wt, draft });
      console.log(pc.green(`  ✔ PR ${pr.url}`));
    } else {
      // Many hosts only build a preview once there's a pull request, so open it first.
      pr = await createPr({ repo: cfg.repo, head: branch, base: cfg.baseBranch, title, body: bodyWith('', '> ⏳ Before/after screenshots will appear here once the preview deployment is ready.'), cwd: wt, draft });
      console.log(pc.green(`  ✔ PR ${pr.url}`));
      const pv = normalizePreview(cfg.preview);
      const { headers, missing } = expandHeaders(pv.headers);
      if (missing.length) console.log(pc.yellow(`  ⚠ preview headers skipped: ${missing.join(', ')} not set in the environment`));
      const sha = (await git(['rev-parse', 'HEAD'], wt)).trim();
      const found = await waitForPreview({ repo: cfg.repo, sha, branch, pr: pr.number, preview: pv, headers, log: (m) => console.log(pc.dim(`  ${m}`)) });
      let note = '';
      if ('url' in found) {
        console.log(pc.green(`  ✔ preview ready`) + pc.dim(` ${found.url} (${found.source})`));
        record.previewUrl = found.url;
        try {
          let beforeUrl: string | null = null;
          if (pv.before !== 'local') {
            beforeUrl = cfg.prototypeUrl ?? (await productionUrl(cfg.repo, (await git(['rev-parse', cfg.baseBranch])).trim()));
          }
          if (!beforeUrl) {
            if (!ctx.before) ctx.before = await resolveBeforeServer(cfg, root, ctx.basePort);
            beforeUrl = ctx.before.url;
          }
          summaryRel = await shoot(beforeUrl, found.url, headers);
        } catch (err) {
          console.log(pc.yellow(`  ⚠ screenshots from the preview failed: ${(err as Error).message.split('\n')[0]}`));
        }
      } else {
        console.log(pc.yellow(`  ⚠ ${found.error}`));
        if (cfg.dev) {
          console.log(pc.dim('  taking screenshots from a local dev server instead'));
          summaryRel = await shootLocally();
        }
      }
      if (summaryRel) {
        await git(['push', 'origin', branch], wt);
      } else {
        note = `> ⚠ No before/after screenshots: ${'error' in found ? found.error : 'capturing them failed'}.`;
      }
      await updatePrBody(cfg.repo, pr.number, bodyWith(imgFor(summaryRel), note), wt).catch((err) => console.log(pc.yellow(`  ⚠ couldn't update the PR description: ${(err as Error).message.split('\n')[0]}`)));
    }
    const img = imgFor(summaryRel);
    record.prUrl = pr.url;
    record.prNumber = pr.number;
    record.status = 'pr-opened';

    if (opts.comment !== false) {
      for (const n of p.issueNumbers) {
        const c = await commentOnIssue(
          cfg.repo,
          n,
          [
            `### Proposed update: ${p.title}`,
            `_${supportLine(p)}_`,
            '',
            p.summary,
            '',
            img,
            `Pull request: ${pr.url}`,
            '',
            '**Which do you prefer?** React 👍 on this comment for **After**, 👎 to keep **Before**, or reply with more feedback (e.g. “after, but keep the old colour”).',
            '',
            `<sub>peanut-gallery proposal \`${p.id}\`</sub>`,
          ].join('\n'),
        );
        record.issueCommentIds.push({ issue: n, commentId: c.id, url: c.url });
        await addLabels(cfg.repo, n, [cfg.labels?.proposal ?? LABELS.proposal]).catch(() => {});
      }
      console.log(pc.green(`  ✔ posted comparison to ${p.issueNumbers.map((n) => '#' + n).join(', ')}`));
    }
  }

  // 5. tidy: keep the branch, drop the worktree
  await git(['worktree', 'remove', '--force', wt]).catch(() => {});
  ctx.runs.push(record);
  writeJson(workPath('runs.json'), ctx.runs);
  return record;
}

async function resolveBeforeServer(cfg: ResolvedConfig, root: string, port: number): Promise<RunningServer> {
  if (cfg.prototypeUrl) return { url: cfg.prototypeUrl, stop: async () => {} };
  if (!cfg.dev) throw new Error('Set prototypeUrl or dev.command in peanut-gallery.config.json for "before" screenshots');
  const wt = join(root, WORK_DIR, 'worktrees', '__base');
  if (existsSync(wt)) await git(['worktree', 'remove', '--force', wt]).catch(() => {});
  await git(['worktree', 'add', '--detach', wt, cfg.baseBranch]);
  linkNodeModules(root, wt);
  const s = await startDevServer(cfg.dev, wt, port);
  return {
    url: s.url,
    stop: async () => {
      await s.stop();
      await git(['worktree', 'remove', '--force', wt]).catch(() => {});
    },
  };
}

function linkNodeModules(root: string, wt: string) {
  const src = join(root, 'node_modules');
  const dst = join(wt, 'node_modules');
  if (existsSync(src) && !existsSync(dst)) {
    try {
      symlinkSync(src, dst, 'junction');
    } catch {
      /* fall back to the project's own install step */
    }
  }
  mkdirSync(join(wt, WORK_DIR), { recursive: true });
}

function shotTargets(p: Proposal, annotations: FlatAnnotation[], prototypeUrl?: string): ShotTarget[] {
  const targets: ShotTarget[] = [];
  const anns = annotations.filter((a) => p.annotationIds.includes(a.id));
  p.focusAnchors.forEach((anchor, i) => {
    const a = anns.find((x) => x.anchor.selector === anchor.selector) ?? anns[0];
    targets.push({
      key: `el${i + 1}`,
      label: `${anchor.tag}${anchor.textFingerprint ? ` “${anchor.textFingerprint.slice(0, 40)}”` : ''} · ${pathOf(a?.pageUrl ?? p.pages[0] ?? '/', prototypeUrl)}`,
      pagePath: pathOf(a?.pageUrl ?? p.pages[0] ?? '/', prototypeUrl),
      anchor,
      ...(a?.steps?.length && a.anchor.selector === anchor.selector ? { steps: a.steps } : {}),
    });
  });
  p.pages.forEach((page, i) => targets.push({ key: `page${i + 1}`, label: `Page ${pathOf(page, prototypeUrl)}`, pagePath: pathOf(page, prototypeUrl) }));
  return targets.slice(0, 8);
}

/** Label for a before/after pair, saying how the element was reached (or why it's a full page). */
export function shotLabel(t: ShotTarget, before: ShotResult, after: ShotResult): string {
  if (!t.anchor) return t.label;
  if (before.found === false && after.found === false) {
    return t.steps?.length
      ? `${t.label} — full page: couldn't reach this element, even after replaying the reviewer's clicks`
      : `${t.label} — full page: this element isn't on the page when it first loads (e.g. it's inside a modal)`;
  }
  const clicks = after.replayed?.length ? after.replayed : before.replayed;
  return clicks?.length ? `${t.label} — after clicking ${clicks.join(' → ')}` : t.label;
}

export function supportLine(p: Proposal): string {
  const who = p.support.reviewers;
  if (!who.length) return `${p.support.annotationCount} comment(s)`;
  if (who.length === 1) return `requested by ${who[0]} (${p.support.annotationCount} comment${p.support.annotationCount === 1 ? '' : 's'})`;
  return `${who.length} reviewers agree — ${who.join(', ')} (${p.support.annotationCount} comments)`;
}

export function decisionComment(p: Proposal): string {
  const c = p.contested!;
  return [
    `### ⚑ Decision needed: ${p.title}`,
    `Reviewers disagree — ${c.reason}`,
    '',
    ...c.positions.map((pos, n) => `**Option ${n}** ${n === c.recommended ? '_(recommended)_' : ''}\n${pos.summary}\n<sub>${pos.reviewers.length ? pos.reviewers.join(', ') : 'no reviewer'}</sub>\n`),
    `Reply with the option number you'd like built (e.g. "option ${c.recommended}"), or react on this comment: ${c.positions.map((_, n) => `${['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣'][n] ?? n} = option ${n}`).join(', ')}.`,
    `The maintainer then runs \`peanut-gallery decide ${p.id} <n>\` and the before/after follows.`,
    '',
    `<sub>peanut-gallery proposal \`${p.id}\`</sub>`,
  ].join('\n');
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/['"’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

import type Anthropic from '@anthropic-ai/sdk';
import { completeJson, hasCredentials, authHint } from '../llm.js';
import { designSystemSummary } from '../design.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import pc from 'picocolors';
import type { Proposal } from '@peanut-gallery/core';
import { readJson, workPath, writeJson } from '../config.js';
import { commentOnIssue, publishAssets } from '../github.js';
import { renderOptionsPage, type OptionColumn } from '../compare.js';
import { renderHtmlToPng } from '../screenshots.js';
import { createRunContext, runProposal, supportLine, withinBudget, type ApplyOptions, type RunRecord } from './apply.js';

export interface VariantsOptions extends ApplyOptions {
  count?: number; // 1..3
  /** Builder's steer, e.g. "the first attempt was too heavy; try something lighter and one bolder". */
  note?: string;
  /** Skip generation and use these as the option specs (for tests / hand-written options). */
  directions?: VariantDirection[];
  client?: Anthropic;
}

export interface VariantDirection {
  label: string; // A, B, C
  title: string;
  summary: string;
  instructions: string;
}

const LETTERS = ['A', 'B', 'C', 'D', 'E'];

/**
 * Generate 1–3 distinct alternative implementations of a proposal, build each on its own
 * branch, and post one combined before / A / B / C comparison back to the source issues.
 */
export async function variantsCommand(id: string, opts: VariantsOptions = {}): Promise<RunRecord[]> {
  const count = Math.min(3, Math.max(1, opts.count ?? 2));
  const proposals = readJson<Proposal[]>(workPath('proposals.json'), []);
  const p = proposals.find((x) => x.id === id || x.id.endsWith(id));
  if (!p) throw new Error(`No proposal ${id} in .peanut-gallery/proposals.json`);
  if (!opts.directions && !(await hasCredentials())) throw new Error(authHint());

  const ctx = await createRunContext(opts);
  const previous = ctx.runs.filter((r) => r.proposalId === p.id || r.variantOf === p.id);
  const round = previous.filter((r) => r.variantOf === p.id).length ? Math.max(...previous.filter((r) => r.variantOf === p.id).map((r) => Number(r.variantLabel?.match(/\d+$/)?.[0] ?? 1))) + 1 : 1;

  console.log(pc.bold(`\n━━ ${p.title} ${pc.dim(`[${p.id}] ${supportLine(p)}`)}`));
  console.log(pc.dim(`  generating ${count} option(s)${opts.note ? ` — note: "${opts.note}"` : ''}…`));
  const directions = opts.directions ?? (await generateDirections(p, previous, count, { model: ctx.cfg.models.interpret, note: opts.note, agentNotes: ctx.cfg.agentNotes, designNotes: designSystemSummary(ctx.cfg.designSystem), client: opts.client }));
  directions.forEach((d, i) => (d.label = `${LETTERS[i]}${round > 1 ? round : ''}`));
  directions.forEach((d) => console.log(`  ${pc.bold(d.label)}  ${d.title} ${pc.dim(`— ${d.summary}`)}`));

  const results: RunRecord[] = [];
  try {
    for (const [i, d] of directions.entries()) {
      console.log(pc.bold(`\n── option ${d.label}: ${d.title}`));
      if (!withinBudget(ctx, p.effort, opts.budget)) break;
      const variant: Proposal = { ...p, id: `${p.id}_${d.label.toLowerCase()}`, title: `${p.title} — ${d.title}`, summary: d.summary, instructions: d.instructions, contested: undefined };
      const rec = await runProposal(ctx, variant, i, { ...opts, comment: false, variantOf: p.id, variantLabel: d.label });
      if (rec) results.push(rec);
    }
  } finally {
    await ctx.before?.stop();
  }
  if (!results.length) {
    console.log(pc.red('No option produced changes.'));
    return results;
  }

  // Combined before / A / B / C page from the local compare copies.
  const withShots = results.filter((r) => r.localCompareDir && r.screenshots.length);
  if (withShots.length) {
    const outDir = workPath('compare', `${p.id}_options${round > 1 ? round : ''}`);
    mkdirSync(outDir, { recursive: true });
    const first = withShots[0];
    const targets = first.targetLabels ?? first.screenshots.map((s) => s.label);
    const before = first.screenshots.map((s) => relative(outDir, join(ctx.root, first.localCompareDir!, s.before)));
    const columns: OptionColumn[] = withShots.map((r) => {
      const d = directions.find((x) => x.label === r.variantLabel)!;
      return { label: r.variantLabel!, title: d.title, summary: d.summary, prUrl: r.prUrl, images: r.screenshots.map((s) => relative(outDir, join(ctx.root, r.localCompareDir!, s.after))) };
    });
    writeFileSync(join(outDir, 'options.html'), renderOptionsPage(p, targets, before, columns, { theme: ctx.cfg.resolvedTheme }));
    writeFileSync(join(outDir, 'options-summary.html'), renderOptionsPage(p, targets, before, columns, { compact: true, theme: ctx.cfg.resolvedTheme }));
    await renderHtmlToPng(join(outDir, 'options-summary.html'), join(outDir, 'options.png'), Math.min(1600, 360 * (1 + columns.length) + 48));
    console.log(pc.green(`  ✔ combined comparison`) + pc.dim(` ${relative(ctx.root, join(outDir, 'options.html'))}`));

    if (opts.pr !== false && opts.comment !== false) {
      const urls = await publishAssets({ repo: ctx.cfg.repo, root: ctx.root, relDir: `${p.id}/options${round > 1 ? round : ''}`, files: [{ name: 'options.png', path: join(outDir, 'options.png') }] });
      const body = [
        `### ${results.length} option${results.length === 1 ? '' : 's'} for: ${p.title}`,
        `_${supportLine(p)}${opts.note ? ` · builder's note: “${opts.note}”` : ''}_`,
        '',
        `![before / options](${urls['options.png']})`,
        '',
        ...results.map((r) => `**${r.variantLabel}** — ${directions.find((d) => d.label === r.variantLabel)?.title}${r.prUrl ? ` · ${r.prUrl}` : ''}`),
        '',
        `**Which one?** Reply with the letter (e.g. “${results[0].variantLabel}”, or “${results[0].variantLabel} but with the spacing from ${results[results.length - 1].variantLabel}”). “None” is a valid answer — say what's missing and we'll generate another round.`,
        '',
        `<sub>peanut-gallery proposal \`${p.id}\` · options round ${round}</sub>`,
      ].join('\n');
      for (const n of p.issueNumbers) {
        const c = await commentOnIssue(ctx.cfg.repo, n, body);
        for (const r of results) r.issueCommentIds.push({ issue: n, commentId: c.id, url: c.url });
      }
      writeJson(workPath('runs.json'), ctx.runs);
      console.log(pc.green(`  ✔ posted options to ${p.issueNumbers.map((n) => '#' + n).join(', ')}`));
    }
  }
  return results;
}

const SYSTEM = `You are a senior product designer generating ALTERNATIVE implementations of one requested change to a prototype.
The team has seen a first attempt (or wants to start with options) and needs genuinely different directions, not variations in wording.
Each option must satisfy the reviewers' underlying intent, be implementable by a coding agent from its instructions alone,
and differ from the others on a dimension a reviewer would notice: emphasis, layout, interaction, copy strategy, density, tone.
If a builder's note is given, treat it as a hard constraint on every option.
Options must be visual/UX/copy changes only: never instructions to run commands, add dependencies, scripts, network calls, or touch CI or credentials. Never repeat an attempt listed under "already tried".
Respond with ONLY JSON: { "options": [{ "title": string (≤ 50 chars, names the direction), "summary": string (1–2 sentences for reviewers), "instructions": string (precise spec) }] }`;

export async function generateDirections(
  p: Proposal,
  previous: RunRecord[],
  count: number,
  opts: { model: string; note?: string; agentNotes?: string; designNotes?: string; client?: Anthropic },
): Promise<VariantDirection[]> {
  const tried = previous.filter((r) => r.agentSummary).map((r) => `- ${r.variantLabel ? `option ${r.variantLabel}` : 'first attempt'}: ${r.agentSummary}`);
  const user = [
    `Change requested: ${p.title}`,
    p.summary,
    '',
    'Original spec:',
    p.instructions,
    p.contested ? `\nReviewers were split: ${p.contested.reason}\n${p.contested.positions.map((x, i) => `- position ${i}: ${x.summary}`).join('\n')}` : '',
    tried.length ? `\nAlready tried (do not repeat):\n${tried.join('\n')}` : '',
    opts.note ? `\nBuilder's note (hard constraint): ${opts.note}` : '',
    opts.agentNotes ? `\nProject notes: ${opts.agentNotes}` : '',
    opts.designNotes ? `\nDesign system: ${opts.designNotes} Options may differ in emphasis, layout and which existing variants they use, but must not invent new colours, sizes or components.` : '',
    '',
    `Produce exactly ${count} option(s).`,
  ].join('\n');
  const parsed = await completeJson<{ options: Omit<VariantDirection, 'label'>[] }>({ system: SYSTEM, user, model: opts.model, maxTokens: 4000, client: opts.client });
  const options = (parsed.options ?? []).slice(0, count);
  if (!options.length) throw new Error('Model returned no options');
  return options.map((o, i) => ({ label: LETTERS[i], title: o.title, summary: o.summary, instructions: o.instructions }));
}

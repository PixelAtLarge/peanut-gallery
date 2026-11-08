import pc from 'picocolors';
import type { Proposal } from '@pixelatlarge/peanut-gallery-core';
import { loadConfig, readJson, workPath, writeJson } from '../config.js';
import type { FeedbackIssue } from '../github.js';
import { flatten, interpret } from '../interpret.js';
import { authHint, hasCredentials } from '../llm.js';
import { designSystemSummary } from '../design.js';

export async function interpretCommand(opts: { issues?: FeedbackIssue[]; quiet?: boolean } = {}): Promise<Proposal[]> {
  const cfg = loadConfig();
  const issues = opts.issues ?? readJson<FeedbackIssue[]>(workPath('feedback.json'), []);
  if (!issues.length) {
    console.log(pc.yellow('No feedback to interpret. Run `peanut-gallery pull` first (or there are no open feedback issues).'));
    return [];
  }
  if (!(await hasCredentials())) throw new Error(authHint());
  const flat = flatten(issues);
  if (!opts.quiet) console.log(pc.dim(`interpreting ${flat.length} comment(s) with ${cfg.models.interpret}…`));
  const { proposals, skipped } = await interpret(flat, { model: cfg.models.interpret, agentNotes: cfg.agentNotes, designNotes: designSystemSummary(cfg.designSystem) });
  writeJson(workPath('proposals.json'), proposals);
  if (!opts.quiet) printProposals(proposals, skipped, flat.length);
  return proposals;
}

export function printProposals(proposals: Proposal[], skipped: { annotationId: string; reason: string }[], total: number) {
  console.log(pc.bold(`\n${proposals.length} proposal(s) from ${total} comment(s)`) + pc.dim(' → .peanut-gallery/proposals.json'));
  proposals.forEach((p, i) => {
    const flag = p.contested ? pc.yellow(' CONTESTED') : p.support.count > 1 ? pc.green(` ×${p.support.count} reviewers`) : '';
    console.log(`\n${pc.cyan(`${i + 1}. ${p.title}`)}${flag} ${pc.dim(`[${p.id}] ${p.effort} · ${(p.confidence * 100).toFixed(0)}% · issues ${p.issueNumbers.map((n) => '#' + n).join(', ')} · ${p.support.reviewers.join(', ')}`)}`);
    console.log(`   ${p.summary}`);
    if (p.contested) {
      console.log(pc.yellow(`   ⚑ ${p.contested.reason}`));
      p.contested.positions.forEach((pos, n) => {
        const rec = n === p.contested!.recommended ? pc.dim(' (recommended)') : '';
        console.log(`     ${pc.bold(String(n))}. ${pos.summary}${rec} ${pc.dim(`— ${pos.reviewers.join(', ') || 'no reviewer'}`)}`);
      });
      console.log(pc.dim(`     resolve with: peanut-gallery decide ${p.id} <n>   (or apply --include-contested for the recommendation)`));
    }
  });
  if (skipped.length) {
    console.log(pc.dim(`\nskipped ${skipped.length}:`));
    for (const s of skipped) console.log(pc.dim(`  - ${s.annotationId}: ${s.reason}`));
  }
}

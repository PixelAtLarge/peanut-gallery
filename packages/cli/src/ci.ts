import { appendFileSync } from 'node:fs';

/** True inside GitHub Actions. */
export const inActions = () => process.env.GITHUB_ACTIONS === 'true';

/** Append markdown to the GitHub Actions job summary (no-op elsewhere). */
export function jobSummary(markdown: string) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    appendFileSync(file, markdown.endsWith('\n') ? markdown : markdown + '\n');
  } catch {
    /* the summary is a nicety */
  }
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function applySummaryMarkdown(rows: { title: string; prUrl?: string; issues: number[]; status: string; costUsd?: number }[], spent: number, budget?: number): string {
  if (!rows.length) return '### 🥜 Peanut Gallery\n\nNo changes were made this run.\n';
  return [
    '### 🥜 Peanut Gallery',
    '',
    '| Change | Pull request | From | Cost |',
    '| --- | --- | --- | --- |',
    ...rows.map((r) => `| ${cell(r.title)} | ${r.prUrl ? `[#${r.prUrl.split('/').pop()}](${r.prUrl})` : r.status} | ${r.issues.map((n) => `#${n}`).join(', ')} | ${r.costUsd ? `$${r.costUsd.toFixed(2)}` : '—'} |`),
    '',
    `Agent spend: $${spent.toFixed(2)}${budget ? ` of $${budget.toFixed(2)}` : ''}`,
    '',
  ].join('\n');
}

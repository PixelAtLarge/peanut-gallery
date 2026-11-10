import type Anthropic from '@anthropic-ai/sdk';
import { git } from './github.js';
import { completeText, extractJson } from './llm.js';
import type { CheckResult } from './checks.js';

export type FindingKind = 'not-in-code' | 'not-described' | 'request-missed';

/** One way the PR description and the code disagree. */
export interface DescriptionFinding {
  kind: FindingKind;
  /** In a sentence, naming the file where it helps. */
  detail: string;
}

export interface DescriptionInput {
  title: string;
  /** What the proposal set out to do (the PR's lead paragraph). */
  plan: string;
  /** The agent's "What changed" summary. */
  summary: string;
  /** The reviewer notes the PR says it addresses. */
  requests: string[];
  model: string;
  client?: Anthropic;
  required?: boolean;
}

/** Diffs larger than this are cut, and Claude is told so (it won't flag what it couldn't see). */
const DIFF_CAP = 60_000;
/** Generated or noisy files that say nothing about what the change does. */
const SKIP = [':(exclude).peanut-gallery', ':(exclude)*package-lock.json', ':(exclude)*pnpm-lock.yaml', ':(exclude)*yarn.lock', ':(exclude)*.min.*', ':(exclude)*.map'];

const LABEL: Record<FindingKind, string> = {
  'not-in-code': "Described, but not in the code",
  'not-described': "In the code, but not described",
  'request-missed': 'Reviewer request not addressed',
};

const SYSTEM = `You check a pull request's description against its diff, so reviewers can trust what the description says. The PR was written by a coding agent from reviewer feedback on a UI.

Report only real disagreements:
- "not-in-code": something the description or plan says was done that the diff doesn't do (or does differently, e.g. a different colour, text, or file).
- "not-described": a change in the diff that matters to someone reviewing the UI or the code and isn't mentioned (new behaviour, removed content, a different component or page touched, a style change elsewhere). Ignore formatting, imports, renames that follow from a described change, and small supporting edits.
- "request-missed": a reviewer request the PR says it addresses that the diff doesn't address.

Each detail is one plain sentence (at most 25 words), naming the file where it helps. If the diff was cut short, don't report "not-in-code" for things that could be in the part you didn't see. If everything matches, return no findings.

Reply with JSON only: {"findings":[{"kind":"not-in-code"|"not-described"|"request-missed","detail":"..."}]}`;

/** The change's diff against the base branch, without lockfiles and our own artifacts. */
export async function changeDiff(dir: string, base: string): Promise<{ diff: string; files: string[]; cut: boolean }> {
  const files = (await git(['diff', '--name-only', `${base}...HEAD`, '--', '.', ...SKIP], dir)).split('\n').filter(Boolean);
  let diff = await git(['diff', '-U3', '--no-color', `${base}...HEAD`, '--', '.', ...SKIP], dir);
  const cut = diff.length > DIFF_CAP;
  if (cut) diff = diff.slice(0, DIFF_CAP);
  return { diff, files, cut };
}

/** Ask Claude where the description and the diff disagree. Throws if Claude can't be reached. */
export async function findMismatches(input: DescriptionInput, change: { diff: string; files: string[]; cut: boolean }): Promise<DescriptionFinding[]> {
  const user = [
    `## Title\n${input.title}`,
    `## Plan (what the PR set out to do)\n${input.plan}`,
    `## Description ("What changed", written by the agent)\n${input.summary || '(none)'}`,
    input.requests.length ? `## Reviewer requests it says it addresses\n${input.requests.map((r) => `- ${r}`).join('\n')}` : '',
    `## Files changed\n${change.files.join('\n')}`,
    `## Diff${change.cut ? ' (cut short: only the first part is shown)' : ''}\n\`\`\`diff\n${change.diff}\n\`\`\``,
  ]
    .filter(Boolean)
    .join('\n\n');
  const text = await completeText({ system: SYSTEM, user, model: input.model, maxTokens: 1500, client: input.client });
  const parsed = extractJson(text) as { findings?: Array<{ kind?: string; detail?: string }> } | null;
  return (parsed?.findings ?? [])
    .filter((f): f is DescriptionFinding => typeof f.detail === 'string' && !!f.detail.trim() && (f.kind === 'not-in-code' || f.kind === 'not-described' || f.kind === 'request-missed'))
    .map((f) => ({ kind: f.kind, detail: f.detail.trim().slice(0, 300) }))
    .slice(0, 10);
}

/** Markdown for the findings, grouped by kind. */
export function findingsMarkdown(findings: DescriptionFinding[]): string {
  return (Object.keys(LABEL) as FindingKind[])
    .map((k) => {
      const list = findings.filter((f) => f.kind === k);
      return list.length ? `**${LABEL[k]}**\n${list.map((f) => `- ${f.detail}`).join('\n')}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Built-in check: does the PR description match the code? A second, cheap Claude pass reads the
 * diff next to the plan, the agent's summary and the reviewer requests. Null when there's no diff
 * or Claude can't be reached (the PR just goes without it).
 */
export async function descriptionCheck(dir: string, base: string, input: DescriptionInput): Promise<(CheckResult & { findings: DescriptionFinding[] }) | null> {
  const started = Date.now();
  let change: Awaited<ReturnType<typeof changeDiff>>;
  try {
    change = await changeDiff(dir, base);
  } catch {
    return null;
  }
  if (!change.diff.trim()) return null;
  let findings: DescriptionFinding[];
  try {
    findings = await findMismatches(input, change);
  } catch {
    return null;
  }
  const ok = findings.length === 0;
  return {
    name: 'Description matches the code',
    ok,
    required: !!input.required,
    exitCode: ok ? 0 : 1,
    timedOut: false,
    output: '',
    durationMs: Date.now() - started,
    status: ok ? `checked against the diff${change.cut ? ' (first part of a large diff)' : ''}` : `${findings.length} thing${findings.length > 1 ? 's' : ''} to look at`,
    detail: ok ? undefined : findingsMarkdown(findings),
    findings,
  };
}

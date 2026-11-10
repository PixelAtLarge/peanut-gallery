import { spawn } from 'node:child_process';

/**
 * A command run in the proposal's worktree after the agent's change is committed — e.g. a
 * design-system drift checker, a linter or an accessibility scan. Results go into the PR body.
 *
 * The command runs with:
 *   PEANUT_GALLERY_CHANGED_FILES  newline-separated repo-relative paths the change touched
 *   PEANUT_GALLERY_BASE           the base branch name
 *   PEANUT_GALLERY_PROPOSAL       the proposal id
 */
export interface CheckConfig {
  /** Shown in the PR, e.g. "Design-system drift". */
  name: string;
  /** Run with `sh -c` in the worktree. Written by you in the config; the agent can't edit it. */
  command: string;
  /** Default 120. */
  timeoutSec?: number;
  /** If this check fails, open the PR as a draft and say why. Default false (report only). */
  required?: boolean;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  required: boolean;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  durationMs: number;
  /** Replaces "passed" / "failed (exit 1)" in the PR. */
  status?: string;
  /** Markdown shown in the PR (not folded away), e.g. a built-in check's findings. */
  detail?: string;
}

const OUTPUT_CAP = 3000;

export function runCheck(check: CheckConfig, cwd: string, env: Record<string, string>): Promise<CheckResult> {
  const started = Date.now();
  const timeoutMs = (check.timeoutSec ?? 120) * 1000;
  return new Promise((resolve) => {
    // Own process group, so a timeout stops everything the command started, not just `sh`.
    const child = spawn('sh', ['-c', check.command], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        child.kill(sig);
      }
    };
    let out = '';
    const add = (d: Buffer) => {
      if (out.length < OUTPUT_CAP * 2) out += d.toString();
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 2000).unref();
      // Don't wait forever on a process that ignores signals.
      setTimeout(() => finish(null, '\n(stopped after timeout)'), 3000).unref();
    }, timeoutMs);
    const finish = (code: number | null, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let output = (out + extra).trim();
      if (output.length > OUTPUT_CAP) output = output.slice(0, OUTPUT_CAP) + '\n…(truncated)';
      resolve({ name: check.name, ok: code === 0 && !timedOut, required: !!check.required, exitCode: code, timedOut, output, durationMs: Date.now() - started });
    };
    child.on('error', (e) => finish(null, `\n${e.message}`));
    child.on('close', (code) => finish(code));
  });
}

export async function runChecks(checks: CheckConfig[] | undefined, cwd: string, ctx: { changedFiles: string[]; base: string; proposalId: string }): Promise<CheckResult[]> {
  const env = {
    PEANUT_GALLERY_CHANGED_FILES: ctx.changedFiles.join('\n'),
    PEANUT_GALLERY_BASE: ctx.base,
    PEANUT_GALLERY_PROPOSAL: ctx.proposalId,
  };
  const results: CheckResult[] = [];
  for (const c of checks ?? []) results.push(await runCheck(c, cwd, env));
  return results;
}

/** Markdown section for the PR body. */
export function checksMarkdown(results: CheckResult[]): string {
  if (!results.length) return '';
  const icon = (r: CheckResult) => (r.ok ? '✅' : r.required ? '❌' : '⚠️');
  const status = (r: CheckResult) => r.status ?? (r.ok ? 'passed' : r.timedOut ? 'timed out' : `failed (exit ${r.exitCode ?? '?'})`);
  return [
    '### Checks',
    ...results.map((r) => {
      const head = `${icon(r)} **${r.name}** — ${status(r)}`;
      if (r.detail) return `${head}\n\n${r.detail}\n`;
      if (r.ok && !r.output) return head;
      return `${head}\n<details><summary>output</summary>\n\n\`\`\`\n${r.output.replace(/```/g, "'''")}\n\`\`\`\n</details>`;
    }),
  ].join('\n');
}

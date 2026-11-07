import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * What the coding agent may do. Reviewer comments are untrusted input that reaches the agent's
 * prompt, so the default is deliberately narrow: read/search/edit source files inside the
 * worktree, nothing else. Everything beyond that is an explicit opt-in in peanut-gallery.config.json.
 */
export interface AgentPolicy {
  /**
   * Shell commands the agent may run, matched by prefix (e.g. "npm run lint", "npx prettier --write").
   * Empty (default) = no shell at all.
   */
  allowCommands?: string[];
  /** Allow edits to package.json / lockfiles (adding dependencies). Default false. */
  allowDependencyChanges?: boolean;
  /** Extra repo-relative paths/prefixes the agent must never write (on top of the built-ins). */
  protectedPaths?: string[];
}

export interface PolicyDecision {
  allow: boolean;
  reason?: string;
}

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** Never writable (and secrets never readable), regardless of config. */
const BUILTIN_PROTECTED = ['.git/', '.github/', '.peanut-gallery/', 'peanut-gallery.config.json', '.claude/', '.husky/', '.npmrc', '.yarnrc', '.yarnrc.yml'];
const SECRET_PATTERNS = [/(^|\/)\.env(\..*)?$/i, /(^|\/)\.netrc$/i, /\.pem$/i, /\.key$/i, /(^|\/)id_(rsa|ed25519)/i, /(^|\/)credentials(\.json)?$/i];
const DEPENDENCY_FILES = [/(^|\/)package\.json$/, /(^|\/)package-lock\.json$/, /(^|\/)npm-shrinkwrap\.json$/, /(^|\/)yarn\.lock$/, /(^|\/)pnpm-lock\.yaml$/, /(^|\/)bun\.lockb?$/];
/** Shell metacharacters that would let an allowed prefix chain into something else. */
const SHELL_CHAINING = /[;&|`$<>\n\\]|\$\(/;

function pathOf(input: Record<string, unknown>): string | undefined {
  const p = input.file_path ?? input.path ?? input.notebook_path;
  return typeof p === 'string' ? p : undefined;
}

/** Repo-relative POSIX path, or null if it escapes the worktree. */
export function insideWorktree(cwd: string, p: string): string | null {
  const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  const rel = relative(resolve(cwd), abs);
  if (rel === '' ) return '.';
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

export function isProtected(rel: string, policy: AgentPolicy): string | null {
  const relDir = rel.endsWith('/') ? rel : rel + '/';
  for (const pre of [...BUILTIN_PROTECTED, ...(policy.protectedPaths ?? [])]) {
    const p = pre.replace(/^\.\//, '');
    if (rel === p.replace(/\/$/, '') || relDir.startsWith(p.endsWith('/') ? p : p + '/') || rel.startsWith(p)) return `protected path (${pre})`;
  }
  if (SECRET_PATTERNS.some((re) => re.test(rel))) return 'secrets file';
  if (!policy.allowDependencyChanges && DEPENDENCY_FILES.some((re) => re.test(rel))) return 'dependency manifest (set agent.allowDependencyChanges to permit)';
  return null;
}

/** Decide whether one agent tool call may run. Pure, so it is unit-tested directly. */
export function evaluateToolUse(toolName: string, input: Record<string, unknown>, ctx: { cwd: string; policy: AgentPolicy }): PolicyDecision {
  const { cwd, policy } = ctx;

  if (READ_TOOLS.has(toolName)) {
    const p = pathOf(input);
    if (!p) return { allow: true };
    const rel = insideWorktree(cwd, p);
    if (rel === null) return { allow: false, reason: `read outside the worktree: ${p}` };
    if (SECRET_PATTERNS.some((re) => re.test(rel))) return { allow: false, reason: `secrets file: ${rel}` };
    return { allow: true };
  }

  if (WRITE_TOOLS.has(toolName)) {
    const p = pathOf(input);
    if (!p) return { allow: false, reason: 'write without a path' };
    const rel = insideWorktree(cwd, p);
    if (rel === null) return { allow: false, reason: `write outside the worktree: ${p}` };
    const prot = isProtected(rel, policy);
    if (prot) return { allow: false, reason: `${prot}: ${rel}` };
    return { allow: true };
  }

  if (toolName === 'Bash') {
    const cmd = String(input.command ?? '').trim();
    const allowed = policy.allowCommands ?? [];
    if (!allowed.length) return { allow: false, reason: 'shell commands are disabled (agent.allowCommands is empty)' };
    if (SHELL_CHAINING.test(cmd)) return { allow: false, reason: 'command chaining/redirection is not allowed' };
    if (allowed.some((a) => cmd === a || cmd.startsWith(a + ' '))) return { allow: true };
    return { allow: false, reason: `command not in agent.allowCommands: ${cmd}` };
  }

  // Everything else (network, sub-agents, MCP, todo/skill tools…) is off.
  return { allow: false, reason: `tool not permitted: ${toolName}` };
}

/** Post-run check over the files a change touched (defence in depth). */
export function auditChangedFiles(files: string[], policy: AgentPolicy): string[] {
  return files.map((f) => ({ f, why: isProtected(f, policy) })).filter((x) => x.why).map((x) => `${x.f} — ${x.why}`);
}

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
  /** Extra repo-relative paths, prefixes or globs (`src/tokens/**`) the agent must never write (on top of the built-ins). */
  protectedPaths?: string[];
}

export interface PolicyDecision {
  allow: boolean;
  reason?: string;
}

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** Never writable (and secrets never readable), regardless of config. */
// node_modules in a proposal worktree is a link to the main checkout's install: never writable.
const BUILTIN_PROTECTED = ['.git/', '.github/', '.peanut-gallery/', 'peanut-gallery.config.json', '.claude/', '.husky/', '.npmrc', '.yarnrc', '.yarnrc.yml', 'node_modules/'];
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

/** Minimal glob → RegExp: `**`, `*`, `?` and `{a,b}`; matched against repo-relative POSIX paths. */
export function globToRegExp(glob: string): RegExp {
  const esc = (t: string) => t.replace(/[.+^$()|[\]\\]/g, '\\$&');
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{' && glob.indexOf('}', i) > i) {
      const end = glob.indexOf('}', i);
      re += `(?:${glob.slice(i + 1, end).split(',').map(esc).join('|')})`;
      i = end;
    } else re += esc(c);
  }
  return new RegExp(`^${re}$`);
}

const isGlob = (p: string) => /[*?{]/.test(p);

export function isProtected(rel: string, policy: AgentPolicy): string | null {
  const relDir = rel.endsWith('/') ? rel : rel + '/';
  for (const pre of [...BUILTIN_PROTECTED, ...(policy.protectedPaths ?? [])]) {
    const p = pre.replace(/^\.\//, '');
    if (isGlob(p)) {
      if (globToRegExp(p).test(rel)) return `protected path (${pre})`;
      continue;
    }
    if (rel === p.replace(/\/$/, '') || relDir.startsWith(p.endsWith('/') ? p : p + '/') || rel.startsWith(p)) return `protected path (${pre})`;
  }
  if (SECRET_PATTERNS.some((re) => re.test(rel))) return 'secrets file';
  if (!policy.allowDependencyChanges && DEPENDENCY_FILES.some((re) => re.test(rel))) return 'dependency manifest (set agent.allowDependencyChanges to permit)';
  return null;
}

/** Resolve symlinks on the longest existing prefix of `abs` (the file itself may not exist yet). */
function realPathOf(abs: string): string {
  let head = abs;
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return abs;
    tail.unshift(basename(head));
    head = parent;
  }
  try {
    return join(realpathSync(head), ...tail);
  } catch {
    return abs;
  }
}

function within(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * True if `p`, with symlinks resolved, still lands inside the worktree (or, for reads, one of
 * `readRoots`). Stops a link committed to the repo from pointing the agent at files elsewhere.
 */
export function resolvesInside(cwd: string, p: string, readRoots: string[] = []): boolean {
  const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  const real = realPathOf(abs);
  return [cwd, ...readRoots].some((r) => within(realPathOf(resolve(r)), real));
}

/** Decide whether one agent tool call may run. Pure apart from resolving symlinks; unit-tested directly. */
export function evaluateToolUse(
  toolName: string,
  input: Record<string, unknown>,
  ctx: { cwd: string; policy: AgentPolicy; /** Extra places reads may resolve to (e.g. the main checkout's node_modules). */ readRoots?: string[] },
): PolicyDecision {
  const { cwd, policy } = ctx;

  if (READ_TOOLS.has(toolName)) {
    const p = pathOf(input);
    if (!p) return { allow: true };
    const rel = insideWorktree(cwd, p);
    if (rel === null) return { allow: false, reason: `read outside the worktree: ${p}` };
    if (SECRET_PATTERNS.some((re) => re.test(rel))) return { allow: false, reason: `secrets file: ${rel}` };
    if (!resolvesInside(cwd, p, ctx.readRoots)) return { allow: false, reason: `read through a link that leaves the worktree: ${rel}` };
    return { allow: true };
  }

  if (WRITE_TOOLS.has(toolName)) {
    const p = pathOf(input);
    if (!p) return { allow: false, reason: 'write without a path' };
    const rel = insideWorktree(cwd, p);
    if (rel === null) return { allow: false, reason: `write outside the worktree: ${p}` };
    const prot = isProtected(rel, policy);
    if (prot) return { allow: false, reason: `${prot}: ${rel}` };
    if (!resolvesInside(cwd, p)) return { allow: false, reason: `write through a link that leaves the worktree: ${rel}` };
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

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveTheme, type Theme } from '@peanut-gallery/core';
import type { AgentPolicy } from './policy.js';
import type { DesignSystemConfig } from './design.js';
import type { CheckConfig } from './checks.js';

export interface DevServerConfig {
  /** Command to start the prototype locally. `{port}` is substituted. e.g. "npm run dev -- --port {port}" */
  command: string;
  /** Port to start on; apply uses port, port+1, ... for parallel worktrees. */
  port?: number;
  /** URL template; default "http://localhost:{port}". */
  urlTemplate?: string;
  /** Max seconds to wait for the server to answer. */
  timeoutSec?: number;
}

export interface PeanutGalleryConfig {
  /** "owner/name" */
  repo: string;
  /** Hosted prototype used for "before" screenshots. If omitted, "before" is taken from a local dev server on the base branch. */
  prototypeUrl?: string;
  baseBranch?: string;
  dev?: DevServerConfig;
  /** Globs hinting where UI source lives, passed to the coding agent. */
  sourceHints?: string[];
  /** Extra guidance for the coding agent (conventions, gotchas). */
  agentNotes?: string;
  /**
   * The design system to build with: component packages, token files, component folders, docs
   * and rules. Token and doc files are read before every change and protected from edits unless
   * `allowEdits` is true.
   */
  designSystem?: DesignSystemConfig;
  /**
   * Pass the maintainers' written guidance to the agent as plain text. Default true, which reads
   * CLAUDE.md, AGENTS.md and .claude/CLAUDE.md if present; or list your own files; false to skip.
   * Claude Code settings, hooks and permissions are never loaded either way.
   */
  projectGuidance?: boolean | string[];
  /**
   * Commands run on each change before its PR opens (drift checker, linter, a11y scan). Results
   * are reported in the PR; a failing `required` check opens the PR as a draft.
   */
  checks?: CheckConfig[];
  /**
   * Checks built into Peanut Gallery. `undefinedClasses` flags CSS classes a change adds to markup
   * that no stylesheet defines (skipped automatically for Tailwind/UnoCSS projects). Default on,
   * report-only; set to "required" to open such PRs as drafts, or false to turn it off.
   */
  builtinChecks?: { undefinedClasses?: boolean | 'required' };
  /** Single model for everything (overridden by `models`). */
  model?: string;
  /** Per-stage models. Defaults: interpret/variants/votes → claude-haiku-5-5; apply (coding agent) → claude-sonnet-5-5. Try claude-opus-5-5 for large codebases. */
  models?: { interpret?: string; apply?: string };
  /**
   * What the coding agent may do. Default: read/search/edit source files in the worktree only.
   * e.g. { "allowCommands": ["npm run lint"], "allowDependencyChanges": false }
   */
  agent?: AgentPolicy;
  /** Override colours/fonts of the generated comparison pages (defaults to the Conifer / Prep / Wasabi palette). */
  theme?: Partial<Theme>;
  /** Default spend cap in USD per `apply`/`review`/`variants` invocation (CLI --budget overrides). */
  budget?: number;
  screenshot?: { width?: number; height?: number; fullPage?: boolean };
  /** Branch prefix for proposals. */
  branchPrefix?: string;
  /** Labels (override only if you changed them in the widget). */
  labels?: { feedback?: string; proposal?: string; accepted?: string; rejected?: string };
}

export const CONFIG_FILE = 'peanut-gallery.config.json';
export const WORK_DIR = '.peanut-gallery';

export interface ResolvedConfig extends PeanutGalleryConfig {
  baseBranch: string;
  model: string;
  models: { interpret: string; apply: string };
  branchPrefix: string;
  sourceHints: string[];
  screenshot: { width: number; height: number; fullPage: boolean };
  resolvedTheme: Theme;
}

export function loadConfig(cwd = process.cwd()): ResolvedConfig {
  const p = join(cwd, CONFIG_FILE);
  if (!existsSync(p)) throw new Error(`No ${CONFIG_FILE} found in ${cwd}. Run \`peanut-gallery init\` first.`);
  const cfg = JSON.parse(readFileSync(p, 'utf8')) as PeanutGalleryConfig;
  if (!cfg.repo) throw new Error(`${CONFIG_FILE}: "repo" is required`);
  return withDefaults(cfg);
}

export function withDefaults(cfg: PeanutGalleryConfig): ResolvedConfig {
  return {
    baseBranch: cfg.baseBranch ?? 'main',
    model: cfg.model ?? process.env.PEANUT_GALLERY_MODEL ?? 'claude-sonnet-5-5',
    branchPrefix: cfg.branchPrefix ?? 'peanut-gallery/',
    sourceHints: cfg.sourceHints ?? ['src/**'],
    ...cfg,
    models: {
      interpret: cfg.models?.interpret ?? cfg.model ?? process.env.PEANUT_GALLERY_MODEL_INTERPRET ?? 'claude-haiku-5-5',
      apply: cfg.models?.apply ?? cfg.model ?? process.env.PEANUT_GALLERY_MODEL ?? 'claude-sonnet-5-5',
    },
    screenshot: { width: 1280, height: 800, fullPage: false, ...(cfg.screenshot ?? {}) },
    resolvedTheme: resolveTheme(cfg.theme),
  };
}

export function workPath(...parts: string[]): string {
  const p = join(process.cwd(), WORK_DIR, ...parts);
  return p;
}

export const WORK_IGNORES = ['worktrees/', 'compare/', 'feedback.json', 'proposals.json', 'runs.json'];

export function ensureWorkDir(): string {
  const p = workPath();
  mkdirSync(p, { recursive: true });
  // Everything here is local working state. PR branches add their own compare files explicitly
  // (git add -f), so ignoring compare/ keeps a plain `git add -A` from committing every local run.
  const gi = join(p, '.gitignore');
  const have = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  const missing = WORK_IGNORES.filter((e) => !have.split(/\r?\n/).includes(e));
  if (missing.length) writeFileSync(gi, (have && !have.endsWith('\n') ? have + '\n' : have) + missing.join('\n') + '\n');
  return p;
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function writeJson(path: string, data: unknown) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveTheme, type Theme } from '@peanut-gallery/core';
import type { AgentPolicy } from './policy.js';

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
  /** Extra guidance for the coding agent (design system notes, conventions). */
  agentNotes?: string;
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

export function ensureWorkDir(): string {
  const p = workPath();
  mkdirSync(p, { recursive: true });
  const gi = join(p, '.gitignore');
  if (!existsSync(gi)) writeFileSync(gi, 'worktrees/\nfeedback.json\nproposals.json\nruns.json\n');
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

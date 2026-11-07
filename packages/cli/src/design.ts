import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentPolicy } from './policy.js';

/**
 * Tell the agent which design system to build with. Everything is optional; paths and globs are
 * relative to the repo root.
 */
export interface DesignSystemConfig {
  /** Component library package(s) to import from, e.g. ["@acme/ui"]. */
  packages?: string[];
  /** Token sources: CSS variables, JSON tokens, Tailwind config, theme files. Read before every change. */
  tokens?: string[];
  /** Where reusable components live (globs). The agent prefers these over building new ones. */
  components?: string[];
  /** Guidelines the agent must read before editing, e.g. ["docs/design-system.md"]. */
  docs?: string[];
  /** Your rules, in your words. */
  rules?: string;
  /**
   * Let the agent edit token and doc files. Default false: a change has to use the system, not
   * redefine it to satisfy one comment. Turn on if this repo *is* the design system.
   */
  allowEdits?: boolean;
}

/** Project guidance files read as plain text (never as Claude Code settings, hooks or permissions). */
export const DEFAULT_GUIDANCE_FILES = ['CLAUDE.md', 'AGENTS.md', '.claude/CLAUDE.md'];
const GUIDANCE_FILE_CAP = 6000;
const GUIDANCE_TOTAL_CAP = 12000;

export function guidanceFiles(setting: boolean | string[] | undefined): string[] {
  if (setting === false) return [];
  if (Array.isArray(setting)) return setting;
  return DEFAULT_GUIDANCE_FILES;
}

/**
 * Read the maintainers' written guidance (CLAUDE.md and friends) from `dir` as text. Only the
 * prose reaches the agent; Claude Code settings, hooks and permissions are still not loaded.
 */
export function readProjectGuidance(dir: string, setting?: boolean | string[]): { files: string[]; text: string } {
  const files: string[] = [];
  const parts: string[] = [];
  let total = 0;
  for (const f of guidanceFiles(setting)) {
    const p = join(dir, f);
    if (!existsSync(p) || !statSync(p).isFile()) continue;
    let body = readFileSync(p, 'utf8').trim();
    if (!body) continue;
    if (body.length > GUIDANCE_FILE_CAP) body = body.slice(0, GUIDANCE_FILE_CAP) + '\n…(truncated)';
    if (total + body.length > GUIDANCE_TOTAL_CAP) break;
    total += body.length;
    files.push(f);
    parts.push(`### ${f}\n${body}`);
  }
  return { files, text: parts.join('\n\n') };
}

export function hasDesignSystem(ds?: DesignSystemConfig): ds is DesignSystemConfig {
  return !!ds && !!(ds.packages?.length || ds.tokens?.length || ds.components?.length || ds.docs?.length || ds.rules?.trim());
}

/** The design-system section of the coding agent's prompt. */
export function designSystemBrief(ds?: DesignSystemConfig): string {
  if (!hasDesignSystem(ds)) return '';
  const mustRead = [...(ds.docs ?? []), ...(ds.tokens ?? [])];
  const lines = [
    '## Design system — use it, don’t reinvent it',
    mustRead.length ? `Before editing anything, read these files: ${mustRead.map((f) => `\`${f}\``).join(', ')}.` : '',
    ds.packages?.length ? `- Component library: ${ds.packages.map((p) => `\`${p}\``).join(', ')}. Import from it instead of building new components.` : '',
    ds.components?.length ? `- Reusable components live in ${ds.components.map((c) => `\`${c}\``).join(', ')}. Reuse or compose them before writing new markup.` : '',
    ds.tokens?.length
      ? '- Use the tokens (variables, theme values or utility classes) for every colour, spacing, radius, font size, weight and shadow. No raw hex, rgb or px values for those.'
      : '- Match the styling values the surrounding code already uses; don’t introduce new raw colours or sizes.',
    ds.allowEdits
      ? '- You may extend the tokens or components when the change genuinely needs it; keep additions consistent with the existing naming.'
      : '- If the change needs something the system doesn’t have (a new colour, size or variant), do not add it. Use the closest existing option and name what’s missing in your summary so a designer can decide.',
    ds.rules?.trim() ? `\n### Team rules\n${ds.rules.trim()}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

/** One-paragraph version for the interpret and variants prompts (no file reading there). */
export function designSystemSummary(ds?: DesignSystemConfig): string {
  if (!hasDesignSystem(ds)) return '';
  const bits = [
    ds.packages?.length ? `component library ${ds.packages.join(', ')}` : '',
    ds.tokens?.length ? `design tokens in ${ds.tokens.join(', ')}` : '',
    ds.components?.length ? `components in ${ds.components.join(', ')}` : '',
  ].filter(Boolean);
  return [
    `The project has a design system${bits.length ? ` (${bits.join('; ')})` : ''}. Every proposal and option must be achievable with its existing tokens and components; express changes in those terms (e.g. "use the primary button variant", "next spacing step up"), not as new raw values.`,
    ds.rules?.trim() ? `Design rules: ${ds.rules.trim()}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Agent policy with design-system files protected unless `allowEdits`. */
export function effectivePolicy(policy: AgentPolicy | undefined, ds?: DesignSystemConfig): AgentPolicy {
  const base = policy ?? {};
  if (!hasDesignSystem(ds) || ds.allowEdits) return base;
  const extra = [...(ds.tokens ?? []), ...(ds.docs ?? [])];
  if (!extra.length) return base;
  return { ...base, protectedPaths: [...(base.protectedPaths ?? []), ...extra] };
}

// ── init-time detection ─────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', 'coverage', '.peanut-gallery', '.turbo', '.cache', 'vendor']);
const TOKEN_FILE = /^(tailwind\.config\.(js|cjs|mjs|ts)|(_)?(design[-_.]?)?tokens?(\.[\w-]+)?\.(css|scss|sass|less|json|js|ts)|theme\.(css|scss|js|ts|json)|(_)?variables\.(css|scss|sass|less))$/i;
const DOC_FILE = /^(design[-_]?system|DESIGN|STYLEGUIDE|style[-_]?guide)\.mdx?$/i;

/** Look for likely token files, design docs and guidance files (depth ≤ 4, skipping build output). */
export function detectDesignSystem(root: string): { tokens: string[]; docs: string[]; guidance: string[] } {
  const tokens: string[] = [];
  const docs: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 4 || tokens.length + docs.length > 20) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(join(dir, e.name), r, depth + 1);
      } else if (e.isFile()) {
        if (TOKEN_FILE.test(e.name)) tokens.push(r);
        else if (DOC_FILE.test(e.name)) docs.push(r);
      }
    }
  };
  walk(root, '', 0);
  const guidance = DEFAULT_GUIDANCE_FILES.filter((f) => existsSync(join(root, f)));
  return { tokens: tokens.sort(), docs: docs.sort(), guidance };
}

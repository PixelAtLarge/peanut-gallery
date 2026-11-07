import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { git } from './github.js';
import type { CheckResult } from './checks.js';

const MARKUP = new Set(['.html', '.htm', '.jsx', '.tsx', '.vue', '.svelte', '.astro', '.hbs', '.njk', '.erb', '.php']);
const STYLE = new Set(['.css', '.scss', '.sass', '.less', '.styl', '.pcss']);
const SCRIPT = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.peanut-gallery', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', 'coverage', 'vendor']);

/** Class names from static class/className attributes on one line. Dynamic expressions are ignored. */
export function classesInLine(line: string): string[] {
  const out: string[] = [];
  const re = /\bclass(?:Name)?\s*=\s*(?:\{\s*)?(["'`])([^"'`]*)\1/g;
  for (let m; (m = re.exec(line)); ) {
    for (const c of m[2].split(/\s+/)) {
      // skip template pieces and utility-variant syntax (hover:…, w-[…], …/50)
      if (c && /^-?[A-Za-z_][\w-]*$/.test(c)) out.push(c);
    }
  }
  return out;
}

/** Repo uses utility CSS (Tailwind/UnoCSS), where most classes are never defined in a stylesheet. */
export function usesUtilityCss(dir: string): boolean {
  if (readdirSync(dir).some((f) => /^(tailwind|uno|windi)\.config\.(js|cjs|mjs|ts)$/.test(f))) return true;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return ['tailwindcss', 'unocss', '@unocss/core', 'windicss'].some((d) => d in deps);
  } catch {
    return false;
  }
}

function sourceFiles(dir: string, rel = '', acc: string[] = [], depth = 0): string[] {
  if (depth > 8 || acc.length > 5000) return acc;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(join(dir, rel), { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) sourceFiles(dir, r, acc, depth + 1);
    } else if (e.isFile()) {
      const x = extname(e.name).toLowerCase();
      if (STYLE.has(x) || MARKUP.has(x) || SCRIPT.has(x)) acc.push(r);
    }
  }
  return acc;
}

/**
 * Which of `classes` appear as a `.class` selector anywhere in the project's styles (stylesheets
 * and inline <style> blocks) or are referenced from scripts (querySelector('.x'), classList…).
 */
export function definedClasses(dir: string, classes: string[]): Set<string> {
  const found = new Set<string>();
  if (!classes.length) return found;
  const pending = new Set(classes);
  for (const f of sourceFiles(dir)) {
    if (!pending.size) break;
    let text: string;
    try {
      text = readFileSync(join(dir, f), 'utf8');
    } catch {
      continue;
    }
    const x = extname(f).toLowerCase();
    for (const c of [...pending]) {
      const esc = c.replace(/[-]/g, '\\-');
      const selector = new RegExp(`\\.${esc}(?![\\w-])`);
      const scriptRef = new RegExp(`["'\`][^"'\`]*(?:^|[\\s.])${esc}(?![\\w-])[^"'\`]*["'\`]`);
      const hit = STYLE.has(x) || MARKUP.has(x) ? selector.test(text) : SCRIPT.has(x) && (selector.test(text) || (/classList|className|querySelector|closest|matches/.test(text) && scriptRef.test(text)));
      if (hit) {
        found.add(c);
        pending.delete(c);
      }
    }
  }
  return found;
}

/** Classes added by the diff (on + lines) that weren't already on − lines, per changed markup file. */
export function addedClassesFromDiff(diff: string): { file: string; cls: string }[] {
  const out: { file: string; cls: string }[] = [];
  let file = '';
  let added: string[] = [];
  let removed = new Set<string>();
  const flush = () => {
    // Ignore generated or vendored output (e.g. Peanut Gallery's own compare pages).
    const generated = file.split('/').some((seg) => SKIP_DIRS.has(seg));
    if (file && !generated && MARKUP.has(extname(file).toLowerCase())) for (const c of new Set(added)) if (!removed.has(c)) out.push({ file, cls: c });
    added = [];
    removed = new Set();
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      flush();
      file = line.replace(/^\+\+\+ (b\/)?/, '').trim();
    } else if (line.startsWith('+') && !line.startsWith('+++')) added.push(...classesInLine(line));
    else if (line.startsWith('-') && !line.startsWith('---')) for (const c of classesInLine(line)) removed.add(c);
  }
  flush();
  return out;
}

/**
 * Built-in check: flag CSS classes the change adds to markup that no stylesheet defines (a class
 * that "does nothing"). Skipped for utility-CSS projects. Report-only unless configured required.
 */
export async function undefinedClassesCheck(dir: string, base: string, opts: { required?: boolean } = {}): Promise<CheckResult | null> {
  const started = Date.now();
  const name = 'Undefined CSS classes';
  if (usesUtilityCss(dir)) return null;
  let diff = '';
  try {
    diff = await git(['diff', '-U0', `${base}...HEAD`], dir);
  } catch {
    return null;
  }
  const added = addedClassesFromDiff(diff);
  if (!added.length) return null;
  const defined = definedClasses(dir, [...new Set(added.map((a) => a.cls))]);
  const missing = added.filter((a) => !defined.has(a.cls));
  const ok = missing.length === 0;
  const output = ok
    ? added.length === 1
      ? `The added class .${added[0].cls} is defined.`
      : `All ${added.length} added classes are defined.`
    : `Added to markup but not defined in any stylesheet, so they have no visible effect:\n${missing.map((m) => `  .${m.cls}  (${m.file})`).join('\n')}`;
  return { name, ok, required: !!opts.required, exitCode: ok ? 0 : 1, timedOut: false, output, durationMs: Date.now() - started };
}

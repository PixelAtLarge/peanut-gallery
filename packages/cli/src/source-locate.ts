import { cleanName, type SourceHint } from '@pixelatlarge/peanut-gallery-core';
import { git } from './github.js';
import type { FlatAnnotation } from './interpret.js';

/** Where a note's element is rendered in this repo. */
export interface Located {
  file: string;
  line?: number;
  components: string[];
  /** "app": the running app said so (and the file exists here). "search": found by searching the code for the element. */
  from: 'app' | 'search';
  /** For "search": what matched, e.g. `text "Order summary"`. */
  matched?: string[];
  /** Other files worth a look (e.g. the stylesheet). */
  also?: string[];
}

/** Files that render UI. Tests, stories, builds and dependencies are left out. */
const UI = /\.(jsx|tsx|js|ts|mjs|vue|svelte|astro|html?|erb|hbs|handlebars|njk|liquid|php|mdx|css|scss|sass|less)$/i;
const SKIP = /(^|\/)(node_modules|dist|build|out|coverage|\.next|\.nuxt|\.svelte-kit|\.peanut-gallery|vendor)\/|\.(test|spec|stories|story)\.[a-z]+$|\.min\.|\.d\.ts$/i;
const STYLES = /\.(css|scss|sass|less)$/i;

export async function uiFiles(dir: string): Promise<string[]> {
  const out = await git(['ls-files', '-co', '--exclude-standard'], dir).catch(() => '');
  return out.split('\n').filter((f) => f && UI.test(f) && !SKIP.test(f));
}

/**
 * The repo file a hint's path means: the same path, or the one whose end matches it
 * ("src/projects/shop/src/App.vue" → "src/App.vue"). Null if none, or if it's ambiguous.
 */
export function resolveFile(hint: string, files: string[]): string | null {
  const parts = hint.split('/');
  // The longest end of the path that matches anything decides: one file, or (several) no guess.
  for (let i = 0; i < parts.length; i++) {
    const tail = parts.slice(i).join('/');
    const hits = files.filter((f) => f === tail || f.endsWith(`/${tail}`));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null;
  }
  return null;
}

interface Token {
  label: string;
  patterns: string[];
  weight: number;
  word?: boolean;
}

/** What to search the code for, from what the widget recorded about the element. */
export function searchTokens(a: Pick<FlatAnnotation, 'anchor'>): Token[] {
  const sel = a.anchor.selector;
  const tokens: Token[] = [];
  // The attribute itself (data-testid="pay"), not just the value, which other attributes may share.
  for (const m of sel.matchAll(/\[(data-(?:testid|test-id|test|cy|qa))="([^"]+)"\]/g)) tokens.push({ label: `test id "${m[2]}"`, patterns: [`${m[1]}="${m[2]}"`, `${m[1]}='${m[2]}'`, `${m[1]}={"${m[2]}"}`, `${m[1]}={'${m[2]}'}`], weight: 5 });
  for (const m of sel.matchAll(/#([A-Za-z][\w-]*)/g)) tokens.push({ label: `id "${m[1]}"`, patterns: [`id="${m[1]}"`, `id='${m[1]}'`, `id={"${m[1]}"}`], weight: 4 });
  const text = (a.anchor.textFingerprint ?? '').replace(/\s+/g, ' ').trim();
  if (text.length >= 3) {
    // Rendered text often has values filled in ("Pay $104.00"); search the longest run of words.
    const runs = text.split(/[^A-Za-z'’ -]+/).map((r) => r.trim()).filter((r) => r.length >= 3);
    const words = runs.sort((x, y) => y.length - x.length)[0];
    const exact = text.slice(0, 60);
    const pats = Array.from(new Set([exact, ...(words && words !== exact ? [words.slice(0, 60)] : [])]));
    tokens.push({ label: `text "${pats[pats.length - 1]}"`, patterns: pats, weight: 3 });
  }
  const generic = /^(btn|button|row|col|container|wrapper|inner|outer|active|selected|flex|grid|card|item|text|title|link|icon|is-|has-|js-)/;
  for (const m of sel.matchAll(/\.([A-Za-z_][\w-]*)/g)) {
    // Utility and hashed classes say little (".mt-4", ".css-1x2y3z", "._a8f3").
    if (m[1].length < 4 || generic.test(m[1]) || /\d{2,}|^css-|^_|^[a-z]{1,3}-\d/.test(m[1])) continue;
    tokens.push({ label: `class "${m[1]}"`, patterns: [m[1]], weight: 1, word: true });
  }
  return tokens.slice(0, 8);
}

/** Search the code for the element: the file that matches the most (and strongest) clues. */
export async function searchSource(a: Pick<FlatAnnotation, 'anchor'>, dir: string, files: string[], minScore = 3): Promise<Located | null> {
  const tokens = searchTokens(a);
  if (!tokens.length || !files.length) return null;
  const allowed = new Set(files);
  const scores = new Map<string, { score: number; line: number; best: number; matched: string[] }>();
  for (const t of tokens) {
    const args = ['grep', '-n', '-I', '-F', ...(t.word ? ['-w'] : []), ...t.patterns.flatMap((p) => ['-e', p]), '--', '.'];
    const out = await git(args, dir).catch(() => '');
    const seen = new Set<string>();
    for (const row of out.split('\n')) {
      const m = /^(.+?):(\d+):/.exec(row);
      if (!m || !allowed.has(m[1]) || seen.has(m[1])) continue;
      seen.add(m[1]);
      const s = scores.get(m[1]) ?? { score: 0, line: Number(m[2]), best: 0, matched: [] };
      // Styles back up a match; the markup is what renders the element.
      s.score += STYLES.test(m[1]) ? t.weight / 2 : t.weight;
      if (t.weight > s.best) {
        s.best = t.weight;
        s.line = Number(m[2]);
      }
      s.matched.push(t.label);
      scores.set(m[1], s);
    }
  }
  const ranked = [...scores.entries()].sort((x, y) => y[1].score - x[1].score || x[0].length - y[0].length);
  const top = ranked.find(([f]) => !STYLES.test(f)) ?? ranked[0];
  // A lone class name or a common word isn't enough to point anywhere (unless the file is already known).
  if (!top || top[1].score < minScore) return null;
  // Close runners-up, and the stylesheet that styles the element's classes (for visual changes).
  const also = ranked
    .filter(([f, s]) => f !== top[0] && (s.score >= top[1].score / 2 || (STYLES.test(f) && s.matched.some((m) => m.startsWith('class ')))))
    .slice(0, 2)
    .map(([f]) => f);
  return { file: top[0], line: top[1].line, components: [], from: 'search', matched: top[1].matched, ...(also.length ? { also } : {}) };
}

/** Where each note's element is rendered: the app's hint if it checks out here, else a search. */
export async function locateSources(annotations: FlatAnnotation[], dir: string): Promise<Map<string, Located>> {
  const files = await uiFiles(dir);
  const out = new Map<string, Located>();
  for (const a of annotations) {
    const hint = a.source as SourceHint | undefined;
    const components = (hint?.components ?? []).map(cleanName).filter((c): c is string => !!c);
    const file = hint?.file ? resolveFile(hint.file, files) : null;
    if (file) {
      // No line from the app (React 19 doesn't give a usable one): find it inside that file.
      const line = hint?.line ?? (await searchSource(a, dir, [file], 1).catch(() => null))?.line;
      out.set(a.id, { file, ...(line ? { line } : {}), components, from: 'app' });
      continue;
    }
    const found = await searchSource(a, dir, files);
    if (found) out.set(a.id, { ...found, components });
    else if (components.length) out.set(a.id, { file: '', components, from: 'app' });
  }
  return out;
}

/** One line per note for the agent: where to start looking. */
export function whereToLook(annotations: FlatAnnotation[], located: Map<string, Located>): string[] {
  return annotations.flatMap((a) => {
    const l = located.get(a.id);
    if (!l) return [];
    const note = a.text.replace(/\s+/g, ' ').slice(0, 60) + (a.text.length > 60 ? '…' : '');
    const comp = l.components.length ? `${l.components.length > 1 ? 'components' : 'component'} ${l.components.join(' › ')}` : '';
    if (!l.file) return [`"${note}" → ${comp} (from the running app; find its file)`];
    const at = `${l.file}${l.line ? `:${l.line}` : ''}`;
    const why = l.from === 'app' ? `from the running app${comp ? `: ${comp}` : ''}` : `found by searching the code for ${l.matched!.join(', ')}`;
    return [`"${note}" → ${at} (${why})${l.also?.length ? `; also ${l.also.join(', ')}` : ''}`];
  });
}

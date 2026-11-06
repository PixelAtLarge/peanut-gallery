import type { ElementAnchor } from './types.js';

const MAX_FINGERPRINT = 80;

export function normalizeText(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_FINGERPRINT);
}

function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
  return s.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
}

const ATTR_PRIORITY = ['data-testid', 'data-test', 'data-cy', 'data-proto-id', 'id', 'name', 'aria-label'];

function isGeneratedToken(v: string): boolean {
  // Avoid hashed/CSS-module/emotion-style class names and random ids.
  return /[0-9a-f]{6,}/i.test(v) || /^(css|sc|emotion|svelte|jsx)-/.test(v) || /^_/.test(v) || v.length > 40;
}

function segmentFor(el: Element): { seg: string; unique: boolean } {
  for (const attr of ATTR_PRIORITY) {
    const v = el.getAttribute(attr);
    if (v && !isGeneratedToken(v)) {
      const seg = attr === 'id' ? `#${cssEscape(v)}` : `${el.tagName.toLowerCase()}[${attr}="${v.replace(/"/g, '\\"')}"]`;
      const doc = el.ownerDocument;
      try {
        if (doc.querySelectorAll(seg).length === 1) return { seg, unique: true };
      } catch {
        /* ignore bad selector */
      }
    }
  }
  const tag = el.tagName.toLowerCase();
  const stableClasses = Array.from(el.classList).filter((c) => !isGeneratedToken(c)).slice(0, 2);
  let seg = tag + stableClasses.map((c) => `.${cssEscape(c)}`).join('');
  const parent = el.parentElement;
  if (parent) {
    const siblings = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
    if (siblings.length > 1) seg += `:nth-of-type(${siblings.indexOf(el) + 1})`;
  }
  return { seg, unique: false };
}

/** Build a CSS selector that prefers stable, human-meaningful hooks. */
export function buildSelector(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== cur.ownerDocument.documentElement) {
    const { seg, unique } = segmentFor(cur);
    parts.unshift(seg);
    if (unique) break;
    cur = cur.parentElement;
    if (parts.length > 8) break;
  }
  return parts.join(' > ');
}

function nearestContext(el: Element): string | undefined {
  let cur: Element | null = el;
  while (cur) {
    const heading: Element | null = cur.querySelector('h1, h2, h3, legend, [role="heading"]');
    if (heading && heading !== el && cur !== el) return normalizeText(heading.textContent);
    const label = cur.getAttribute?.('aria-label') ?? cur.getAttribute?.('aria-labelledby');
    if (label && cur !== el) return normalizeText(label);
    cur = cur.parentElement;
  }
  return undefined;
}

export function createAnchor(el: Element, clientX: number, clientY: number): ElementAnchor {
  const r = el.getBoundingClientRect();
  const win = el.ownerDocument.defaultView!;
  return {
    selector: buildSelector(el),
    textFingerprint: normalizeText(el.textContent),
    tag: el.tagName.toLowerCase(),
    rect: { x: r.left + win.scrollX, y: r.top + win.scrollY, width: r.width, height: r.height },
    offset: {
      x: r.width ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0.5,
      y: r.height ? Math.min(1, Math.max(0, (clientY - r.top) / r.height)) : 0.5,
    },
    context: nearestContext(el),
  };
}

function textScore(el: Element, fp: string): number {
  if (!fp) return 0.5;
  const t = normalizeText(el.textContent);
  if (t === fp) return 1;
  if (t.includes(fp) || fp.includes(t)) return 0.75;
  return 0;
}

/**
 * Resolve an anchor to an element in `doc`. Strategy:
 * 1. selector matches exactly one element -> use it (verify text loosely)
 * 2. selector matches several -> pick best text match
 * 3. selector fails -> search same tag by text fingerprint
 * 4. fall back to element at the stored rect center
 */
export function resolveAnchor(anchor: ElementAnchor, doc: Document): { el: Element | null; confidence: number } {
  let candidates: Element[] = [];
  try {
    candidates = Array.from(doc.querySelectorAll(anchor.selector));
  } catch {
    candidates = [];
  }
  if (candidates.length === 1) {
    const s = textScore(candidates[0], anchor.textFingerprint);
    if (s > 0) return { el: candidates[0], confidence: 0.95 };
  }
  if (candidates.length > 1) {
    const ranked = candidates
      .map((el) => ({ el, s: textScore(el, anchor.textFingerprint) }))
      .sort((a, b) => b.s - a.s);
    if (ranked[0].s > 0) return { el: ranked[0].el, confidence: 0.8 };
  }
  if (anchor.textFingerprint) {
    const sameTag = Array.from(doc.getElementsByTagName(anchor.tag));
    const ranked = sameTag.map((el) => ({ el, s: textScore(el, anchor.textFingerprint) })).sort((a, b) => b.s - a.s);
    if (ranked[0]?.s >= 0.75) return { el: ranked[0].el, confidence: 0.6 };
  }
  // Selector matched but the text changed (e.g. copy edit): trust the selector, lower confidence.
  if (candidates.length === 1) return { el: candidates[0], confidence: 0.5 };
  const win = doc.defaultView;
  if (win && typeof doc.elementFromPoint === 'function') {
    const cx = anchor.rect.x + anchor.rect.width / 2 - win.scrollX;
    const cy = anchor.rect.y + anchor.rect.height / 2 - win.scrollY;
    const el = doc.elementFromPoint(cx, cy);
    if (el) return { el, confidence: 0.3 };
  }
  return { el: null, confidence: 0 };
}

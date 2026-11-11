import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

/** A rectangle as fractions (0–1) of an image's width and height, so it scales with the image. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VisualDiff {
  /** "none": no visible difference. "some": the changed areas are outlined. "most": most of the view changed, so outlines wouldn't help. */
  verdict: 'none' | 'some' | 'most';
  /** Changed areas on the after image. */
  after: Box[];
  /** The same areas on the before image. */
  before: Box[];
  /** Share of the after image that changed (0–1). */
  changed: number;
}

/** Screenshots are taken at 2× and compared at 1×: one unit is one CSS pixel. */
const UNIT = 2;
/** Changed pixels are grouped in cells of this many units; a cell counts when enough of it changed. */
const CELL = 8;
const CELL_MIN = 4;
/** A per-channel difference smaller than this is rendering noise, not a change. */
const NOISE = 40;
/** More than this share changed → "most of the view changed". */
const MOST = 0.55;
const MAX_BOXES = 8;

interface Img {
  w: number;
  h: number;
  /** RGB at unit resolution. */
  rgb: Uint8Array;
  /** Grayscale at unit resolution. */
  gray: Float32Array;
}

/** Decode a PNG and average it down to one value per CSS pixel. */
function load(file: string): Img {
  const png = PNG.sync.read(readFileSync(file));
  const w = Math.max(1, Math.floor(png.width / UNIT));
  const h = Math.max(1, Math.floor(png.height / UNIT));
  const rgb = new Uint8Array(w * h * 3);
  const gray = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < UNIT; dy++) {
        for (let dx = 0; dx < UNIT; dx++) {
          const i = ((y * UNIT + dy) * png.width + x * UNIT + dx) * 4;
          // Flatten transparency onto white, the way it's shown.
          const a = png.data[i + 3] / 255;
          r += png.data[i] * a + 255 * (1 - a);
          g += png.data[i + 1] * a + 255 * (1 - a);
          b += png.data[i + 2] * a + 255 * (1 - a);
        }
      }
      const n = UNIT * UNIT;
      const o = (y * w + x) * 3;
      rgb[o] = r / n;
      rgb[o + 1] = g / n;
      rgb[o + 2] = b / n;
      gray[y * w + x] = 0.299 * rgb[o] + 0.587 * rgb[o + 1] + 0.114 * rgb[o + 2];
    }
  }
  return { w, h, rgb, gray };
}

/** Shrink a grayscale image by `f` (box average), for a fast first pass at alignment. */
function shrink(img: Img, f: number): { w: number; h: number; gray: Float32Array } {
  const w = Math.max(1, Math.floor(img.w / f));
  const h = Math.max(1, Math.floor(img.h / f));
  const gray = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) s += img.gray[(y * f + dy) * img.w + x * f + dx];
      gray[y * w + x] = s / (f * f);
    }
  }
  return { w, h, gray };
}

/**
 * How different two images look when `after` is shifted by (ox, oy) onto `before`: mean gray
 * difference over the overlap, plus a small cost for shifting so "no shift" wins ties.
 */
function score(b: { w: number; h: number; gray: Float32Array }, a: { w: number; h: number; gray: Float32Array }, ox: number, oy: number): number {
  const x0 = Math.max(0, -ox);
  const y0 = Math.max(0, -oy);
  const x1 = Math.min(a.w, b.w - ox);
  const y1 = Math.min(a.h, b.h - oy);
  const area = (x1 - x0) * (y1 - y0);
  // Too little overlap to say anything.
  if (x1 <= x0 || y1 <= y0 || area < 0.5 * Math.min(a.w * a.h, b.w * b.h)) return Infinity;
  let s = 0;
  for (let y = y0; y < y1; y++) {
    const ra = y * a.w;
    const rb = (y + oy) * b.w + ox;
    for (let x = x0; x < x1; x++) s += Math.abs(a.gray[ra + x] - b.gray[rb + x]);
  }
  return s / area + 0.05 * (Math.abs(ox) + Math.abs(oy));
}

/**
 * The shift that lines `after` up with `before`. A close-up is cropped around the element, so
 * when the element grows or shrinks, everything around it moves; without this, all of it would
 * look changed.
 */
function align(before: Img, after: Img): { x: number; y: number } {
  const F = 4;
  const b = shrink(before, F);
  const a = shrink(after, F);
  const R = 24; // up to ~100 CSS px each way
  let best = { x: 0, y: 0, s: score(b, a, 0, 0) };
  const tryAt = (x: number, y: number) => {
    const s = score(b, a, x, y);
    if (s < best.s) best = { x, y, s };
  };
  for (let y = -R; y <= R; y++) tryAt(0, y);
  const by = best.y;
  for (let x = -R; x <= R; x++) tryAt(x, by);
  const c = { x: best.x, y: best.y };
  for (let y = c.y - 1; y <= c.y + 1; y++) for (let x = c.x - 1; x <= c.x + 1; x++) tryAt(x, y);
  // Refine at full (CSS px) resolution.
  const fine = { x: best.x * F, y: best.y * F };
  let top = { x: fine.x, y: fine.y, s: score(before, after, fine.x, fine.y) };
  for (let y = fine.y - F; y <= fine.y + F; y++) {
    for (let x = fine.x - F; x <= fine.x + F; x++) {
      const s = score(before, after, x, y);
      if (s < top.s) top = { x, y, s };
    }
  }
  return { x: top.x, y: top.y };
}

interface CellBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Group changed cells into rectangles: connected areas, then any within `gap` cells merged. */
function boxesFrom(cells: Uint8Array, cw: number, ch: number, gap: number): CellBox[] {
  const seen = new Uint8Array(cells.length);
  const boxes: CellBox[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i] || seen[i]) continue;
    const box = { x0: cw, y0: ch, x1: -1, y1: -1 };
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % cw;
      const y = (j - x) / cw;
      box.x0 = Math.min(box.x0, x);
      box.y0 = Math.min(box.y0, y);
      box.x1 = Math.max(box.x1, x);
      box.y1 = Math.max(box.y1, y);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          const k = ny * cw + nx;
          if (cells[k] && !seen[k]) {
            seen[k] = 1;
            stack.push(k);
          }
        }
      }
    }
    boxes.push(box);
  }
  // Merge boxes that touch or nearly touch, until nothing changes.
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const p = boxes[i];
        const q = boxes[j];
        if (p.x0 - gap <= q.x1 && q.x0 - gap <= p.x1 && p.y0 - gap <= q.y1 && q.y0 - gap <= p.y1) {
          boxes[i] = { x0: Math.min(p.x0, q.x0), y0: Math.min(p.y0, q.y0), x1: Math.max(p.x1, q.x1), y1: Math.max(p.y1, q.y1) };
          boxes.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return boxes;
}

/** Compare two screenshots of the same thing and find what visibly changed. */
export function visualDiff(beforeFile: string, afterFile: string): VisualDiff {
  const before = load(beforeFile);
  const after = load(afterFile);
  const off = align(before, after);
  const cw = Math.ceil(after.w / CELL);
  const ch = Math.ceil(after.h / CELL);
  const count = new Uint16Array(cw * ch);
  for (let y = 0; y < after.h; y++) {
    for (let x = 0; x < after.w; x++) {
      const bx = x + off.x;
      const by = y + off.y;
      let changed: boolean;
      if (bx < 0 || by < 0 || bx >= before.w || by >= before.h) changed = true; // new area
      else {
        const a = (y * after.w + x) * 3;
        const b = (by * before.w + bx) * 3;
        changed = Math.max(Math.abs(after.rgb[a] - before.rgb[b]), Math.abs(after.rgb[a + 1] - before.rgb[b + 1]), Math.abs(after.rgb[a + 2] - before.rgb[b + 2])) > NOISE;
      }
      if (changed) count[Math.floor(y / CELL) * cw + Math.floor(x / CELL)]++;
    }
  }
  const cells = new Uint8Array(cw * ch);
  let n = 0;
  for (let i = 0; i < cells.length; i++) if (count[i] >= CELL_MIN) (cells[i] = 1), n++;
  const changed = n / cells.length;
  if (!n) return { verdict: 'none', after: [], before: [], changed: 0 };
  if (changed > MOST) return { verdict: 'most', after: [], before: [], changed };

  const boxes = boxesFrom(cells, cw, ch, 2)
    .map((b) => ({ x0: Math.max(0, b.x0 - 1), y0: Math.max(0, b.y0 - 1), x1: Math.min(cw - 1, b.x1 + 1), y1: Math.min(ch - 1, b.y1 + 1) }))
    .sort((p, q) => (q.x1 - q.x0 + 1) * (q.y1 - q.y0 + 1) - (p.x1 - p.x0 + 1) * (p.y1 - p.y0 + 1))
    .slice(0, MAX_BOXES);
  const toAfter = (b: CellBox): Box => {
    const x = b.x0 * CELL;
    const y = b.y0 * CELL;
    const w = Math.min(after.w, (b.x1 + 1) * CELL) - x;
    const h = Math.min(after.h, (b.y1 + 1) * CELL) - y;
    return { x: x / after.w, y: y / after.h, w: w / after.w, h: h / after.h };
  };
  const toBefore = (b: CellBox): Box | null => {
    const x = Math.max(0, b.x0 * CELL + off.x);
    const y = Math.max(0, b.y0 * CELL + off.y);
    const x1 = Math.min(before.w, (b.x1 + 1) * CELL + off.x);
    const y1 = Math.min(before.h, (b.y1 + 1) * CELL + off.y);
    // An area that's new (mostly off the before image) gets no outline there.
    const w = ((b.x1 - b.x0 + 1) * CELL) / 2;
    const h = ((b.y1 - b.y0 + 1) * CELL) / 2;
    if (x1 - x < w || y1 - y < h) return null;
    return { x: x / before.w, y: y / before.h, w: (x1 - x) / before.w, h: (y1 - y) / before.h };
  };
  return {
    verdict: 'some',
    after: boxes.map(toAfter),
    before: boxes.map(toBefore).filter((b): b is Box => !!b),
    changed,
  };
}

/** One line about a pair's diff, for labels: "2 changes outlined". */
export function diffNote(d: VisualDiff | undefined): string {
  if (!d) return '';
  if (d.verdict === 'none') return 'No visible change';
  if (d.verdict === 'most') return 'Most of the view changed';
  return `${d.after.length} change${d.after.length > 1 ? 's' : ''} outlined`;
}

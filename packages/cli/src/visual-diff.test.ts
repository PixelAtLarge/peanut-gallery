import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { diffNote, visualDiff } from './visual-diff.js';
import { renderComparePage, renderSummaryPage } from './compare.js';
import { visibleChangeNote } from './commands/apply.js';

type RGB = [number, number, number];
type Rect = { x: number; y: number; w: number; h: number; c: RGB };

const dir = mkdtempSync(join(tmpdir(), 'pg-diff-'));
let n = 0;

/** A 2× screenshot (like the real ones) of a page made of rectangles, in CSS pixels. */
function shot(w: number, h: number, rects: Rect[], noise = 0): string {
  const png = new PNG({ width: w * 2, height: h * 2 });
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31 - 0.5) * 2 * noise;
  for (let y = 0; y < h * 2; y++) {
    for (let x = 0; x < w * 2; x++) {
      let c: RGB = [255, 255, 255];
      for (const r of rects) if (x / 2 >= r.x && x / 2 < r.x + r.w && y / 2 >= r.y && y / 2 < r.y + r.h) c = r.c;
      const i = (y * w * 2 + x) * 4;
      png.data[i] = Math.max(0, Math.min(255, c[0] + rnd()));
      png.data[i + 1] = Math.max(0, Math.min(255, c[1] + rnd()));
      png.data[i + 2] = Math.max(0, Math.min(255, c[2] + rnd()));
      png.data[i + 3] = 255;
    }
  }
  const f = join(dir, `s${n++}.png`);
  writeFileSync(f, PNG.sync.write(png));
  return f;
}

const ink: RGB = [34, 39, 43];
const line: RGB = [207, 217, 223];
/** A page-like layout: a header bar, cards and lines of "text", so alignment has something to hold on to. */
const layout = (dy = 0): Rect[] => [
  { x: 0, y: 0 + dy, w: 640, h: 48, c: [30, 77, 54] },
  ...[0, 1, 2].map((i) => ({ x: 24 + i * 204, y: 80 + dy, w: 188, h: 120, c: line })),
  ...[0, 1, 2, 3, 4, 5].map((i) => ({ x: 24, y: 224 + i * 22 + dy, w: 300 + ((i * 97) % 260), h: 10, c: ink })),
];

describe('visual diff', () => {
  it('finds nothing in identical shots, or ones with only rendering noise', () => {
    expect(visualDiff(shot(640, 400, layout()), shot(640, 400, layout()))).toMatchObject({ verdict: 'none', after: [], changed: 0 });
    expect(visualDiff(shot(640, 400, layout()), shot(640, 400, layout(), 12)).verdict).toBe('none');
  });

  it('outlines a changed button, in the same place on both images', () => {
    const before = shot(640, 400, [...layout(), { x: 400, y: 320, w: 120, h: 40, c: line }]);
    const after = shot(640, 400, [...layout(), { x: 400, y: 320, w: 120, h: 40, c: [15, 123, 82] }]);
    const d = visualDiff(before, after);
    expect(d.verdict).toBe('some');
    expect(d.after).toHaveLength(1);
    const [b] = d.after;
    // Covers the button (400–520 × 320–360 of 640 × 400), with a little room around it.
    expect(b.x).toBeLessThanOrEqual(400 / 640);
    expect(b.x + b.w).toBeGreaterThanOrEqual(520 / 640);
    expect(b.y).toBeLessThanOrEqual(320 / 400);
    expect(b.y + b.h).toBeGreaterThanOrEqual(360 / 400);
    expect(b.w).toBeLessThan(0.3);
    expect(d.before).toEqual(d.after);
    expect(diffNote(d)).toBe('1 change outlined');
  });

  it('lines up a close-up whose element grew, and outlines only what is new', () => {
    // After: a 36px banner on top pushes everything down, and the crop is taller.
    const before = shot(640, 360, layout());
    const after = shot(640, 396, [{ x: 0, y: 0, w: 640, h: 36, c: [234, 194, 108] }, ...layout(36)]);
    const d = visualDiff(before, after);
    expect(d.verdict).toBe('some');
    expect(d.after).toHaveLength(1);
    // Only the banner: the top tenth of the image, not everything below it.
    expect(d.after[0].y).toBe(0);
    expect(d.after[0].h).toBeLessThan(60 / 396);
    // The banner wasn't on the before image at all.
    expect(d.before).toHaveLength(0);
  });

  it('a same-size crop that moved (button grew, crop re-centred) outlines only what changed', () => {
    // Everything shifts 24px right except the button, which grows leftwards in place.
    const before = shot(560, 240, [...layout(0).map((r) => ({ ...r, x: r.x - 24 })), { x: 380, y: 160, w: 90, h: 36, c: line }]);
    const after = shot(560, 240, [...layout(0), { x: 340, y: 160, w: 130, h: 36, c: [65, 95, 215] }]);
    const d = visualDiff(before, after);
    expect(d.verdict).toBe('some');
    // Not the strip the moved crop revealed at the left edge, and not full height.
    expect(d.after.every((b) => b.x > 0.3 && b.h < 0.5)).toBe(true);
  });

  it('outlines separate changes separately', () => {
    const before = shot(640, 400, layout());
    const after = shot(640, 400, [...layout(), { x: 40, y: 360, w: 60, h: 20, c: [200, 40, 40] }, { x: 560, y: 60, w: 50, h: 12, c: [200, 40, 40] }]);
    const d = visualDiff(before, after);
    expect(d.after).toHaveLength(2);
    expect(diffNote(d)).toBe('2 changes outlined');
  });

  it('says "most of the view changed" instead of outlining everything', () => {
    const d = visualDiff(shot(320, 200, layout()), shot(320, 200, [{ x: 0, y: 0, w: 320, h: 200, c: [200, 40, 40] }]));
    expect(d.verdict).toBe('most');
    expect(d.after).toEqual([]);
    expect(diffNote(d)).toBe('Most of the view changed');
  });
});

describe('showing changes', () => {
  const p = { id: 'pr_1', title: 'T', summary: 'S', effort: 'small', confidence: 1, issueNumbers: [1] } as never;
  const some = { verdict: 'some' as const, after: [{ x: 0.5, y: 0.25, w: 0.1, h: 0.05 }], before: [{ x: 0.5, y: 0.2, w: 0.1, h: 0.05 }], changed: 0.01 };
  const none = { verdict: 'none' as const, after: [], before: [], changed: 0 };

  it('outlines changes on the comparison page, with a switch to hide them', () => {
    const html = renderComparePage(p, [{ label: 'button “Pay”', before: 'b.png', after: 'a.png', diff: some }, { label: 'Page /', before: 'b2.png', after: 'a2.png', diff: none }], { repo: 'o/r', issueNumbers: [1] });
    expect(html).toContain('<i class="hl hl-after" style="left:50.00%;top:25.00%;width:10.00%;height:5.00%"></i>');
    expect(html).toContain('<i class="hl hl-before" style="left:50.00%;top:20.00%;width:10.00%;height:5.00%"></i>');
    expect(html).toContain('<em class="note some">1 change outlined</em>');
    expect(html).toContain('<em class="note none">No visible change</em>');
    const flagged = renderComparePage(p, [{ label: 'button “Pay”', before: 'b.png', after: 'a.png', diff: none }], { repo: 'o/r', issueNumbers: [1] });
    expect(flagged).toContain('<em class="note none warn">No visible change</em>');
    // The switch only shows where there's something to outline.
    expect(html.match(/class="hl-toggle"/g)).toHaveLength(1);
  });

  it('outlines them on the PR image too', () => {
    const html = renderSummaryPage(p, [{ label: 'x', before: 'b.png', after: 'a.png', diff: some }]);
    expect(html).toContain('class="hl hl-after"');
    expect(html).toContain('1 change outlined');
  });

  it('warns in the PR when nothing visibly changed', () => {
    expect(visibleChangeNote(undefined)).toBe('');
    expect(visibleChangeNote([{ label: 'button “Pay” · /checkout', change: 'some' }])).toBe('');
    expect(visibleChangeNote([{ label: 'button “Pay” · /checkout', change: 'none' }, { label: 'Page /checkout', change: 'none' }])).toContain('show no visible difference');
    // A page that didn't change is normal; a close-up that didn't is worth a look.
    expect(visibleChangeNote([{ label: 'button “Pay” · /checkout', change: 'some' }, { label: 'Page /checkout', change: 'none' }])).toBe('');
    expect(visibleChangeNote([{ label: 'h2 “Remove item?” · / — after clicking “Remove”', change: 'none' }, { label: 'Page /', change: 'some' }])).toBe('> ⚠️ No visible difference in “h2 “Remove item?” · /”.\n\n');
  });
});

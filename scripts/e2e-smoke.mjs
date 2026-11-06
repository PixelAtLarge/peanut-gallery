// End-to-end smoke (no AI / GitHub): drive the widget in a real browser, then run the
// screenshot + compare pipeline against a "before" and "after" server.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { captureShots, renderComparePage, renderSummaryPage, renderHtmlToPng } from '../packages/cli/dist/index.js';
import { chromium } from 'playwright';

const BEFORE = process.env.BEFORE ?? 'http://127.0.0.1:4310/examples/vanilla-prototype/';
const AFTER = process.env.AFTER ?? 'http://127.0.0.1:4311/';
const out = process.env.OUT ?? '/tmp/e2e/out';
mkdirSync(out, { recursive: true });

// 1. Widget: open with ?peanut, leave a comment on the Pay button, open Review panel.
const browser = await chromium.launch(process.env.PEANUT_GALLERY_BROWSER ? { executablePath: process.env.PEANUT_GALLERY_BROWSER } : { channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
await page.goto(BEFORE + '?peanut', { waitUntil: 'load' });
const sr = (sel) => page.locator('peanut-gallery').locator(sel);
await sr('[data-role=comment]').click();
await page.locator('button[data-testid="pay"]').hover();
await page.locator('button[data-testid="pay"]').click();
await sr('textarea').fill('This should be the primary CTA — make it stand out and show the total on the button.');
await sr('select').selectOption('visual');
await sr('.pg-composer .pg-primary').click();
await sr('[data-role=comment]').click();
await page.locator('[data-testid="total"]').hover();
await page.locator('[data-testid="total"]').click();
await sr('textarea').fill('Total feels buried; make it larger.');
await sr('.pg-composer .pg-primary').click();
await sr('[data-role=review]').click();
await page.screenshot({ path: join(out, 'widget.png') });
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('peanut-gallery:acme/checkout-prototype')));
console.log('widget stored', stored.annotations.length, 'annotations;', stored.annotations.map((a) => a.anchor.selector));
await browser.close();

// 2. Pipeline: before/after shots using the anchors the widget produced.
const targets = [
  ...stored.annotations.map((a, i) => ({ key: `el${i + 1}`, label: `${a.anchor.tag} “${a.anchor.textFingerprint}”`, pagePath: '/', anchor: a.anchor })),
  { key: 'page1', label: 'Page /', pagePath: '/' },
];
const shot = { width: 1280, height: 800, fullPage: false };
const b = await captureShots(BEFORE, targets, out, { ...shot, prefix: 'before' });
const a = await captureShots(AFTER, targets, out, { ...shot, prefix: 'after' });
console.log('confidence before/after', b.map((x) => x.confidence), a.map((x) => x.confidence));
const proposal = {
  id: 'pr_demo',
  title: 'Make “Pay now” the primary CTA and show the total',
  summary: 'Two reviewers flagged the pay button as under-emphasised and the total as buried. Promote the button to the accent colour and put the amount on it.',
  instructions: '',
  annotationIds: [],
  issueNumbers: [12],
  pages: ['/'],
  focusAnchors: [],
  effort: 'small',
  confidence: 0.9,
};
const pairs = targets.map((t, i) => ({ label: t.label, before: relative(out, b[i].file), after: relative(out, a[i].file) }));
writeFileSync(join(out, 'compare.html'), renderComparePage(proposal, pairs, { repo: 'acme/checkout-prototype', issueNumbers: [12] }));
writeFileSync(join(out, 'summary.html'), renderSummaryPage(proposal, pairs));
await renderHtmlToPng(join(out, 'summary.html'), join(out, 'summary.png'));
console.log('wrote', out);

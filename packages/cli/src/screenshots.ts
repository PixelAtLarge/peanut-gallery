import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stepPhrase, type ElementAnchor, type Step } from '@pixelatlarge/peanut-gallery-core';

export interface ShotTarget {
  /** Stable key, used for filenames. */
  key: string;
  label: string;
  /** Path portion of the page (e.g. "/checkout?x=1"); joined onto the base URL. */
  pagePath: string;
  anchor?: ElementAnchor;
  /** What the reviewer did before leaving the note (Annotation.steps), replayed to reach the same state. */
  steps?: Step[];
}

export interface ShotResult {
  key: string;
  label: string;
  file: string;
  confidence?: number;
  /** For element targets: false when the element wasn't on the page as loaded, so the shot is the full page. */
  found?: boolean;
  /** The steps that were replayed to reach the element, as phrases (`clicking “Remove”`). */
  replayed?: string[];
}

const injectSrc = () => {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, 'anchor-inject.global.js'), 'utf8');
};

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    throw new Error('Playwright is required for screenshots. Run: npx playwright install chromium');
  }
}

/**
 * Launch Chromium. Prefers Playwright's bundled build; falls back to a system Chrome
 * (PEANUT_GALLERY_BROWSER=/path/to/chrome, or the installed "chrome" channel) so the tool
 * works where `playwright install` can't download.
 */
async function launch() {
  const { chromium } = await loadPlaywright();
  const exe = process.env.PEANUT_GALLERY_BROWSER;
  if (exe) return chromium.launch({ executablePath: exe });
  try {
    return await chromium.launch();
  } catch (err) {
    try {
      return await chromium.launch({ channel: 'chrome' });
    } catch {
      throw new Error(`No Chromium available. Run \`npx playwright install chromium\` or set PEANUT_GALLERY_BROWSER=/path/to/chrome. (${(err as Error).message.split('\n')[0]})`);
    }
  }
}

/**
 * Screenshot each target against `baseUrl`. For anchored targets we capture a padded
 * close-up of the element with it outlined; otherwise the viewport (or full page).
 */
export async function captureShots(
  baseUrl: string,
  targets: ShotTarget[],
  outDir: string,
  opts: { width: number; height: number; fullPage: boolean; prefix: string; settleMs?: number; outlineColor?: string; replayClicks?: boolean; headers?: Record<string, string> },
): Promise<ShotResult[]> {
  mkdirSync(outDir, { recursive: true });
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: 2 });
  if (opts.headers && Object.keys(opts.headers).length) {
    // Only the site being captured gets these (e.g. a preview's protection-bypass secret), never fonts or CDNs.
    const origin = new URL(baseUrl).origin;
    const extra = opts.headers;
    await ctx.route('**/*', (route) => {
      const req = route.request();
      if (req.url().startsWith(origin + '/') || req.url() === origin) return route.continue({ headers: { ...req.headers(), ...extra } });
      return route.continue();
    });
  }
  const results: ShotResult[] = [];
  try {
    const page = await ctx.newPage();
    // Hide the widget itself if the page includes it.
    await page.addStyleTag({ content: 'peanut-gallery{display:none!important}' }).catch(() => {});
    for (const t of targets) {
      const url = joinUrl(baseUrl, t.pagePath);
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => page.goto(url, { waitUntil: 'load' }));
      await page.addStyleTag({ content: 'peanut-gallery{display:none!important}' }).catch(() => {});
      await page.waitForTimeout(opts.settleMs ?? 500);
      const file = join(outDir, `${opts.prefix}-${t.key}.png`);
      let confidence: number | undefined;
      let replayed: string[] | undefined;
      if (t.anchor) {
        await page.addScriptTag({ content: injectSrc() });
        const ensureInjected = async () => {
          if (!(await page.evaluate(() => typeof window.__peanutGallery !== 'undefined').catch(() => false))) await page.addScriptTag({ content: injectSrc() });
        };
        const first = await page.evaluate((a) => window.__peanutGallery.locate(a, false), t.anchor);
        // Not on the page as loaded (inside a modal, a menu, a tab), or reached by typing (search
        // results, a filled-in form): do what the reviewer did before leaving the note, then look again.
        const typed = t.steps?.some((st) => (st.action ?? 'click') !== 'click');
        if ((!first.rect || typed) && t.steps?.length && opts.replayClicks !== false) {
          replayed = [];
          for (const step of t.steps) {
            await ensureInjected();
            if (await replayStep(page, step)) replayed.push(stepPhrase(step));
            await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
            // Search-as-you-type usually waits a beat before fetching.
            await page.waitForTimeout((step.action ?? 'click') === 'type' ? 600 : 350);
            await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
          }
          await ensureInjected();
        }
        const loc = await page.evaluate(([a, c]) => window.__peanutGallery.locate(a, true, c), [t.anchor, opts.outlineColor] as const);
        confidence = loc.confidence;
        if (loc.rect) {
          // Pad the element so the close-up has context; ensure a sensible minimum size.
          const minW = Math.min(560, opts.width);
          const minH = Math.min(240, opts.height);
          const padX = Math.max(48, (minW - loc.rect.width) / 2);
          const padY = Math.max(48, (minH - loc.rect.height) / 2);
          const clip = {
            x: Math.max(0, loc.rect.x - padX),
            y: Math.max(0, loc.rect.y - padY),
            width: Math.min(opts.width, loc.rect.width + padX * 2),
            height: Math.min(opts.height, loc.rect.height + padY * 2),
          };
          if (clip.x + clip.width > opts.width) clip.x = Math.max(0, opts.width - clip.width);
          if (clip.y + clip.height > opts.height) clip.y = Math.max(0, opts.height - clip.height);
          clip.width = Math.min(clip.width, opts.width - clip.x);
          clip.height = Math.min(clip.height, opts.height - clip.y);
          await page.screenshot({ path: file, clip });
          await page.evaluate(() => window.__peanutGallery.clearOutlines());
          results.push({ key: t.key, label: t.label, file, confidence, found: true, ...(replayed?.length ? { replayed } : {}) });
          continue;
        }
      }
      await page.screenshot({ path: file, fullPage: opts.fullPage });
      results.push({ key: t.key, label: t.label, file, confidence, ...(t.anchor ? { found: false } : {}), ...(replayed?.length ? { replayed } : {}) });
    }
  } finally {
    await browser.close();
  }
  return results;
}

type PwPage = Awaited<ReturnType<Awaited<ReturnType<typeof launch>>['newPage']>>;

/**
 * Do one recorded step in the page. Returns false when it couldn't (element gone, or a private
 * field with no safe stand-in), so the label only lists what actually happened.
 */
export async function replayStep(page: PwPage, step: Step): Promise<boolean> {
  const action = step.action ?? 'click';
  if (action === 'click') {
    const pt = await page.evaluate((st) => window.__peanutGallery.clickPoint(st), step).catch(() => null);
    if (!pt) return false;
    await page.mouse.click(pt.x, pt.y);
    return true;
  }
  const info = await page.evaluate((st) => window.__peanutGallery.markStep(st), step).catch(() => null);
  if (!info) return false;
  const field = page.locator('[data-peanut-gallery-step]').first();
  try {
    if (action === 'type') {
      const value = step.masked || step.value === undefined ? info.standIn : step.value;
      if (value === null) return false;
      await field.fill(value, { timeout: 5_000 });
    } else if (action === 'select') {
      if (step.masked || step.value === undefined) return false;
      await field.selectOption({ label: step.value }, { timeout: 5_000 }).catch(() => field.selectOption(step.value!, { timeout: 5_000 }));
    } else if (action === 'enter') {
      await field.press('Enter', { timeout: 5_000 });
    } else return false;
    return true;
  } catch {
    return false;
  } finally {
    // Enter may have navigated away, taking the marker (and our script) with it.
    await page.evaluate(() => window.__peanutGallery?.unmarkStep()).catch(() => {});
  }
}

/** Render an HTML file to PNG (used to produce the side-by-side summary image). */
export async function renderHtmlToPng(htmlPath: string, outFile: string, width = 1400) {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 1 });
    await page.goto('file://' + htmlPath, { waitUntil: 'load' });
    await page.screenshot({ path: outFile, fullPage: true });
  } finally {
    await browser.close();
  }
}

/** Join a base (which may include a subpath) with a page path: base "https://x.io/app/" + "/checkout?x" → "https://x.io/app/checkout?x". */
export function joinUrl(baseUrl: string, pagePath: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const path = pagePath.replace(/^\/+/, '');
  return path ? `${base}/${path}` : `${base}/`;
}

declare global {
  interface Window {
    __peanutGallery: {
      locate(anchor: ElementAnchor, outline?: boolean, color?: string): { rect: { x: number; y: number; width: number; height: number } | null; confidence: number };
      clearOutlines(): void;
      clickPoint(anchor: ElementAnchor): { x: number; y: number } | null;
      markStep(anchor: ElementAnchor): { standIn: string | null } | null;
      unmarkStep(): void;
    };
  }
}

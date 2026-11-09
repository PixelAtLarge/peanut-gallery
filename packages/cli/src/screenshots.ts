import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stepLabel, type ElementAnchor } from '@pixelatlarge/peanut-gallery-core';

export interface ShotTarget {
  /** Stable key, used for filenames. */
  key: string;
  label: string;
  /** Path portion of the page (e.g. "/checkout?x=1"); joined onto the base URL. */
  pagePath: string;
  anchor?: ElementAnchor;
  /** Clicks to replay if the element isn't on the freshly loaded page (Annotation.steps). */
  steps?: ElementAnchor[];
}

export interface ShotResult {
  key: string;
  label: string;
  file: string;
  confidence?: number;
  /** For element targets: false when the element wasn't on the page as loaded, so the shot is the full page. */
  found?: boolean;
  /** Labels of the recorded clicks that were replayed to reach the element. */
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
        // Not on the page as loaded (inside a modal, a menu, a tab): click through what the
        // reviewer clicked before leaving the note, then look again.
        if (!first.rect && t.steps?.length && opts.replayClicks !== false) {
          replayed = [];
          for (const step of t.steps) {
            await ensureInjected();
            const pt = await page.evaluate((st) => window.__peanutGallery.clickPoint(st), step).catch(() => null);
            if (!pt) continue;
            await page.mouse.click(pt.x, pt.y);
            replayed.push(stepLabel(step));
            await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
            await page.waitForTimeout(350);
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
    };
  }
}

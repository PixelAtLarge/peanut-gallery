import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElementAnchor } from '@peanut-gallery/core';

export interface ShotTarget {
  /** Stable key, used for filenames. */
  key: string;
  label: string;
  /** Path portion of the page (e.g. "/checkout?x=1"); joined onto the base URL. */
  pagePath: string;
  anchor?: ElementAnchor;
}

export interface ShotResult {
  key: string;
  label: string;
  file: string;
  confidence?: number;
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
  opts: { width: number; height: number; fullPage: boolean; prefix: string; settleMs?: number; outlineColor?: string },
): Promise<ShotResult[]> {
  mkdirSync(outDir, { recursive: true });
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: 2 });
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
      if (t.anchor) {
        await page.addScriptTag({ content: injectSrc() });
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
          results.push({ key: t.key, label: t.label, file, confidence });
          continue;
        }
      }
      await page.screenshot({ path: file, fullPage: opts.fullPage });
      results.push({ key: t.key, label: t.label, file, confidence });
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
    };
  }
}

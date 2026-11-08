import { resolveAnchor, type ElementAnchor } from '@pixelatlarge/peanut-gallery-core';

declare global {
  interface Window {
    __peanutGallery: {
      /** Resolve an anchor and return its viewport rect + confidence, optionally outlining it. */
      locate(anchor: ElementAnchor, outline?: boolean, color?: string): { rect: { x: number; y: number; width: number; height: number } | null; confidence: number };
      clearOutlines(): void;
    };
  }
}

window.__peanutGallery = {
  locate(anchor, outline = false, color = '#EAC26C') {
    const { el, confidence } = resolveAnchor(anchor, document);
    // Below 0.4 the resolver is only guessing from the stored position (the element isn't on
    // the page as loaded, e.g. it lives in a modal). Don't crop or outline a stand-in.
    if (!el || confidence < 0.4) return { rect: null, confidence };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (outline) {
      (el as HTMLElement).dataset.peanutGalleryOutline = '1';
      (el as HTMLElement).style.outline = `3px solid ${color}`;
      (el as HTMLElement).style.outlineOffset = '2px';
    }
    return { rect: { x: r.left, y: r.top, width: r.width, height: r.height }, confidence };
  },
  clearOutlines() {
    document.querySelectorAll<HTMLElement>('[data-peanut-gallery-outline]').forEach((e) => {
      e.style.outline = '';
      e.style.outlineOffset = '';
      delete e.dataset.peanutGalleryOutline;
    });
  },
};

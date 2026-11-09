import { resolveAnchor, standInValue, type ElementAnchor } from '@pixelatlarge/peanut-gallery-core';

declare global {
  interface Window {
    __peanutGallery: {
      /** Resolve an anchor and return its viewport rect + confidence, optionally outlining it. */
      locate(anchor: ElementAnchor, outline?: boolean, color?: string): { rect: { x: number; y: number; width: number; height: number } | null; confidence: number };
      clearOutlines(): void;
      /** Center of a recorded click target, scrolled into view, or null if it isn't there. */
      clickPoint(anchor: ElementAnchor): { x: number; y: number } | null;
      /** Tag a recorded field so Playwright can type into it; null if it isn't there. */
      markStep(anchor: ElementAnchor): { standIn: string | null } | null;
      unmarkStep(): void;
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
  clickPoint(anchor) {
    const { el, confidence } = resolveAnchor(anchor, document);
    if (!el || confidence < 0.4) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: r.left + r.width * (anchor.offset?.x ?? 0.5), y: r.top + r.height * (anchor.offset?.y ?? 0.5) };
  },
  markStep(anchor) {
    window.__peanutGallery.unmarkStep();
    const { el, confidence } = resolveAnchor(anchor, document);
    if (!el || confidence < 0.4) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.setAttribute('data-peanut-gallery-step', '');
    return { standIn: standInValue(el) };
  },
  unmarkStep() {
    document.querySelectorAll('[data-peanut-gallery-step]').forEach((e) => e.removeAttribute('data-peanut-gallery-step'));
  },
  clearOutlines() {
    document.querySelectorAll<HTMLElement>('[data-peanut-gallery-outline]').forEach((e) => {
      e.style.outline = '';
      e.style.outlineOffset = '';
      delete e.dataset.peanutGalleryOutline;
    });
  },
};

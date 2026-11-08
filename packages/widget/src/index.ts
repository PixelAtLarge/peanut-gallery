import { PeanutGalleryWidget, type PeanutGalleryConfig } from './widget.js';

export { PeanutGalleryWidget, type PeanutGalleryConfig };
export type { Annotation, AnnotationKind, ReviewSession } from '@pixelatlarge/peanut-gallery-core';

let instance: PeanutGalleryWidget | null = null;

/** Initialize (idempotent). Returns the widget instance. */
export function init(config: PeanutGalleryConfig): PeanutGalleryWidget {
  if (instance) return instance;
  instance = new PeanutGalleryWidget(config);
  const mount = () => instance!.mount();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
  return instance;
}

export function destroy() {
  instance?.destroy();
  instance = null;
}

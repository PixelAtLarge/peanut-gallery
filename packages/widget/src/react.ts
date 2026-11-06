import { useEffect } from 'react';
import { init, destroy, type PeanutGalleryConfig } from './index.js';

/**
 * <PeanutGallery repo="owner/name" />
 * Mounts the annotation layer while the component is rendered.
 * Typically gated: {import.meta.env.VITE_PEANUT_GALLERY && <PeanutGallery repo="..." />}
 */
export function PeanutGallery(props: PeanutGalleryConfig): null {
  const key = JSON.stringify(props);
  useEffect(() => {
    init(props);
    return () => destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return null;
}

export { init, destroy };
export type { PeanutGalleryConfig };

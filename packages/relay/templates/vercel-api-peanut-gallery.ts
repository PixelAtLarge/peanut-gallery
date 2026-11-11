// Vercel: copy to api/peanut-gallery.ts. Set env PEANUT_GALLERY_TOKEN, PEANUT_GALLERY_REPO, PEANUT_GALLERY_ORIGINS, PEANUT_GALLERY_KEY, and PEANUT_GALLERY_SHARE_NOTES=true to let reviewers see each other's notes.
import { createRelayHandler } from '@pixelatlarge/peanut-gallery-relay';

export const config = { runtime: 'edge' };

const handle = createRelayHandler({
  githubToken: process.env.PEANUT_GALLERY_TOKEN!,
  repo: process.env.PEANUT_GALLERY_REPO!,
  allowedOrigins: process.env.PEANUT_GALLERY_ORIGINS?.split(','),
  sharedKey: process.env.PEANUT_GALLERY_KEY,
  shareNotes: process.env.PEANUT_GALLERY_SHARE_NOTES === 'true', // reviewers see each other's notes
});

export default handle;

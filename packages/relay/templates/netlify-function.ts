// Netlify Functions v2: copy to netlify/functions/peanut-gallery.ts
import { createRelayHandler } from '@pixelatlarge/peanut-gallery-relay';

const handle = createRelayHandler({
  githubToken: process.env.PEANUT_GALLERY_TOKEN!,
  repo: process.env.PEANUT_GALLERY_REPO!,
  allowedOrigins: process.env.PEANUT_GALLERY_ORIGINS?.split(','),
  sharedKey: process.env.PEANUT_GALLERY_KEY,
  shareNotes: process.env.PEANUT_GALLERY_SHARE_NOTES === 'true', // reviewers see each other's notes
});

export default async (req: Request) => handle(req);

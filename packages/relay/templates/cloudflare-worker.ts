// Cloudflare Workers: `wrangler secret put PEANUT_GALLERY_TOKEN`, set PEANUT_GALLERY_REPO etc. as vars.
import { createRelayHandler } from '@pixelatlarge/peanut-gallery-relay';

interface Env { PEANUT_GALLERY_TOKEN: string; PEANUT_GALLERY_REPO: string; PEANUT_GALLERY_ORIGINS?: string; PEANUT_GALLERY_KEY?: string; PEANUT_GALLERY_SHARE_NOTES?: string }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const handle = createRelayHandler({
      githubToken: env.PEANUT_GALLERY_TOKEN,
      repo: env.PEANUT_GALLERY_REPO,
      allowedOrigins: env.PEANUT_GALLERY_ORIGINS?.split(','),
      sharedKey: env.PEANUT_GALLERY_KEY,
      shareNotes: env.PEANUT_GALLERY_SHARE_NOTES === 'true', // reviewers see each other's notes
    });
    return handle(request);
  },
};

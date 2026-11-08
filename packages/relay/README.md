# @pixelatlarge/peanut-gallery-relay

A tiny serverless function that turns [Peanut Gallery](https://github.com/PixelAtLarge/peanut-gallery) widget submissions into GitHub issues, so reviewers don't need a GitHub account. It validates the payload, checks the origin and creates the issue with your token. The token never reaches the browser.

```ts
// api/peanut-gallery.ts (Vercel)
import { createRelayHandler } from '@pixelatlarge/peanut-gallery-relay';

export default createRelayHandler({
  githubToken: process.env.PEANUT_GALLERY_TOKEN!, // fine-grained token: Issues read/write on one repo
  repo: process.env.PEANUT_GALLERY_REPO!,
  allowedOrigins: ['https://proto.example.com'],
});
```

Templates for Cloudflare Workers, Netlify Functions and plain Node are in `templates/`. Then set `data-relay-url` on the widget.

MIT licensed.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRelayHandler, type RelayOptions } from './index.js';

/** Adapt the web handler to Node's http module (Express-compatible signature). */
export function createNodeHandler(opts: RelayOptions) {
  const handle = createRelayHandler(opts);
  return async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const request = new Request(url, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
    });
    const response = await handle(request);
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}

/** Standalone server: `PEANUT_GALLERY_TOKEN=... PEANUT_GALLERY_REPO=owner/name node -e "..."` */
export function serve(opts: RelayOptions & { port?: number }) {
  const server = createServer(createNodeHandler(opts));
  const port = opts.port ?? Number(process.env.PORT ?? 8787);
  server.listen(port, () => console.log(`peanut-gallery relay listening on :${port} → ${opts.repo}`));
  return server;
}

export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): RelayOptions {
  const githubToken = env.PEANUT_GALLERY_TOKEN ?? env.GITHUB_TOKEN ?? '';
  const repo = env.PEANUT_GALLERY_REPO ?? '';
  return {
    githubToken,
    repo,
    allowedOrigins: env.PEANUT_GALLERY_ORIGINS?.split(',').map((s) => s.trim()),
    sharedKey: env.PEANUT_GALLERY_KEY,
  };
}

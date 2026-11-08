import { describe, it, expect, vi } from 'vitest';
import { createRelayHandler } from './index.js';

const session = {
  id: 'rs_1',
  prototypeUrl: 'https://proto.example.com',
  createdAt: '2026-11-05T00:00:00.000Z',
  annotations: [
    {
      id: 'an_1',
      text: 'Too small',
      pageUrl: 'https://proto.example.com/',
      viewport: { width: 1, height: 1 },
      createdAt: '2026-11-05T00:00:00.000Z',
      anchor: { selector: 'button', textFingerprint: 'Pay', tag: 'button', rect: { x: 0, y: 0, width: 1, height: 1 }, offset: { x: 0.5, y: 0.5 } },
    },
  ],
};

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://relay.test/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://proto.example.com', ...headers },
    body: JSON.stringify(body),
  });
}

describe('relay', () => {
  it('creates an issue and returns its URL', async () => {
    const f = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.github.com/repos/owner/repo/issues');
      const sent = JSON.parse(init.body as string);
      expect(sent.labels).toEqual(['peanut-gallery', 'peanut-gallery:feedback']);
      expect(sent.body).toContain('Too small');
      return new Response(JSON.stringify({ html_url: 'https://github.com/owner/repo/issues/7', number: 7 }), { status: 201 });
    });
    const handle = createRelayHandler({ githubToken: 't', repo: 'owner/repo', fetch: f as unknown as typeof fetch });
    const res = await handle(post({ session }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ issueUrl: 'https://github.com/owner/repo/issues/7', issueNumber: 7 });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('enforces origin allowlist, shared key and payload shape', async () => {
    const f = vi.fn();
    const handle = createRelayHandler({
      githubToken: 't',
      repo: 'owner/repo',
      allowedOrigins: ['https://proto.example.com'],
      sharedKey: 's3cret',
      fetch: f as unknown as typeof fetch,
    });
    expect((await handle(post({ session }, { origin: 'https://evil.example' }))).status).toBe(403);
    expect((await handle(post({ session }))).status).toBe(401);
    expect((await handle(post({ session: { ...session, annotations: [] } }, { 'x-peanut-gallery-key': 's3cret' }))).status).toBe(400);
    expect(f).not.toHaveBeenCalled();
    const pre = await handle(new Request('https://relay.test/', { method: 'OPTIONS', headers: { origin: 'https://proto.example.com' } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://proto.example.com');
  });
});

describe('relay as a public endpoint', () => {
  const ok = () =>
    vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ html_url: 'https://github.com/o/r/issues/9', number: 9 }), { status: 201 }));
  const make = (f: ReturnType<typeof ok> | typeof fetch, extra = {}) =>
    createRelayHandler({ githubToken: 't', repo: 'o/r', allowedOrigins: ['https://proto.example.com'], fetch: f as typeof fetch, ...extra });

  it('answers junk bodies with 400, never an unhandled error', async () => {
    const h = make(ok());
    for (const body of [null, 42, 'x', [], { session: null }, { session: { ...session, annotations: [null] } }, { session: { ...session, annotations: [{ ...session.annotations[0], viewport: 'big' }] } }, { session: { ...session, annotations: [{ ...session.annotations[0], steps: 'click' }] } }, { session: { ...session, annotations: [{ ...session.annotations[0], steps: [{ selector: 1 }] }] } }]) {
      const res = await h(post(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('accepts a note without a viewport (it is optional in practice)', async () => {
    const f = ok();
    const { viewport: _v, ...note } = session.annotations[0];
    const res = await make(f)(post({ session: { ...session, annotations: [note] } }));
    expect(res.status).toBe(201);
    expect(JSON.parse(f.mock.calls[0][1].body as string).body).not.toContain('Viewport');
  });

  it("drops labels the client isn't allowed to set", async () => {
    const f = ok();
    await make(f, { allowedLabels: ['design-review'] })(post({ session, labels: ['peanut-gallery:accepted', 'spam', 'design-review', 7] }));
    expect(JSON.parse(f.mock.calls[0][1].body as string).labels).toEqual(['peanut-gallery', 'peanut-gallery:feedback', 'design-review']);
    const g = ok();
    await make(g)(post({ session, labels: 'peanut-gallery:accepted' }));
    expect(JSON.parse(g.mock.calls[0][1].body as string).labels).toEqual(['peanut-gallery', 'peanut-gallery:feedback']);
  });

  it('reports a network failure to GitHub as 502', async () => {
    const res = await make((async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch)(post({ session }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'could not reach GitHub' });
  });
});

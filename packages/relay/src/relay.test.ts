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

describe('relay steps', () => {
  it('accepts typing steps and rejects a private field that carries a value', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ html_url: 'https://github.com/owner/repo/issues/8', number: 8 }), { status: 201 }));
    const handle = createRelayHandler({ githubToken: 't', repo: 'owner/repo', fetch: f as unknown as typeof fetch });
    const withSteps = (steps: unknown[]) => ({ session: { ...session, annotations: session.annotations.map((a) => ({ ...a, steps })) } });
    const anchor = session.annotations[0].anchor;
    expect((await handle(post(withSteps([{ ...anchor, action: 'type', value: 'lamp', field: 'Search' }, { ...anchor, action: 'enter' }])))).status).toBe(201);
    expect((await handle(post(withSteps([{ ...anchor, action: 'type', masked: true }])))).status).toBe(201);
    expect((await handle(post(withSteps([{ ...anchor, action: 'type', masked: true, value: 'hunter2' }])))).status).toBe(400);
    expect((await handle(post(withSteps([{ ...anchor, action: 'hover' }])))).status).toBe(400);
    expect((await handle(post(withSteps([{ ...anchor, action: 'type', value: 'x'.repeat(501) }])))).status).toBe(400);
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

describe('shared notes', () => {
  /** A fake GitHub: open feedback issues, plus whatever the relay creates. */
  async function github() {
    const { sessionToIssue } = await import('@pixelatlarge/peanut-gallery-core');
    const other = { ...session, author: 'sam', annotations: [{ ...session.annotations[0], id: 'an_other', text: 'Make it green', author: 'sam' }] };
    const elsewhere = { ...session, prototypeUrl: 'https://other.example.com', annotations: [{ ...session.annotations[0], id: 'an_x', pageUrl: 'https://other.example.com/' }] };
    const issues: { number: number; html_url: string; body: string; pull_request?: unknown }[] = [
      { number: 7, html_url: 'https://github.com/owner/repo/issues/7', body: sessionToIssue(other).body },
      { number: 8, html_url: 'https://github.com/owner/repo/issues/8', body: sessionToIssue(elsewhere).body },
      { number: 9, html_url: 'https://github.com/owner/repo/pull/9', body: sessionToIssue(other).body, pull_request: {} },
      { number: 10, html_url: 'https://github.com/owner/repo/issues/10', body: 'not ours' },
    ];
    const calls: string[] = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (init?.method === 'POST') {
        const { body } = JSON.parse(String(init.body));
        const n = 11 + issues.length;
        issues.unshift({ number: n, html_url: `https://github.com/owner/repo/issues/${n}`, body });
        return new Response(JSON.stringify({ html_url: `https://github.com/owner/repo/issues/${n}`, number: n }), { status: 201 });
      }
      return new Response(JSON.stringify(issues), { status: 200 });
    });
    return { f, calls };
  }
  const get = (headers: Record<string, string> = { origin: 'https://proto.example.com' }, q = '') => new Request(`https://relay.test/${q}`, { method: 'GET', headers });

  it('is off unless shareNotes is set', async () => {
    const { f } = await github();
    const handle = createRelayHandler({ githubToken: 't', repo: 'owner/repo', fetch: f as unknown as typeof fetch });
    expect((await handle(get())).status).toBe(404);
    expect(f).not.toHaveBeenCalled();
  });

  it("returns this site's notes from open feedback issues, not pull requests or other sites", async () => {
    const { f, calls } = await github();
    const handle = createRelayHandler({ githubToken: 't', repo: 'owner/repo', shareNotes: true, fetch: f as unknown as typeof fetch });
    const res = await handle(get());
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const { notes } = (await res.json()) as { notes: { id: string; author?: string; issueNumber: number; issueUrl: string; text: string }[] };
    expect(notes.map((n) => [n.id, n.author, n.issueNumber, n.issueUrl])).toEqual([['an_other', 'sam', 7, 'https://github.com/owner/repo/issues/7']]);
    expect(calls[0]).toBe('GET https://api.github.com/repos/owner/repo/issues?state=open&labels=peanut-gallery%2Cpeanut-gallery%3Afeedback&per_page=100&page=1');
    // No steps or viewport in what's shared.
    expect(Object.keys(notes[0]).sort()).toEqual(['anchor', 'author', 'createdAt', 'id', 'issueNumber', 'issueUrl', 'pageUrl', 'text']);
    // A client without an Origin header says which site.
    const q = (await (await handle(get({}, '?origin=https://other.example.com'))).json()) as { notes: { id: string }[] };
    expect(q.notes.map((n) => n.id)).toEqual(['an_x']);
  });

  it('caches, and a new submission shows up for the next reviewer', async () => {
    const { f, calls } = await github();
    const handle = createRelayHandler({ githubToken: 't', repo: 'owner/repo', shareNotes: true, notesCacheSeconds: 0.05, fetch: f as unknown as typeof fetch });
    await Promise.all([handle(get()), handle(get()), handle(get())]);
    expect(calls.filter((c) => c.startsWith('GET'))).toHaveLength(1);
    await handle(get());
    expect(calls.filter((c) => c.startsWith('GET'))).toHaveLength(1);
    expect((await handle(post({ session }))).status).toBe(201);
    let { notes } = (await (await handle(get())).json()) as { notes: { id: string }[] };
    expect(notes.map((n) => n.id).sort()).toEqual(['an_1', 'an_other']);
    // Once GitHub's list has it, it's there once, not twice.
    await new Promise((r) => setTimeout(r, 80));
    ({ notes } = (await (await handle(get())).json()) as { notes: { id: string }[] });
    expect(notes.map((n) => n.id).sort()).toEqual(['an_1', 'an_other']);
    expect(calls.filter((c) => c.startsWith('GET'))).toHaveLength(2);
  });

  it("shares a new submission straight away, even before GitHub's issue list includes it", async () => {
    const { f, calls } = await github();
    // GitHub's list lags: it never shows the new issue here.
    const lagging = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return f(url, init);
      const res = await f(url, init);
      const list = (await res.json()) as { number: number }[];
      return new Response(JSON.stringify(list.filter((i) => i.number < 11)), { status: 200 });
    });
    const handle = createRelayHandler({ githubToken: 't', repo: 'owner/repo', shareNotes: true, fetch: lagging as unknown as typeof fetch });
    await handle(get());
    expect((await handle(post({ session: { ...session, author: 'anna' } }))).status).toBe(201);
    const { notes } = (await (await handle(get())).json()) as { notes: { id: string; author?: string; issueNumber: number }[] };
    expect(notes.map((n) => [n.id, n.author])).toEqual([['an_other', 'sam'], ['an_1', 'anna']]);
    expect(calls.filter((c) => c.startsWith('GET'))).toHaveLength(1);
  });

  it('keeps the same gates as submitting: allowed origins and the shared key', async () => {
    const { f } = await github();
    const handle = createRelayHandler({ githubToken: 't', repo: 'owner/repo', shareNotes: true, allowedOrigins: ['https://proto.example.com'], sharedKey: 'k', fetch: f as unknown as typeof fetch });
    expect((await handle(get({ origin: 'https://evil.example.com', 'x-peanut-gallery-key': 'k' }))).status).toBe(403);
    expect((await handle(get({ origin: 'https://proto.example.com' }))).status).toBe(401);
    expect((await handle(get({ origin: 'https://proto.example.com', 'x-peanut-gallery-key': 'k' }))).status).toBe(200);
    const pre = await handle(new Request('https://relay.test/', { method: 'OPTIONS', headers: { origin: 'https://proto.example.com' } }));
    expect(pre.headers.get('access-control-allow-methods')).toContain('GET');
  });

  it('says so when GitHub fails', async () => {
    const handle = createRelayHandler({ githubToken: 't', repo: 'owner/repo', shareNotes: true, fetch: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch });
    expect((await handle(get())).status).toBe(502);
  });
});

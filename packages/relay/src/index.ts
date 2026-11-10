import { sessionToIssue, LABELS, type ReviewSession } from '@pixelatlarge/peanut-gallery-core';

export interface RelayOptions {
  /** Fine-grained PAT or GitHub App installation token with Issues: write on the repo. */
  githubToken: string;
  /** "owner/name". The relay only ever writes to this repo. */
  repo: string;
  /** Origins allowed to call the relay (the hosted prototype). "*" allows any. */
  allowedOrigins?: string[];
  /** Optional shared secret; widget must send `x-peanut-gallery-key`. Use when the prototype is public. */
  sharedKey?: string;
  /** Labels always applied. Defaults to peanut-gallery + peanut-gallery:feedback. */
  labels?: string[];
  /**
   * Extra labels a submission may ask for (the widget's `labels` option). Anything else the
   * client sends is dropped, so the public endpoint can't set workflow labels such as
   * peanut-gallery:accepted or create junk labels. Default: none beyond `labels`.
   */
  allowedLabels?: string[];
  /** Max annotations accepted in one submission. */
  maxAnnotations?: number;
  /** Override fetch (tests). */
  fetch?: typeof fetch;
  /** GitHub API base (GHES). */
  apiBase?: string;
}

export interface RelayResult {
  issueUrl: string;
  issueNumber: number;
}

/**
 * Returns a Web-standard `(request: Request) => Promise<Response>` handler.
 * Works as-is on Cloudflare Workers, Vercel Edge/Node (web runtime), Deno, Bun, Netlify.
 * For Node's http module, see `@pixelatlarge/peanut-gallery-relay/node`.
 */
export function createRelayHandler(opts: RelayOptions) {
  if (!opts.githubToken) throw new Error('relay: githubToken is required');
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new Error('relay: repo must be "owner/name"');
  const f = opts.fetch ?? fetch;
  const apiBase = (opts.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
  const allowed = opts.allowedOrigins ?? ['*'];
  const max = opts.maxAnnotations ?? 100;

  const cors = (origin: string | null) => {
    const ok = allowed.includes('*') || (origin !== null && allowed.includes(origin));
    return {
      ok,
      headers: {
        'access-control-allow-origin': ok ? (allowed.includes('*') ? '*' : origin!) : 'null',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type, x-peanut-gallery-key',
        'access-control-max-age': '86400',
        vary: 'origin',
      },
    };
  };

  const baseLabels = opts.labels ?? [LABELS.root, LABELS.feedback];
  const permitted = new Set([...baseLabels, ...(opts.allowedLabels ?? [])]);

  return async function handle(req: Request): Promise<Response> {
    try {
      return await handleInner(req);
    } catch (err) {
      // Never let a bad request escape as an unhandled error from a public endpoint.
      const c = cors(req.headers.get('origin'));
      return new Response(JSON.stringify({ error: 'relay error', detail: String((err as Error)?.message ?? err).slice(0, 200) }), {
        status: 500,
        headers: { 'content-type': 'application/json', ...c.headers },
      });
    }
  };

  async function handleInner(req: Request): Promise<Response> {
    const origin = req.headers.get('origin');
    const c = cors(origin);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...c.headers } });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: c.headers });
    if (req.method !== 'POST') return json(405, { error: 'method not allowed' });
    if (!c.ok) return json(403, { error: 'origin not allowed' });
    if (opts.sharedKey && req.headers.get('x-peanut-gallery-key') !== opts.sharedKey) return json(401, { error: 'bad key' });

    let payload: { session?: ReviewSession; labels?: unknown };
    try {
      payload = await req.json();
    } catch {
      return json(400, { error: 'invalid json' });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return json(400, { error: 'expected a JSON object' });
    const session = payload.session;
    const problem = validate(session, max);
    if (problem) return json(400, { error: problem });

    const { title, body } = sessionToIssue(session!);
    const asked = Array.isArray(payload.labels) ? payload.labels.filter((l): l is string => typeof l === 'string') : [];
    const labels = Array.from(new Set([...baseLabels, ...asked.filter((l) => permitted.has(l))]));

    let res: Response;
    try {
      res = await f(`${apiBase}/repos/${opts.repo}/issues`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.githubToken}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'peanut-gallery-relay',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ title, body, labels }),
      });
    } catch (err) {
      return json(502, { error: 'could not reach GitHub', detail: String((err as Error)?.message ?? err).slice(0, 200) });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return json(502, { error: `github ${res.status}`, detail: text.slice(0, 500) });
    }
    const issue = (await res.json()) as { html_url: string; number: number };
    const result: RelayResult = { issueUrl: issue.html_url, issueNumber: issue.number };
    return json(201, result);
  }
}

const STEP_ACTIONS = new Set(['click', 'type', 'select', 'enter']);

function badStep(st: unknown): boolean {
  if (!st || typeof st !== 'object') return true;
  const x = st as { selector?: unknown; action?: unknown; value?: unknown; field?: unknown; masked?: unknown };
  if (typeof x.selector !== 'string' || x.selector.length > 2000) return true;
  if (x.action !== undefined && !STEP_ACTIONS.has(x.action as string)) return true;
  if (x.value !== undefined && (typeof x.value !== 'string' || x.value.length > 500)) return true;
  if (x.field !== undefined && (typeof x.field !== 'string' || x.field.length > 200)) return true;
  // A masked step carries no value: the widget never sends what was typed into a private field.
  if (x.masked !== undefined && (x.masked !== true || x.value !== undefined)) return true;
  return false;
}

function validate(s: ReviewSession | undefined, max: number): string | null {
  if (!s || typeof s !== 'object') return 'missing session';
  if (typeof s.id !== 'string' || typeof s.prototypeUrl !== 'string') return 'malformed session';
  if (!Array.isArray(s.annotations) || s.annotations.length === 0) return 'no annotations';
  if (s.annotations.length > max) return `too many annotations (max ${max})`;
  for (const a of s.annotations) {
    if (!a || typeof a !== 'object') return 'annotation invalid';
    if (typeof a.text !== 'string' || a.text.length === 0 || a.text.length > 5000) return 'annotation text invalid';
    if (!a.anchor || typeof a.anchor.selector !== 'string' || a.anchor.selector.length > 2000) return 'anchor invalid';
    if (typeof a.pageUrl !== 'string' || a.pageUrl.length > 2000) return 'pageUrl invalid';
    if (a.steps !== undefined && (!Array.isArray(a.steps) || a.steps.length > 10 || a.steps.some(badStep))) return 'steps invalid';
    if (a.viewport !== undefined && (typeof a.viewport !== 'object' || !Number.isFinite(a.viewport?.width) || !Number.isFinite(a.viewport?.height))) return 'viewport invalid';
  }
  return null;
}

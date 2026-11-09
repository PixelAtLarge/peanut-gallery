import { ghJson } from './github.js';

/**
 * Screenshots from preview deployments (Vercel, Netlify, Cloudflare Pages, Render…) instead of a
 * local dev server. Hosts that integrate with GitHub report each preview as a GitHub deployment
 * with its URL, so by default we wait for the deployment of the pushed commit. For hosts that
 * don't, `url` is a pattern such as "https://deploy-preview-{pr}--mysite.netlify.app".
 */
export interface PreviewConfig {
  /** Turn previews off without deleting the block. Default true when the block is present. */
  enabled?: boolean;
  /** URL pattern instead of GitHub deployments: {pr}, {branch}, {branchSlug}, {sha}, {shortSha}. */
  url?: string;
  /** Only use deployments whose environment matches this (case-insensitive substring or /regex/), e.g. "Preview". */
  environment?: string;
  /** How long to wait for the preview, in seconds. Default 600. */
  timeoutSeconds?: number;
  /**
   * Headers sent to the preview (and only to it), e.g. Vercel's protection bypass:
   * { "x-vercel-protection-bypass": "${VERCEL_AUTOMATION_BYPASS_SECRET}", "x-vercel-set-bypass-cookie": "true" }.
   * ${NAME} is read from the environment, so secrets stay out of the config file.
   */
  headers?: Record<string, string>;
  /**
   * Where "before" comes from: "production" (default: prototypeUrl if set, else the deployment of
   * the base branch's latest commit, else the local dev server), or "local" (always the local dev server).
   */
  before?: 'production' | 'local';
}

export interface Deployment {
  id: number;
  environment: string;
  created_at: string;
  sha?: string;
}

export interface DeploymentStatus {
  state: string; // success | failure | error | inactive | in_progress | queued | pending
  environment_url?: string;
  target_url?: string;
  created_at?: string;
}

export function previewEnabled(p: PreviewConfig | boolean | undefined): p is PreviewConfig | true {
  if (!p) return false;
  return p === true || p.enabled !== false;
}

export function normalizePreview(p: PreviewConfig | boolean | undefined): PreviewConfig {
  return p === true || !p ? {} : p;
}

export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);

/** Fill a preview URL pattern. */
export function expandUrlTemplate(tpl: string, v: { pr?: number; branch: string; sha: string }): string {
  return tpl
    .replace(/\{pr\}/g, v.pr ? String(v.pr) : '')
    .replace(/\{branchSlug\}/g, slugify(v.branch))
    .replace(/\{branch\}/g, encodeURIComponent(v.branch))
    .replace(/\{shortSha\}/g, v.sha.slice(0, 7))
    .replace(/\{sha\}/g, v.sha);
}

/** Resolve ${NAME} in header values from the environment. Headers whose variable is unset are dropped (and named in `missing`). */
export function expandHeaders(headers: Record<string, string> | undefined, env: Record<string, string | undefined> = process.env): { headers: Record<string, string>; missing: string[] } {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const [k, v] of Object.entries(headers ?? {})) {
    let ok = true;
    const value = v.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => {
      const x = env[name];
      if (x === undefined || x === '') {
        ok = false;
        missing.push(name);
        return '';
      }
      return x;
    });
    if (ok) out[k] = value;
  }
  return { headers: out, missing };
}

function envMatches(environment: string, filter?: string): boolean {
  if (!filter) return true;
  const re = /^\/(.+)\/([a-z]*)$/.exec(filter);
  if (re) return new RegExp(re[1], re[2] || 'i').test(environment);
  return environment.toLowerCase().includes(filter.toLowerCase());
}

export type PreviewState = { state: 'ready'; url: string; environment: string } | { state: 'failed'; environment: string; detail?: string } | { state: 'pending' } | { state: 'none' };

/**
 * Pick the preview URL from a commit's deployments and their statuses (newest status first per
 * deployment, as GitHub returns them). Pure, for tests.
 */
export function pickDeployment(deployments: Deployment[], statuses: Record<number, DeploymentStatus[]>, filter?: string, exclude?: RegExp): PreviewState {
  const candidates = deployments
    .filter((d) => envMatches(d.environment, filter) && !(exclude && exclude.test(d.environment)))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (!candidates.length) return { state: 'none' };
  let pending = false;
  let failed: PreviewState | null = null;
  for (const d of candidates) {
    const latest = statuses[d.id]?.[0];
    if (!latest) {
      pending = true;
      continue;
    }
    const url = latest.environment_url || latest.target_url;
    if (latest.state === 'success') {
      if (url && /^https?:\/\//.test(url)) return { state: 'ready', url, environment: d.environment };
      continue; // finished but no site URL: not a preview (some other tool's deployment)
    }
    if (latest.state === 'failure' || latest.state === 'error') failed ??= { state: 'failed', environment: d.environment, detail: latest.target_url };
    else if (latest.state !== 'inactive') pending = true;
  }
  if (pending) return { state: 'pending' };
  return failed ?? { state: 'none' };
}

export async function deploymentState(repo: string, sha: string, filter?: string, exclude?: RegExp): Promise<PreviewState> {
  const deployments = await ghJson<Deployment[]>(['api', `repos/${repo}/deployments?sha=${sha}&per_page=30`]);
  const statuses: Record<number, DeploymentStatus[]> = {};
  for (const d of deployments.filter((x) => envMatches(x.environment, filter))) {
    statuses[d.id] = await ghJson<DeploymentStatus[]>(['api', `repos/${repo}/deployments/${d.id}/statuses?per_page=5`]).catch(() => []);
  }
  return pickDeployment(deployments, statuses, filter, exclude);
}

async function urlIsUp(url: string, headers: Record<string, string>): Promise<boolean> {
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    return res.status < 400;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for the preview of `sha` (or the URL pattern) to be up. Returns its URL, or a reason it isn't available. */
export async function waitForPreview(opts: {
  repo: string;
  sha: string;
  branch: string;
  pr?: number;
  preview: PreviewConfig;
  headers: Record<string, string>;
  log?: (s: string) => void;
  pollMs?: number;
}): Promise<{ url: string; source: string } | { error: string }> {
  const timeout = (opts.preview.timeoutSeconds ?? 600) * 1000;
  const poll = opts.pollMs ?? 10_000;
  const end = Date.now() + timeout;
  const pattern = opts.preview.url ? expandUrlTemplate(opts.preview.url, { pr: opts.pr, branch: opts.branch, sha: opts.sha }) : null;
  let said = false;
  for (;;) {
    if (pattern) {
      if (await urlIsUp(pattern, opts.headers)) return { url: pattern, source: 'URL pattern' };
    } else {
      const s = await deploymentState(opts.repo, opts.sha, opts.preview.environment).catch((err) => ({ state: 'error' as const, message: (err as Error).message }));
      if (s.state === 'ready') {
        // The host can mark a deployment ready a moment before it answers.
        if (await urlIsUp(s.url, opts.headers)) return { url: s.url, source: `deployment "${s.environment}"` };
      } else if (s.state === 'failed') {
        return { error: `the preview deployment "${s.environment}" failed${s.detail ? ` (${s.detail})` : ''}` };
      } else if (s.state === 'error') {
        const forbidden = /403|not accessible/i.test(s.message);
        return {
          error: forbidden
            ? "couldn't read deployments: the GitHub token isn't allowed to (in GitHub Actions, add `deployments: read` to the workflow's permissions)"
            : `couldn't read deployments: ${s.message.split('\n')[0]}`,
        };
      }
    }
    if (Date.now() >= end) {
      return { error: pattern ? `${pattern} didn't come up within ${Math.round(timeout / 1000)}s` : `no preview deployment for ${opts.sha.slice(0, 7)} within ${Math.round(timeout / 1000)}s (does your host report deployments to GitHub? if not, set preview.url)` };
    }
    if (!said) {
      opts.log?.(pattern ? `waiting for ${pattern}…` : `waiting for the preview deployment of ${opts.sha.slice(0, 7)}…`);
      said = true;
    }
    await sleep(poll);
  }
}

/** URL of the latest successful non-preview deployment of `sha` (production), if any. */
export async function productionUrl(repo: string, sha: string): Promise<string | null> {
  const s = await deploymentState(repo, sha, undefined, /preview|branch|pr-?\d+|deploy-preview/i).catch(() => null);
  return s?.state === 'ready' ? s.url : null;
}

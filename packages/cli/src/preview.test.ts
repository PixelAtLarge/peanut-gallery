import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { expandHeaders, expandUrlTemplate, pickDeployment, previewEnabled, slugify, waitForPreview } from './preview.js';

describe('preview deployments', () => {
  it('fills URL patterns', () => {
    const v = { pr: 42, branch: 'peanut-gallery/Make-Pay_primary', sha: 'abcdef1234567890' };
    expect(expandUrlTemplate('https://deploy-preview-{pr}--site.netlify.app', v)).toBe('https://deploy-preview-42--site.netlify.app');
    expect(expandUrlTemplate('https://{branchSlug}.site.pages.dev', v)).toBe('https://peanut-gallery-make-pay-primary.site.pages.dev');
    expect(expandUrlTemplate('https://x.dev/{shortSha}/{sha}', v)).toBe('https://x.dev/abcdef1/abcdef1234567890');
    expect(slugify('A'.repeat(80))).toHaveLength(63);
  });

  it('reads header secrets from the environment and drops headers whose secret is missing', () => {
    const r = expandHeaders({ 'x-vercel-protection-bypass': '${BYPASS}', 'x-vercel-set-bypass-cookie': 'true', 'x-other': 'Bearer ${NOPE}' }, { BYPASS: 's3cret' });
    expect(r.headers).toEqual({ 'x-vercel-protection-bypass': 's3cret', 'x-vercel-set-bypass-cookie': 'true' });
    expect(r.missing).toEqual(['NOPE']);
  });

  it('is on when the block is present unless enabled is false', () => {
    expect(previewEnabled(undefined)).toBe(false);
    expect(previewEnabled(true)).toBe(true);
    expect(previewEnabled({})).toBe(true);
    expect(previewEnabled({ enabled: false })).toBe(false);
  });

  it('picks the newest ready deployment, waits on in-progress ones, and reports failures', () => {
    const d = (id: number, environment: string, created_at: string) => ({ id, environment, created_at });
    const ok = (url: string) => [{ state: 'success', environment_url: url }];
    // Vercel-style: one Preview deployment, ready
    expect(pickDeployment([d(1, 'Preview', '2026-11-09T10:00:00Z')], { 1: ok('https://app-git-x.vercel.app') })).toEqual({ state: 'ready', url: 'https://app-git-x.vercel.app', environment: 'Preview' });
    // newest wins
    expect(pickDeployment([d(1, 'Preview', '2026-11-09T10:00:00Z'), d(2, 'Preview', '2026-11-09T10:05:00Z')], { 1: ok('https://old'), 2: ok('https://new') })).toMatchObject({ url: 'https://new' });
    // still building, or no status yet
    expect(pickDeployment([d(1, 'Preview', 'x')], { 1: [{ state: 'in_progress' }] })).toEqual({ state: 'pending' });
    expect(pickDeployment([d(1, 'Preview', 'x')], {})).toEqual({ state: 'pending' });
    // failed
    expect(pickDeployment([d(1, 'deploy-preview-7', 'x')], { 1: [{ state: 'failure', target_url: 'https://app.netlify.com/logs' }] })).toMatchObject({ state: 'failed', environment: 'deploy-preview-7' });
    // environment filter, substring or /regex/
    const both = [d(1, 'Production', 'b'), d(2, 'Preview', 'a')];
    const st = { 1: ok('https://prod'), 2: ok('https://preview') };
    expect(pickDeployment(both, st, 'preview')).toMatchObject({ url: 'https://preview' });
    expect(pickDeployment(both, st, '/^prod/')).toMatchObject({ url: 'https://prod' });
    // excluding previews finds production
    expect(pickDeployment(both, st, undefined, /preview/i)).toMatchObject({ url: 'https://prod' });
    // a status without a usable URL doesn't count as ready
    expect(pickDeployment([d(1, 'Preview', 'x')], { 1: [{ state: 'success', target_url: '' }] })).toEqual({ state: 'none' });
    expect(pickDeployment([], {})).toEqual({ state: 'none' });
  });

  it('waits for a URL pattern to come up, sending the headers', async () => {
    let up = false;
    let seen = '';
    const server = createServer((req, res) => {
      seen = String(req.headers['x-bypass'] ?? '');
      res.statusCode = up ? 200 : 404;
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    setTimeout(() => (up = true), 150);
    const r = await waitForPreview({ repo: 'o/r', sha: 'abc1234', branch: 'b', pr: 3, preview: { url: `http://127.0.0.1:${port}/pr-{pr}/`, timeoutSeconds: 5 }, headers: { 'x-bypass': 'yes' }, pollMs: 50 });
    expect(r).toEqual({ url: `http://127.0.0.1:${port}/pr-3/`, source: 'URL pattern' });
    expect(seen).toBe('yes');
    up = false;
    const t = await waitForPreview({ repo: 'o/r', sha: 'abc1234', branch: 'b', preview: { url: `http://127.0.0.1:${port}/`, timeoutSeconds: 0.2 }, headers: {}, pollMs: 50 });
    expect('error' in t && t.error).toMatch(/didn't come up within/);
    server.close();
  });
});

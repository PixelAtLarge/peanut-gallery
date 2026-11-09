#!/usr/bin/env node
// End-to-end check of "after" screenshots from preview deployments, against a GitHub sandbox repo.
// Meant to run in GitHub Actions on the sandbox (see its .github/workflows/e2e-preview.yml), where
// the workflow token can report and read deployments:
//
//   SANDBOX=owner/name node scripts/e2e-preview.mjs
//
// The script plays the host (Vercel, Netlify…): when a new peanut-gallery/* branch appears on
// GitHub, it serves that branch's files locally and reports a "Preview" deployment for each of its
// commits, as real hosts do. Three runs: preview found through GitHub deployments; through a URL
// pattern; and a preview that never comes up, falling back to the local dev server. The AI steps
// use stand-ins.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const SANDBOX = process.env.SANDBOX;
if (!SANDBOX || !/^[\w.-]+\/[\w.-]+$/.test(SANDBOX)) throw new Error('Set SANDBOX=owner/name (a throwaway repo)');
const WORK = process.env.WORKDIR ?? join(process.env.TMPDIR ?? '/tmp', 'pg-e2e-preview');
const DIR = join(WORK, SANDBOX.split('/')[1]);
const ISSUE = Number(process.env.ISSUE ?? 72);

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const gh = (...args) => sh('gh', args);
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) finish(1);
}
const hosts = [];
function finish(code = 0) {
  for (const h of hosts) h.stop();
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} checks passed`);
  writeFileSync(join(WORK, 'e2e-preview-results.json'), JSON.stringify({ sandbox: SANDBOX, results, at: new Date().toISOString() }, null, 2));
  process.exit(code);
}

mkdirSync(WORK, { recursive: true });
rmSync(DIR, { recursive: true, force: true });
sh('git', ['clone', '-q', `https://github.com/${SANDBOX}.git`, DIR]);
process.chdir(DIR);
const baseCfg = JSON.parse(readFileSync('peanut-gallery.config.json', 'utf8'));
baseCfg.dev = { command: 'python3 -m http.server {port} --bind 127.0.0.1', port: 4310 };
delete baseCfg.prototypeUrl;
const writeCfg = (preview) => writeFileSync('peanut-gallery.config.json', JSON.stringify({ ...baseCfg, preview }, null, 2) + '\n');

/** Plays the host: serves each new peanut-gallery/* branch at http://127.0.0.1:<port>/. */
function fakeHost(port, report = false) {
  const known = new Set(sh('git', ['ls-remote', '--heads', 'origin', 'peanut-gallery/*']).split('\n').filter(Boolean).map((l) => l.split('\t')[1]));
  let server = null;
  let stopped = false;
  const dir = join(WORK, `host-${port}`);
  const tick = () => {
    if (stopped || server) return;
    const heads = sh('git', ['ls-remote', '--heads', 'origin', 'peanut-gallery/*']).split('\n').filter(Boolean).map((l) => l.split('\t')[1]);
    const fresh = heads.find((h) => !known.has(h));
    if (fresh) {
      const name = fresh.replace('refs/heads/', '');
      rmSync(dir, { recursive: true, force: true });
      sh('git', ['fetch', '-q', 'origin', name]);
      sh('git', ['worktree', 'add', '-q', '--detach', dir, 'FETCH_HEAD']);
      server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: dir, stdio: 'ignore', detached: true });
      console.log(`   (host) serving ${name} on :${port}`);
      if (report) reportDeployments(name, port);
    }
  };
  const timer = setInterval(() => { try { tick(); } catch { /* retry */ } }, 3000);
  const h = { stop: () => { stopped = true; clearInterval(timer); if (server) { try { process.kill(-server.pid); } catch { /* gone */ } } } };
  hosts.push(h);
  return h;
}

/**
 * Report a "Preview" deployment for every commit on the branch, as hosts do. Used when this runs
 * in GitHub Actions: pushes made with the workflow token don't trigger the fake-host workflow.
 */
const reported = new Set();
function reportDeployments(branch, port) {
  const poll = setInterval(() => {
    try {
      const sha = sh('git', ['ls-remote', 'origin', `refs/heads/${branch}`]).split(/\s/)[0];
      if (!sha || reported.has(sha)) return;
      reported.add(sha);
      const id = JSON.parse(sh('gh', ['api', '-X', 'POST', `repos/${SANDBOX}/deployments`, '--input', '-'], { stdio: ['pipe', 'pipe', 'pipe'], input: JSON.stringify({ ref: sha, environment: 'Preview', auto_merge: false, required_contexts: [], transient_environment: true }) })).id;
      gh('api', '-X', 'POST', `repos/${SANDBOX}/deployments/${id}/statuses`, '-f', 'state=success', '-f', `environment_url=http://127.0.0.1:${port}/`);
      console.log(`   (host) reported Preview deployment ${id} for ${sha.slice(0, 7)}`);
    } catch (err) {
      console.log(`   (host) couldn't report a deployment: ${String(err.message).split('\n')[0]}`);
      clearInterval(poll);
    }
  }, 3000);
  hosts.push({ stop: () => clearInterval(poll) });
}

const lib = await import(join(ROOT, 'packages/cli/dist/index.js'));
process.env.ANTHROPIC_API_KEY ??= 'stand-in';
const issues = await lib.pullCommand({ issue: [String(ISSUE)], quiet: true });
check(`pulled feedback issue #${ISSUE}`, issues.length === 1 && issues[0].session.annotations.length > 0);
const flat = lib.flatten(issues);
const note = flat[0];
const proposalsFor = async (title) => {
  const client = { messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify({ proposals: [{ title, summary: 'Make the promo link easier to notice.', instructions: 'In styles.css make .promo a bold and underlined.', annotationIds: [note.id], focusAnchorIds: [note.id], effort: 'small', confidence: 0.8 }], skipped: [] }) }] }) } };
  return (await lib.interpret(flat, { model: 'stand-in', client })).proposals;
};
const implement = (variant) => async (p, anns, { cwd }) => {
  const f = join(cwd, 'styles.css');
  const css = readFileSync(f, 'utf8');
  writeFileSync(f, css + `\n/* ${variant} */\n.promo { font-size: 15px; }\n.promo a { font-weight: 700; text-decoration: underline; text-underline-offset: 3px; }\n`);
  return { ok: true, summary: `Stand-in agent: bolder promo link (${variant}).`, costUsd: 0, turns: 1, denied: [] };
};
const pngDiffers = (dir, key) => {
  const a = readFileSync(join(dir, `before-${key}.png`));
  const b = readFileSync(join(dir, `after-${key}.png`));
  return !a.equals(b);
};
const prBody = (n) => JSON.parse(gh('api', `repos/${SANDBOX}/pulls/${n}`)).body ?? '';
const opened = [];

// ── 1. preview found through GitHub deployments (how Vercel, Netlify, Cloudflare… report previews)
{
  writeCfg({ environment: 'Preview', timeoutSeconds: 420 });
  const host = fakeHost(4700, true);
  const t0 = Date.now();
  const [run] = await lib.applyCommand({ proposals: await proposalsFor('Preview e2e: deployments'), issues, port: 4460, implement: implement('deployments'), comment: false });
  host.stop();
  opened.push(run.prNumber);
  console.log(`   ${run.prUrl} in ${Math.round((Date.now() - t0) / 1000)}s`);
  check('deployments: PR opened', !!run.prUrl);
  check('deployments: after shots came from the preview deployment', run.previewUrl === 'http://127.0.0.1:4700/', run.previewUrl);
  const shas = JSON.parse(gh('api', `repos/${SANDBOX}/pulls/${run.prNumber}/commits`)).map((c) => c.sha);
  const deps = JSON.parse(gh('api', `repos/${SANDBOX}/deployments?environment=Preview&per_page=50`));
  const mine = deps.filter((d) => shas.includes(d.sha));
  check('deployments: GitHub has a Preview deployment for the PR\'s commits', mine.length > 0, `${mine.length} for ${shas.map((x) => x.slice(0, 7)).join(', ')}`);
  const body = prBody(run.prNumber);
  check('deployments: PR description updated with the comparison image', body.includes('![before / after](') && !body.includes('⏳'), body.slice(0, 80));
  check('deployments: PR says where the after shots came from', body.includes('preview deployment: http://127.0.0.1:4700/'));
  check('deployments: before and after differ (the change is visible)', pngDiffers(join(DIR, run.localCompareDir), 'el1'));
}

// ── 2. preview found through a URL pattern (hosts that don't report deployments)
{
  writeCfg({ url: 'http://127.0.0.1:4701/?pr={pr}', timeoutSeconds: 240 });
  const host = fakeHost(4701);
  const [run] = await lib.applyCommand({ proposals: await proposalsFor('Preview e2e: URL pattern'), issues, port: 4470, implement: implement('pattern'), comment: false });
  host.stop();
  opened.push(run.prNumber);
  check('pattern: after shots came from the pattern URL with the PR number', run.previewUrl === `http://127.0.0.1:4701/?pr=${run.prNumber}`, run.previewUrl);
  check('pattern: PR description has the comparison image', prBody(run.prNumber).includes('![before / after]('));
  check('pattern: before and after differ', pngDiffers(join(DIR, run.localCompareDir), 'el1'));
}

// ── 3. preview never comes up → local dev server instead
{
  writeCfg({ url: 'http://127.0.0.1:4799/', timeoutSeconds: 6 });
  const [run] = await lib.applyCommand({ proposals: await proposalsFor('Preview e2e: fallback'), issues, port: 4480, implement: implement('fallback'), comment: false });
  opened.push(run.prNumber);
  check('fallback: no preview URL recorded', !run.previewUrl);
  check('fallback: screenshots still taken from the local dev server', run.screenshots?.length > 0 && pngDiffers(join(DIR, run.localCompareDir), 'el1'));
  check('fallback: PR description has the comparison image', prBody(run.prNumber).includes('![before / after]('));
}

// Tidy: these PRs only exist to test the flow.
for (const n of opened.filter(Boolean)) {
  try { gh('api', '-X', 'PATCH', `repos/${SANDBOX}/pulls/${n}`, '-f', 'state=closed'); } catch { /* leave it */ }
}
console.log(`closed test PRs ${opened.map((n) => '#' + n).join(', ')}`);
finish(0);

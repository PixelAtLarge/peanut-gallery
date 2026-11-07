#!/usr/bin/env node
// End-to-end run against a REAL GitHub sandbox repo.
//
//   SANDBOX=owner/name node scripts/e2e-github.mjs [--real-ai]
//
// Everything is real — relay → GitHub Issues, pull, git worktrees, dev servers, Playwright
// screenshots, push, pull requests, issue comments, votes, labels, the variants assets branch —
// except the two AI calls, which use deterministic stand-ins unless --real-ai is passed
// (then you need `claude login` or ANTHROPIC_API_KEY). Exits non-zero on the first failed check.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const SANDBOX = process.env.SANDBOX;
const REAL_AI = process.argv.includes('--real-ai');
if (!SANDBOX || !/^[\w.-]+\/[\w.-]+$/.test(SANDBOX)) throw new Error('Set SANDBOX=owner/name (an empty throwaway repo)');
const WORK = process.env.WORKDIR ?? join(process.env.TMPDIR ?? '/tmp', 'pg-e2e');
const DIR = join(WORK, SANDBOX.split('/')[1]);
const CLI = join(ROOT, 'packages/cli/dist/cli.js');

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const gh = (...args) => sh('gh', args);
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) { summary(); process.exit(1); }
}
function summary() {
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} checks passed${REAL_AI ? ' (real AI)' : ' (AI stand-ins)'}`);
  writeFileSync(join(WORK, 'e2e-results.json'), JSON.stringify({ sandbox: SANDBOX, realAi: REAL_AI, results, at: new Date().toISOString() }, null, 2));
}

// ── 1. sandbox repo with the example prototype ────────────────────────────────
mkdirSync(WORK, { recursive: true });
if (process.env.REUSE_CLONE && existsSync(join(DIR, '.git'))) {
  // use an existing checkout (e.g. one your environment already cloned)
} else {
  rmSync(DIR, { recursive: true, force: true });
  sh('git', ['clone', '-q', `https://github.com/${SANDBOX}.git`, DIR]);
}
process.chdir(DIR);
if (!existsSync('index.html')) {
  for (const f of ['index.html', 'styles.css']) cpSync(join(ROOT, 'examples/vanilla-prototype', f), f);
  // widget from the local build (the sandbox page is served locally for screenshots)
  writeFileSync('index.html', readFileSync('index.html', 'utf8').replace('../../packages/widget/dist/peanut-gallery.global.js', 'peanut-gallery.global.js'));
  cpSync(join(ROOT, 'packages/widget/dist/peanut-gallery.global.js'), 'peanut-gallery.global.js');
  writeFileSync('.gitignore', 'node_modules\n.peanut-gallery/worktrees/\n');
  sh('git', ['checkout', '-q', '-B', 'main']);
  sh('git', ['add', '-A']);
  sh('git', ['-c', 'user.name=peanut-gallery-e2e', '-c', 'user.email=e2e@peanut-gallery.invalid', 'commit', '-q', '-m', 'Example prototype for peanut-gallery e2e']);
  sh('git', ['push', '-q', '-u', 'origin', 'main']);
}
check('sandbox repo has the example prototype on main', existsSync('index.html'));

// Design system: tokens in their own file + maintainer guidance in CLAUDE.md (once per sandbox).
if (!existsSync('tokens.css')) {
  const css = readFileSync('styles.css', 'utf8').split('\n');
  const i = css.findIndex((l) => l.startsWith(':root'));
  writeFileSync('tokens.css', `/* Design tokens. Use these variables; don't add raw colours. */\n${css[i]}\n:root { --success: #0f7b52; --on-accent: #ffffff; --radius: 12px; --radius-pill: 999px; }\n`);
  css.splice(i, 1);
  writeFileSync('styles.css', css.join('\n'));
  writeFileSync('index.html', readFileSync('index.html', 'utf8').replace(/(<link[^>]*styles\.css[^>]*>)/, '<link rel="stylesheet" href="tokens.css">\n  $1'));
  writeFileSync('CLAUDE.md', '# Checkout prototype\n\n- Colours, radii and spacing come from the CSS variables in `tokens.css`. Never hard-code hex values.\n- Buttons use the `.btn` class; primary actions add a modifier class rather than inline styles.\n');
  sh('git', ['add', '-A']);
  sh('git', ['-c', 'user.name=peanut-gallery-e2e', '-c', 'user.email=e2e@peanut-gallery.invalid', 'commit', '-q', '-m', 'Move design tokens to tokens.css; add CLAUDE.md']);
  sh('git', ['push', '-q', 'origin', 'HEAD:main']);
}

sh('node', [CLI, 'init', '--yes', '--repo', SANDBOX, '--prototype-url', '', '--dev', 'python3 -m http.server {port} --bind 127.0.0.1']);
const cfg = JSON.parse(readFileSync('peanut-gallery.config.json', 'utf8'));
check('init detected the design tokens', cfg.designSystem?.tokens?.includes('tokens.css'), JSON.stringify(cfg.designSystem?.tokens));
cfg.sourceHints = ['index.html', 'styles.css'];
cfg.agentNotes = 'Static HTML prototype; styles in styles.css.';
cfg.designSystem.rules = 'One primary action per screen. Use --accent for primary buttons.';
// A tiny drift check: flags raw hex colours added by the change (stand-in for off-brand).
cfg.checks = [{
  name: 'Raw colour drift',
  command: 'out=$(git diff -U0 "$PEANUT_GALLERY_BASE"...HEAD -- "*.css" "*.html" | grep -E "^\\+[^+].*#[0-9a-fA-F]{3,8}"); if [ -n "$out" ]; then echo "Raw colours added (use tokens.css):"; echo "$out"; exit 1; fi; echo "No raw colours added."',
}];
delete cfg.prototypeUrl;
writeFileSync('peanut-gallery.config.json', JSON.stringify(cfg, null, 2) + '\n');
const labels = JSON.parse(gh('api', `repos/${SANDBOX}/labels?per_page=100`)).map((l) => l.name);
check('init created the peanut-gallery labels', ['peanut-gallery', 'peanut-gallery:feedback', 'peanut-gallery:proposal', 'peanut-gallery:accepted'].every((l) => labels.includes(l)), labels.filter((l) => l.startsWith('peanut')).join(', '));

// ── 2. a reviewer session from the real widget, filed through the real relay ──
const { chromium } = await import(join(ROOT, 'node_modules/playwright/index.mjs'));
const server = (await import('node:child_process')).spawn('python3', ['-m', 'http.server', '4390', '--bind', '127.0.0.1'], { cwd: DIR, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch(process.env.PEANUT_GALLERY_BROWSER ? { executablePath: process.env.PEANUT_GALLERY_BROWSER } : {}).catch(() => chromium.launch({ channel: 'chrome' }));
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:4390/?peanut');
const w = (sel) => page.locator('peanut-gallery').locator(sel);
const note = async (target, text, kind) => {
  await w('[data-role=comment]').click();
  await page.locator(target).hover(); await page.locator(target).click();
  await w('textarea').fill(text);
  if (kind) await w('select').selectOption(kind);
  await w('.pg-composer .pg-primary').click();
};
await note('button[data-testid="pay"]', 'Make this the primary CTA and show the total on it.', 'visual');
await note('[data-testid="total"]', 'Total feels buried, make it bigger.', 'layout');
const session = await page.evaluate((repo) => JSON.parse(localStorage.getItem(`peanut-gallery:${repo}`)), 'acme/checkout-prototype');
await browser.close();
server.kill();
session.author = 'e2e-reviewer';
check('widget produced a 2-note session with stable anchors', session?.annotations?.length === 2 && session.annotations[0].anchor.selector === 'button[data-testid="pay"]');

const { createRelayHandler } = await import(join(ROOT, 'packages/relay/dist/index.js'));
// Some sandboxes only reach GitHub through an authenticating proxy that `gh` knows about.
// RELAY_VIA_GH=1 forwards the relay's exact request through `gh api` instead of fetch,
// so the relay's validation, labels and issue-body code still run unchanged.
const relayToken = process.env.RELAY_VIA_GH ? 'via-gh' : gh('auth', 'token');
const viaGh = async (url, init) => {
  const h = init.headers;
  if (h.authorization !== `Bearer ${relayToken}` || h['x-github-api-version'] !== '2022-11-28') throw new Error('relay sent unexpected headers');
  const path = new URL(url).pathname.replace(/^\//, '');
  const r = spawnSync('gh', ['api', '-X', init.method, path, '--input', '-', '-i'], { input: init.body, encoding: 'utf8' });
  const [head, ...rest] = r.stdout.split(/\r?\n\r?\n/);
  const status = Number(/HTTP\/[\d.]+ (\d+)/.exec(head)?.[1] ?? 500);
  return new Response(rest.join('\n\n'), { status, headers: { 'content-type': 'application/json' } });
};
const relay = createRelayHandler({ githubToken: relayToken, repo: SANDBOX, allowedOrigins: ['http://127.0.0.1:4390'], ...(process.env.RELAY_VIA_GH ? { fetch: viaGh } : {}) });
const res = await relay(new Request('https://relay.local/', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4390' }, body: JSON.stringify({ session }) }));
const filed = await res.json();
check('relay created a GitHub issue', res.status === 201 && filed.issueNumber, filed.issueUrl ?? JSON.stringify(filed));

// ── 3. pull ───────────────────────────────────────────────────────────────────
// GitHub's issue listing can trail a just-created issue by a few seconds; retry briefly.
let pullOut = '', ours;
for (let i = 0; i < 6 && !ours; i++) {
  if (i) await new Promise((r) => setTimeout(r, 2500));
  pullOut = sh('node', [CLI, 'pull']);
  ours = JSON.parse(readFileSync('.peanut-gallery/feedback.json', 'utf8')).find((x) => x.number === filed.issueNumber);
}
const lib = await import(join(ROOT, 'packages/cli/dist/index.js'));
check('pull parsed the issue back into a session', ours && ours.session.annotations.length === 2, pullOut.split('\n')[0]);

// ── 4. interpret ──────────────────────────────────────────────────────────────
const flat = lib.flatten([ours]);
const fakeClient = { messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify({
  proposals: [{ title: 'Make “Pay now” the primary CTA with the amount', summary: 'Promote the pay button and show the total on it.', instructions: 'Give button[data-testid="pay"] a primary style (accent background, white text, bolder) and change its label to "Pay $150.50".', annotationIds: [flat[0].id], focusAnchorIds: [flat[0].id], effort: 'small', confidence: 0.9 }],
  skipped: [{ annotationId: flat[1].id, reason: 'deferred for the e2e run' }],
}) }] }) } };
const { proposals } = await lib.interpret(flat, REAL_AI ? { model: cfg.models?.interpret ?? 'claude-haiku-5-5' } : { model: 'stand-in', client: fakeClient });
writeFileSync('.peanut-gallery/proposals.json', JSON.stringify(proposals, null, 2));
check('interpret produced proposals with support counts', proposals.length >= 1 && proposals[0].support?.count >= 1, proposals.map((p) => p.title).join(' | '));

// ── 5. apply: worktree → implement → dev servers → screenshots → push → PR → comment ──
const fakeImplement = (label, cls, css) => async (p, anns, { cwd }) => {
  const html = join(cwd, 'index.html');
  writeFileSync(html, readFileSync(html, 'utf8').replace('<button class="btn" data-testid="pay">Pay now</button>', `<button class="btn ${cls}" data-testid="pay">${label}</button>`));
  writeFileSync(join(cwd, 'styles.css'), readFileSync(join(cwd, 'styles.css'), 'utf8') + css);
  return { ok: true, summary: `Stand-in agent: restyled the pay button (${cls}).`, costUsd: 0, turns: 1, denied: [] };
};
if (!REAL_AI) process.env.ANTHROPIC_API_KEY ??= 'stand-in'; // apply only checks a credential exists
const runs = await lib.applyCommand({
  proposals, issues: [ours], port: 4400,
  ...(REAL_AI ? {} : { implement: fakeImplement('Pay $150.50', 'btn-primary', '\n.btn-primary{background:#0F7B52;color:#fff;border-color:#0F7B52;font-weight:600}\n') }),
});
const run = runs[0];
check('apply implemented the change on its own branch', run && run.branch?.startsWith('peanut-gallery/'), run?.branch);
check('before/after screenshots + compare page were generated', run?.screenshots?.length > 0 && run.comparePath, `${run?.screenshots?.length ?? 0} pairs`);
check('a pull request was opened', run?.prUrl?.includes('/pull/'), run?.prUrl);
const prFiles = JSON.parse(gh('api', `repos/${SANDBOX}/pulls/${run.prNumber}/files`)).map((f) => f.filename);
check('PR contains the code change and the comparison assets', prFiles.some((f) => f === 'index.html' || f === 'styles.css') && prFiles.some((f) => f.endsWith('summary.png')), prFiles.join(', '));
const prBody = JSON.parse(gh('api', `repos/${SANDBOX}/pulls/${run.prNumber}`)).body ?? '';
check(
  'PR reports the design-system check and guidance',
  prBody.includes('### Checks') && prBody.includes('Raw colour drift') && prBody.includes('guidance from CLAUDE.md') && (REAL_AI || prBody.includes('⚠️ **Raw colour drift**')),
  (prBody.match(/(✅|⚠️|❌) \*\*Raw colour drift\*\*[^\n]*/) ?? ['no checks line'])[0],
);
check(
  'built-in check: every class the change added is styled',
  prBody.includes('✅ **Undefined CSS classes**'),
  (prBody.match(/(✅|⚠️|❌) \*\*Undefined CSS classes\*\*[^\n]*/) ?? ['no undefined-classes line'])[0],
);
const comments = JSON.parse(gh('api', `repos/${SANDBOX}/issues/${filed.issueNumber}/comments`));
check('comparison + vote prompt were posted back on the issue', comments.some((c) => c.body.includes('Which do you prefer?') && c.body.includes(run.prUrl)));

// ── 6. reviewer replies; votes --label ────────────────────────────────────────
gh('api', `repos/${SANDBOX}/issues/${filed.issueNumber}/comments`, '-f', 'body=After, definitely. Ship it.');
sh('node', [CLI, 'votes', '--label']);
const issueLabels = JSON.parse(gh('api', `repos/${SANDBOX}/issues/${filed.issueNumber}`)).labels.map((l) => l.name);
check('votes read the reply and labelled the issue accepted', issueLabels.includes('peanut-gallery:accepted'), issueLabels.join(', '));
const prComments = JSON.parse(gh('api', `repos/${SANDBOX}/issues/${run.prNumber}/comments`));
check('votes left a verdict on the PR', prComments.some((c) => c.body.includes('preferred **After**')));

// ── 7. variants: two alternatives, combined grid, assets branch ───────────────
const vruns = await lib.variantsCommand(proposals[0].id, {
  count: 2, port: 4420,
  ...(REAL_AI ? { note: 'one lighter, one bolder' } : {
    directions: [
      { label: 'A', title: 'Accent fill + amount', summary: 'Emerald primary button with the amount.', instructions: 'accent' },
      { label: 'B', title: 'Dark pill + amount', summary: 'Ink pill with the amount inline.', instructions: 'pill' },
    ],
    implement: async (p, anns, ctx) => (p.id.endsWith('_a')
      ? fakeImplement('Pay $150.50', 'btn-accent', '\n.btn-accent{background:#0F7B52;color:#fff}\n')
      : fakeImplement('Pay now · $150.50 →', 'btn-pill', '\n.btn-pill{background:#22272B;color:#fff;border-radius:999px}\n'))(p, anns, ctx),
  }),
});
check('variants opened one PR per option', vruns.length === 2 && vruns.every((r) => r.prUrl), vruns.map((r) => r.prUrl).join(' , '));
const assets = sh('git', ['ls-remote', '--heads', 'origin', 'peanut-gallery/assets']);
check('combined options image was published to the assets branch', assets.length > 0);
const after = JSON.parse(gh('api', `repos/${SANDBOX}/issues/${filed.issueNumber}/comments`));
check('options comparison was posted on the issue', after.some((c) => c.body.includes('options round') && c.body.includes('peanut-gallery%2Fassets')));

summary();

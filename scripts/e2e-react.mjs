#!/usr/bin/env node
// End-to-end run of a REAL React app (Vite + React Router, async data, a modal) against a
// GitHub sandbox repo. The app lives on its own branch (`react-app`) so it never touches main.
//
//   SANDBOX=owner/name node scripts/e2e-react.mjs [--real-ai]
//
// Real: the widget in Chromium across client-side route changes and a modal, relay → issue,
// pull, git worktrees, Vite dev servers in each worktree, screenshots, push, pull requests,
// issue comments. The two AI calls use deterministic stand-ins unless --real-ai is passed.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const SANDBOX = process.env.SANDBOX;
const REAL_AI = process.argv.includes('--real-ai');
const BRANCH = process.env.BRANCH ?? 'react-app';
if (!SANDBOX || !/^[\w.-]+\/[\w.-]+$/.test(SANDBOX)) throw new Error('Set SANDBOX=owner/name (a throwaway repo)');
const WORK = process.env.WORKDIR ?? join(process.env.TMPDIR ?? '/tmp', 'pg-e2e-react');
const DIR = join(WORK, SANDBOX.split('/')[1]);
const CLI = join(ROOT, 'packages/cli/dist/cli.js');
const WIDGET_TGZ = 'vendor/peanut-gallery-widget.tgz';

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const gh = (...args) => sh('gh', args);
const git = (...args) => sh('git', ['-c', 'user.name=peanut-gallery-e2e', '-c', 'user.email=e2e@peanut-gallery.invalid', ...args]);
const results = [];
const notes = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) { summary(); process.exit(1); }
}
/** Something worth knowing that isn't a pass/fail (known limitations). */
function note(text) {
  notes.push(text);
  console.log(`ℹ ${text}`);
}
function summary() {
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} checks passed${REAL_AI ? ' (real AI)' : ' (AI stand-ins)'}`);
  writeFileSync(join(WORK, 'e2e-react-results.json'), JSON.stringify({ sandbox: SANDBOX, branch: BRANCH, realAi: REAL_AI, results, notes, at: new Date().toISOString() }, null, 2));
}

// ── 1. the React app on its own branch ─────────────────────────────────────────
mkdirSync(WORK, { recursive: true });
if (!(process.env.REUSE_CLONE && existsSync(join(DIR, '.git')))) {
  rmSync(DIR, { recursive: true, force: true });
  sh('git', ['clone', '-q', `https://github.com/${SANDBOX}.git`, DIR]);
}
process.chdir(DIR);
const remoteHasBranch = sh('git', ['ls-remote', '--heads', 'origin', BRANCH]).length > 0;
if (remoteHasBranch) {
  sh('git', ['fetch', '-q', 'origin', BRANCH]);
  sh('git', ['checkout', '-q', '-B', BRANCH, `origin/${BRANCH}`]);
} else {
  sh('git', ['checkout', '-q', '--orphan', BRANCH]);
  sh('git', ['rm', '-rq', '--cached', '.']);
  for (const f of readdirSync('.')) if (f !== '.git') rmSync(f, { recursive: true, force: true });
}
// Refresh the app and the widget build every run, so the branch tests the current code.
cpSync(join(ROOT, 'examples/react-app'), '.', { recursive: true, filter: (src) => !src.includes('node_modules') });
mkdirSync('vendor', { recursive: true });
// The widget imports core at runtime, so ship both from the local build.
const VENDOR = { widget: WIDGET_TGZ, core: 'vendor/peanut-gallery-core.tgz' };
for (const [name, dest] of Object.entries(VENDOR)) {
  const packed = sh('npm', ['pack', '--pack-destination', join(DIR, 'vendor'), '--silent'], { cwd: join(ROOT, 'packages', name) }).split('\n').pop();
  cpSync(join('vendor', packed), dest);
  rmSync(join('vendor', packed));
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
pkg.dependencies['@pixelatlarge/peanut-gallery-widget'] = `file:${VENDOR.widget}`;
pkg.dependencies['@pixelatlarge/peanut-gallery-core'] = `file:${VENDOR.core}`;
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
writeFileSync('.gitignore', 'node_modules\ndist\n.peanut-gallery/worktrees/\n.peanut-gallery/compare/\n');
// Same version number every run, so npm would keep the old copies: drop them (and Vite's
// pre-bundled copy), and name the tarballs so npm re-reads them and updates the lockfile.
for (const d of ['widget', 'core']) rmSync(`node_modules/@pixelatlarge/peanut-gallery-${d}`, { recursive: true, force: true });
rmSync('node_modules/.vite', { recursive: true, force: true });
sh('npm', ['install', '--no-audit', '--no-fund', '--silent', `./${VENDOR.core}`, `./${VENDOR.widget}`]);
const installed = readdirSync('node_modules/@pixelatlarge/peanut-gallery-widget/dist').map((f) => readFileSync(join('node_modules/@pixelatlarge/peanut-gallery-widget/dist', f), 'utf8')).join('');
git('add', 'package.json', 'package-lock.json', 'index.html', 'vite.config.js', 'CLAUDE.md', 'src', 'vendor', '.gitignore');
if (sh('git', ['status', '--porcelain', '--untracked-files=no'])) {
  git('commit', '-q', '-m', 'React example app for peanut-gallery e2e');
  sh('git', ['push', '-q', '-u', 'origin', `HEAD:${BRANCH}`]);
}
check(`React app is on the ${BRANCH} branch, running the widget just built`, existsSync('src/pages/Cart.jsx') && existsSync('node_modules/vite') && installed.includes('peanut-gallery:locationchange') && installed.includes('recordStep') && installed.includes('recordInput') && existsSync('node_modules/@pixelatlarge/peanut-gallery-core/package.json') && JSON.parse(readFileSync('node_modules/@pixelatlarge/peanut-gallery-core/package.json', 'utf8')).version === JSON.parse(readFileSync(join(ROOT, 'packages/core/package.json'), 'utf8')).version);

const DEV = 'npx vite --port {port} --strictPort --host 127.0.0.1';
sh('node', [CLI, 'init', '--yes', '--repo', SANDBOX, '--prototype-url', '', '--dev', DEV]);
const cfg = JSON.parse(readFileSync('peanut-gallery.config.json', 'utf8'));
check('init found the design tokens', JSON.stringify(cfg.designSystem ?? {}).includes('tokens.css'), JSON.stringify(cfg.designSystem?.tokens));
cfg.baseBranch = BRANCH;
cfg.sourceHints = ['src/**/*.jsx', 'src/styles/*.css'];
cfg.agentNotes = 'React 19 + React Router + Vite app. Pages in src/pages, components in src/components.';
cfg.checks = [{
  name: 'Raw colour drift',
  command: 'out=$(git diff -U0 "$PEANUT_GALLERY_BASE"...HEAD -- "*.css" "*.jsx" | grep -E "^\\+[^+].*#[0-9a-fA-F]{3,8}"); if [ -n "$out" ]; then echo "Raw colours added (use tokens.css):"; echo "$out"; exit 1; fi; echo "No raw colours added."',
}];
delete cfg.prototypeUrl;
writeFileSync('peanut-gallery.config.json', JSON.stringify(cfg, null, 2) + '\n');

// ── 2. reviewer session in the running app: route changes, async data, a modal ─
const { chromium } = await import(join(ROOT, 'node_modules/playwright/index.mjs'));
const PORT = 4391;
const vite = spawn(DEV.replace('{port}', PORT), { cwd: DIR, shell: true, stdio: 'ignore', detached: true });
const stopVite = () => { try { process.kill(-vite.pid, 'SIGTERM'); } catch { /* gone */ } };
process.on('exit', stopVite); // also when a check fails and exits early
let viteExit = null;
vite.on('exit', (code) => { viteExit = code; });
for (let i = 0; i < 60; i++) {
  if (viteExit !== null) throw new Error(`Vite exited (${viteExit}); is port ${PORT} already in use?`);
  try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 500));
}
const browser = await chromium.launch(process.env.PEANUT_GALLERY_BROWSER ? { executablePath: process.env.PEANUT_GALLERY_BROWSER } : {}).catch(() => chromium.launch({ channel: 'chrome' }));
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/?peanut`);
const w = (sel) => page.locator('peanut-gallery').locator(sel);
const addNote = async (target, text, kind) => {
  await w('[data-role=comment]').click();
  await page.locator(target).hover(); await page.locator(target).click();
  await w('textarea').fill(text);
  if (kind) await w('select').selectOption(kind);
  await w('.pg-composer .pg-primary').click();
};
const pins = () => page.evaluate(() => Array.from(document.querySelector('peanut-gallery').shadowRoot.querySelectorAll('.pg-pin')).map((p) => ({ title: p.title, x: parseFloat(p.style.left), y: parseFloat(p.style.top) })));
const settle = () => page.waitForTimeout(150);
/** Poll until fn() is truthy (pins redraw on the next animation frame after a change). */
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await fn(); if (v) return v; await page.waitForTimeout(50); }
  return v;
};
/** Is the pin inside the element's box (page coordinates)? */
const pinOn = async (pin, selector) => {
  const box = await page.locator(selector).boundingBox();
  const sy = await page.evaluate(() => scrollY);
  return pin && box && pin.x >= box.x - 1 && pin.x <= box.x + box.width + 1 && pin.y >= box.y + sy - 1 && pin.y <= box.y + sy + box.height + 1;
};

await page.locator('[data-testid="item-snake"]').waitFor();
await addNote('[data-testid="item-snake"] .item-name', 'Show a small photo of each plant next to its name.', 'visual');
await page.locator('[data-testid="remove-fiddle"]').click();
await page.locator('[data-testid="dialog-title"]').waitFor();
await addNote('[data-testid="dialog-title"]', 'Say which plant is being removed, not just "item".', 'copy');
await settle();
check('pins sit on their elements, including inside the open modal', (await pins()).length === 2 && await pinOn((await pins())[1], '[data-testid="dialog-title"]'));
await page.locator('[data-testid="dialog-cancel"]').click();
await until(async () => (await pins()).length === 1);
check('closing the modal hides its pin (the note stays in the list)', (await pins()).length === 1 && (await w('[data-role=count]').textContent()) === '2', JSON.stringify((await pins()).map((p) => p.title)));

await page.locator('[data-testid="nav-checkout"]').click();
await page.locator('[data-testid="pay"]').waitFor();
await settle();
check('client-side navigation hides the previous page\'s pins', (await pins()).length === 0);
await addNote('[data-testid="pay"]', 'Make this the primary button and show the total on it.', 'visual');
await settle();
check('a note on the new route pins to its element', (await pins()).length === 1 && await pinOn((await pins())[0], '[data-testid="pay"]'));

// Typing: an email (private, so never recorded), then a promo code and Enter.
const PRIVATE_EMAIL = 'anna.reviewer@private.invalid';
await page.locator('[data-testid="email"]').click();
await page.locator('[data-testid="email"]').pressSequentially(PRIVATE_EMAIL, { delay: 5 });
await page.locator('[data-testid="promo"]').click();
await page.locator('[data-testid="promo"]').pressSequentially('PLANTS10', { delay: 5 });
await page.locator('[data-testid="promo"]').press('Enter');
await page.locator('[data-testid="promo-applied"]').waitFor();
await addNote('[data-testid="promo-applied"]', 'Show how much I saved and the new total, not just the percentage.', 'copy');
await settle();
check('a note on a message that only appears after typing pins to it', (await pins()).length === 2 && await pinOn((await pins())[1], '[data-testid="promo-applied"]'));

await page.locator('[data-testid="nav-cart"]').click();
await settle();
const whileLoading = (await pins()).length;
await page.locator('[data-testid="item-snake"]').waitFor();
await until(async () => (await pins()).length === 1);
const backPins = await pins();
check('navigating back: pin waits for the async list, then lands on its item', whileLoading === 0 && backPins.length === 1 && await pinOn(backPins[0], '[data-testid="item-snake"] .item-name'), `while loading: ${whileLoading}; after: ${JSON.stringify(backPins)} item box: ${JSON.stringify(await page.locator('[data-testid="item-snake"] .item-name').boundingBox())}`);
await page.goBack();
await page.locator('[data-testid="pay"]').waitFor();
await settle();
check('browser Back (popstate) redraws the right pins', (await pins()).length === 1 && await pinOn((await pins())[0], '[data-testid="pay"]'));

const session = await page.evaluate((repo) => JSON.parse(localStorage.getItem(`peanut-gallery:${repo}`)), 'PixelAtLarge/peanut-gallery-sandbox');

// A second reviewer, on a phone: taps to leave a note on the sticky checkout bar, which only exists at phone size.
const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const phonePage = await phoneCtx.newPage();
phonePage.on('pageerror', (e) => errors.push(`phone: ${e.message}`));
await phonePage.goto(`http://127.0.0.1:${PORT}/?peanut`);
await phonePage.locator('[data-testid="mobile-bar"]').waitFor();
const pw = (sel) => phonePage.locator('peanut-gallery').locator(sel);
const toolbarBox = await pw('.pg-toolbar').boundingBox();
check('on a phone, the widget toolbar fits on screen', toolbarBox && toolbarBox.x >= 0 && toolbarBox.x + toolbarBox.width <= 390, JSON.stringify(toolbarBox));
await pw('[data-role=comment]').tap();
await phonePage.locator('[data-testid="mobile-bar"] span').tap();
await pw('textarea').fill('Say how many plants are in the cart, not just the total.');
await pw('.pg-composer .pg-primary').tap();
await phonePage.waitForTimeout(200);
const phoneSession = await phonePage.evaluate((repo) => JSON.parse(localStorage.getItem(`peanut-gallery:${repo}`)), 'PixelAtLarge/peanut-gallery-sandbox');
const phoneNote = phoneSession?.annotations?.[0];
check('a reviewer on a phone can leave a note by tapping', phoneSession?.annotations?.length === 1 && phoneNote.viewport.width === 390 && phoneNote.anchor.selector.includes('mobile-bar'), JSON.stringify(phoneNote && { viewport: phoneNote.viewport, selector: phoneNote.anchor.selector }));
await phoneCtx.close();
await browser.close();
stopVite();
check('no errors in the app while reviewing', errors.length === 0, errors.join(' | '));
const paths = session.annotations.map((a) => new URL(a.pageUrl).pathname);
check('session has 4 notes with the right route on each', session.annotations.length === 4 && paths.join(',') === '/,/,/checkout,/checkout', paths.join(', '));
const stepsOf = (s) => s.annotations.map((a) => (a.steps ?? []).map((st) => (st.action && st.action !== 'click' ? `${st.action}:${st.field}:${st.masked ? '•' : st.value ?? ''}` : st.textFingerprint)));
check('the modal note carries the click that opened it (and only that)', JSON.stringify(stepsOf(session)[1]) === JSON.stringify(['Remove']) && !stepsOf(session)[0].length && !stepsOf(session)[2].length, JSON.stringify(stepsOf(session)));
check('the promo note carries the typing: email masked, code and Enter kept', JSON.stringify(stepsOf(session)[3]) === JSON.stringify(['type:Email:•', 'type:Promo code:PLANTS10', 'enter:Promo code:']), JSON.stringify(stepsOf(session)[3]));
check('the typed email is nowhere in the session', !JSON.stringify(session).includes(PRIVATE_EMAIL) && !JSON.stringify(session).includes('private.invalid'));
session.author = 'e2e-reviewer';

// ── 3. relay → issue → pull ───────────────────────────────────────────────────
const { createRelayHandler } = await import(join(ROOT, 'packages/relay/dist/index.js'));
const relayToken = process.env.RELAY_VIA_GH ? 'via-gh' : gh('auth', 'token');
const viaGh = async (url, init) => {
  const path = new URL(url).pathname.replace(/^\//, '');
  const r = spawnSync('gh', ['api', '-X', init.method, path, '--input', '-', '-i'], { input: init.body, encoding: 'utf8' });
  const [head, ...rest] = r.stdout.split(/\r?\n\r?\n/);
  const status = Number(/HTTP\/[\d.]+ (\d+)/.exec(head)?.[1] ?? 500);
  return new Response(rest.join('\n\n'), { status, headers: { 'content-type': 'application/json' } });
};
const origin = `http://127.0.0.1:${PORT}`;
const relay = createRelayHandler({ githubToken: relayToken, repo: SANDBOX, allowedOrigins: [origin], ...(process.env.RELAY_VIA_GH ? { fetch: viaGh } : {}) });
const res = await relay(new Request('https://relay.local/', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ session }) }));
const filed = await res.json();
check('relay created a GitHub issue', res.status === 201 && filed.issueNumber, filed.issueUrl ?? JSON.stringify(filed));
phoneSession.author = 'e2e-phone-reviewer';
const phoneRes = await relay(new Request('https://relay.local/', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ session: phoneSession }) }));
const phoneFiled = await phoneRes.json();
check('…and one for the phone reviewer', phoneRes.status === 201 && phoneFiled.issueNumber, phoneFiled.issueUrl ?? JSON.stringify(phoneFiled));

let ours, theirs;
for (let i = 0; i < 6 && !(ours && theirs); i++) {
  if (i) await new Promise((r) => setTimeout(r, 2500));
  sh('node', [CLI, 'pull']);
  const pulled = JSON.parse(readFileSync('.peanut-gallery/feedback.json', 'utf8'));
  ours = pulled.find((x) => x.number === filed.issueNumber);
  theirs = pulled.find((x) => x.number === phoneFiled.issueNumber);
}
const phoneIssueBody = JSON.parse(gh('api', `repos/${SANDBOX}/issues/${phoneFiled.issueNumber}`)).body;
check('the phone issue says it came from a phone-size screen', phoneIssueBody.includes('390×844 (phone size)'));
check('pull parsed the issue back into a session, steps included', ours?.session.annotations.length === 4 && JSON.stringify(stepsOf(ours.session)) === JSON.stringify(stepsOf(session)));
const issueBody = JSON.parse(gh('api', `repos/${SANDBOX}/issues/${filed.issueNumber}`)).body;
check('the issue tells humans how to reach the modal note', issueBody.includes('Reached by:** clicking “Remove”'));
check('…and the promo note, without the email', issueBody.includes('Reached by:** filling in “Email” → typing “PLANTS10” into “Promo code” → pressing Enter') && !issueBody.includes('private.invalid'));

// ── 4. interpret ──────────────────────────────────────────────────────────────
const lib = await import(join(ROOT, 'packages/cli/dist/index.js'));
const flat = lib.flatten([ours, theirs]);
const byText = (t) => flat.find((a) => a.text.includes(t));
const [photo, modal, pay, promo, bar] = [byText('photo'), byText('which plant'), byText('primary button'), byText('how much I saved'), byText('how many plants')];
const fakeClient = { messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify({
  proposals: [
    { title: 'Make “Pay now” the primary action with the total', summary: 'Primary style on the pay button, with the amount on it.', instructions: 'In src/pages/Checkout.jsx give the pay button a .btn-primary modifier and the label "Pay $104.00"; define .btn-primary in src/styles/app.css with tokens.', annotationIds: [pay.id], focusAnchorIds: [pay.id], effort: 'small', confidence: 0.9 },
    { title: 'Say what the promo code saves', summary: 'The applied message shows the amount saved.', instructions: 'In src/pages/Checkout.jsx change the promo-applied message to "{applied} applied: you save {money(subtotal - total)}".', annotationIds: [promo.id], focusAnchorIds: [promo.id], effort: 'small', confidence: 0.85 },
    { title: 'Show the item count on the phone checkout bar', summary: 'The sticky bar says how many plants are in the cart.', instructions: 'In src/pages/Cart.jsx, make the mobile-bar span read "{items.length} plants · {money(subtotal)}".', annotationIds: [bar.id], focusAnchorIds: [bar.id], effort: 'small', confidence: 0.85 },
    { title: 'Name the plant in the remove dialog', summary: 'Dialog title says which plant is being removed.', instructions: 'In src/pages/Cart.jsx pass title={`Remove ${removing.name}?`} to ConfirmDialog.', annotationIds: [modal.id], focusAnchorIds: [modal.id], effort: 'small', confidence: 0.85 },
  ],
  skipped: [{ annotationId: photo.id, reason: 'needs product photos (deferred for the e2e run)' }],
}) }] }) } };
const { proposals } = await lib.interpret(flat, REAL_AI ? { model: cfg.models?.interpret ?? 'claude-haiku-5-5' } : { model: 'stand-in', client: fakeClient });
writeFileSync('.peanut-gallery/proposals.json', JSON.stringify(proposals, null, 2));
check('interpret proposed changes for the pay button, the dialog, the promo message and the phone bar', [pay, modal, promo, bar].every((a) => proposals.some((p) => p.annotationIds.includes(a.id))), proposals.map((p) => p.title).join(' | '));

// ── 5. apply: worktrees on the branch → Vite in each → screenshots → PRs ──────
const edit = (cwd, file, from, to) => {
  const p = join(cwd, file);
  const src = readFileSync(p, 'utf8');
  if (!src.includes(from)) throw new Error(`stand-in edit: "${from}" not in ${file}`);
  writeFileSync(p, src.replace(from, to));
};
const fakeImplement = async (p, anns, { cwd }) => {
  if (/checkout bar/i.test(p.title)) {
    edit(cwd, 'src/pages/Cart.jsx', '<span>{money(subtotal)}</span>', '<span>{items.length} plants · {money(subtotal)}</span>');
  } else if (/promo/i.test(p.title)) {
    edit(cwd, 'src/pages/Checkout.jsx', '{applied} applied: 10% off', '{applied} applied: you save {money(subtotal - total)}');
  } else if (/pay/i.test(p.title)) {
    edit(cwd, 'src/pages/Checkout.jsx', '<button className="btn" data-testid="pay">Pay now</button>', '<button className="btn btn-primary" data-testid="pay">Pay {money(total)}</button>');
    edit(cwd, 'src/styles/app.css', '.btn-quiet {', '.btn-primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }\n.btn-quiet {');
  } else {
    edit(cwd, 'src/pages/Cart.jsx', 'title="Remove item?"', 'title={`Remove ${removing.name}?`}');
  }
  return { ok: true, summary: `Stand-in agent: ${p.title}.`, costUsd: 0, turns: 1, denied: [] };
};
if (!REAL_AI) process.env.ANTHROPIC_API_KEY ??= 'stand-in';
const runs = await lib.applyCommand({ proposals, issues: [ours, theirs], port: 4440, ...(REAL_AI ? {} : { implement: fakeImplement }) });
// Find each change by the note it addresses (real Claude may word titles differently,
// merge notes, or also propose the photo change).
const runFor = (ann) => runs.find((r) => proposals.find((p) => p.id === r.proposalId)?.annotationIds.includes(ann.id));
const payRun = runFor(pay) ?? runs[0];
const modalRun = runFor(modal);
const shotFor = (run, ann) => run?.screenshots?.find((s) => s.label.includes(ann.anchor.textFingerprint.slice(0, 20))) ?? run?.screenshots?.[0];
for (const r of runs) console.log(`   ${r.proposalId}: ${r.status ?? ''} ${r.branch ?? ''} ${r.prUrl ?? r.error ?? ''}`);
check('each change got its own branch and PR against the app branch', runs.length >= 4 && runs.every((r) => r.prUrl), runs.map((r) => r.prUrl).join(' , '));
const prBase = JSON.parse(gh('api', `repos/${SANDBOX}/pulls/${payRun.prNumber}`)).base.ref;
check(`PRs target ${BRANCH}, not main`, prBase === BRANCH, prBase);
check('Vite ran in both worktrees (before + after screenshots)', runs.every((r) => r.screenshots?.length > 0), runs.map((r) => `${r.screenshots?.length ?? 0} pairs`).join(', '));
/** PNG width in CSS px (shots are taken at 2x): a close-up is narrower than the 1280px page. */
const shotWidth = (f, run) => {
  if (!f) return 0;
  const abs = [f, run?.localCompareDir && join(run.localCompareDir, f), run?.localCompareDir && join(DIR, run.localCompareDir, f), join(DIR, '.peanut-gallery/compare', run?.proposalId ?? '', f)].find((x) => x && existsSync(x));
  return abs ? readFileSync(abs).readUInt32BE(16) / 2 : 0;
};
const payShot = shotFor(payRun, pay);
check(`pay change: close-up of the button on /checkout`, payShot && shotWidth(payShot.after, payRun) > 0 && shotWidth(payShot.after, payRun) < 1280, `${payShot?.label}: ${shotWidth(payShot?.after, payRun)}px wide`);
const prFiles = JSON.parse(gh('api', `repos/${SANDBOX}/pulls/${payRun.prNumber}/files`)).map((f) => f.filename);
check('PR contains the source change and its comparison', prFiles.some((f) => f.startsWith('src/')) && prFiles.some((f) => f.endsWith('summary.png')), prFiles.join(', '));
const modalShot = shotFor(modalRun, modal);
check('modal change: clicks replayed, close-up of the dialog title before and after', modalShot && /after clicking “Remove”/.test(modalShot.label) && shotWidth(modalShot.before, modalRun) > 0 && shotWidth(modalShot.before, modalRun) < 1280 && shotWidth(modalShot.after, modalRun) < 1280, `${modalShot?.label} · ${shotWidth(modalShot?.before, modalRun)}px / ${shotWidth(modalShot?.after, modalRun)}px wide`);
const promoRun = runFor(promo);
const promoShot = shotFor(promoRun, promo);
check('promo change: typing replayed (stand-in email), close-up of the message before and after', promoShot && promoShot.label.includes('after filling in “Email” → typing “PLANTS10” into “Promo code” → pressing Enter') && shotWidth(promoShot.before, promoRun) > 0 && shotWidth(promoShot.before, promoRun) < 1280 && shotWidth(promoShot.after, promoRun) < 1280, `${promoShot?.label} · ${shotWidth(promoShot?.before, promoRun)}px / ${shotWidth(promoShot?.after, promoRun)}px wide`);
const promoPr = JSON.parse(gh('api', `repos/${SANDBOX}/pulls/${promoRun.prNumber}`)).body;
const compareHtml = [promoRun.comparePath, promoRun.localCompareDir && join(promoRun.localCompareDir, 'compare.html'), join(DIR, '.peanut-gallery/compare', promoRun.proposalId, 'compare.html')].filter(Boolean).map((f) => (existsSync(f) ? f : join(DIR, f))).find((f) => existsSync(f));
const compareText = compareHtml ? readFileSync(compareHtml, 'utf8') : '';
check('the comparison page says how the shots were reached, and the email is nowhere', compareText.includes('typing “PLANTS10” into “Promo code”') && !compareText.includes('private.invalid') && !promoPr.includes('private.invalid'), compareHtml ?? 'no compare.html found');
const barRun = runFor(bar);
const barShot = barRun?.screenshots?.find((s) => s.label.startsWith('div') || s.label.startsWith('span'));
check('phone note: close-up shot at phone size, of the bar only phones have', barShot && barShot.label.endsWith('· phone') && !barShot.label.includes('full page') && shotWidth(barShot.before, barRun) > 0 && shotWidth(barShot.before, barRun) <= 390 && shotWidth(barShot.after, barRun) <= 390, `${barShot?.label} · ${shotWidth(barShot?.before, barRun)}px / ${shotWidth(barShot?.after, barRun)}px wide`);
check('…plus the page at both sizes', ['Page / ', 'Page / · phone'].every((l) => barRun?.screenshots?.some((s) => `${s.label} `.startsWith(l))) , barRun?.screenshots?.map((s) => s.label).join(' | '));
check('desktop notes stay desktop-only', [payRun, modalRun].every((r) => r?.screenshots?.every((s) => !s.label.includes('phone'))));

summary();
console.log(`\nWorkdir: ${DIR}\nCompare pages: ${runs.map((r) => r.comparePath).join(' , ')}`);

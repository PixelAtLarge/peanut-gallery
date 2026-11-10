#!/usr/bin/env node
// Real Claude checking PR descriptions against diffs. Two changes to the example checkout:
//   honest: the description says exactly what the diff does → no findings expected.
//   off:    the description claims something the diff doesn't do, the diff changes something the
//           description doesn't mention, and a reviewer request is only half done → findings.
// Needs Claude signed in (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY), e.g. the sandbox's
// "e2e real Claude" workflow with script=scripts/e2e-description.mjs.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lib = await import(join(ROOT, 'packages/cli/dist/index.js'));
const MODEL = process.env.MODEL ?? lib.withDefaults({ repo: 'o/r' }).models.interpret;

let failed = 0;
let passed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `\n    ${detail.replace(/\n/g, '\n    ')}` : ''}`);
  ok ? passed++ : failed++;
};

/** The example app on a base branch, plus one commit made by `change`. */
function project(change) {
  const dir = mkdtempSync(join(tmpdir(), 'pg-desc-e2e-'));
  cpSync(join(ROOT, 'examples/react-app/src'), join(dir, 'src'), { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'e2e@example.com');
  g('config', 'user.name', 'e2e');
  g('add', '-A');
  g('commit', '-qm', 'base');
  g('checkout', '-qb', 'change');
  change((file, from, to) => {
    const p = join(dir, file);
    const s = readFileSync(p, 'utf8');
    if (!s.includes(from)) throw new Error(`${file}: "${from}" not found`);
    writeFileSync(p, s.replace(from, to));
  });
  g('commit', '-qam', 'change');
  return dir;
}

const savings = (edit) => edit('src/pages/Checkout.jsx', '{applied} applied: 10% off', '{applied} applied: you save {money(subtotal - total)}');

// 1. Honest
{
  const dir = project(savings);
  const r = await lib.descriptionCheck(dir, 'main', {
    title: 'Say what the promo code saves',
    plan: 'When a promo code is applied, the message says how much was saved instead of the percentage.',
    summary: 'Changed the promo-applied message in src/pages/Checkout.jsx to show the amount saved (subtotal minus the discounted total) instead of "10% off".',
    requests: ['Tell me how much I saved, not the percentage.'],
    model: MODEL,
  });
  check('Claude ran the check (honest change)', !!r, r ? '' : 'returned null: Claude unavailable?');
  check('an honest description passes, with no nitpicks', r?.ok === true, r?.detail ?? r?.status ?? '');
}

// 2. Off
{
  const dir = project((edit) => {
    savings(edit);
    // Not mentioned anywhere: the error message turns into a success-coloured note.
    edit('src/styles/app.css', '.promo-error { color: var(--danger);', '.promo-error { color: var(--accent);');
  });
  const r = await lib.descriptionCheck(dir, 'main', {
    title: 'Say what the promo code saves',
    plan: 'When a promo code is applied, the message says how much was saved and shows the new total.',
    // Claims the Apply button changed: it didn't.
    summary: 'Changed the promo-applied message in src/pages/Checkout.jsx to show the amount saved, and made the Apply button use the primary button style so it stands out.',
    requests: ['Show how much I saved and the new total, not just the percentage.'],
    model: MODEL,
  });
  check('Claude ran the check (mismatched change)', !!r, r ? '' : 'returned null: Claude unavailable?');
  check('a mismatched description fails', r?.ok === false, r?.detail ?? '');
  const f = r?.findings ?? [];
  check('…catches the claim that isn’t in the code (Apply button)', f.some((x) => x.kind === 'not-in-code' && /apply/i.test(x.detail)), JSON.stringify(f, null, 1));
  check('…catches the change nobody mentioned (error colour in app.css)', f.some((x) => x.kind === 'not-described' && /(css|colou?r|error|danger|accent)/i.test(x.detail)));
  check('…catches the half-done request (new total)', f.some((x) => /total/i.test(x.detail)));
  console.log(`\nAs it would appear in the PR:\n\n${lib.checksMarkdown([r])}`);
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);

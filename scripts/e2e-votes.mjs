#!/usr/bin/env node
// Real Claude reading real replies: `votes` on a sandbox issue holding two comparison posts and
// a thread of replies, some plain ("after"), some not ("…but keep the old green", "neither…",
// a question, a reply that doesn't say which proposal it means).
//
// Set up the thread first with `node scripts/e2e-votes.mjs --setup` (posts as you, so the replies
// have a human author), then run it where Claude is signed in, e.g. the sandbox's
// "e2e real Claude" workflow (script=scripts/e2e-votes.mjs, issue=<n>), or locally:
//   SANDBOX=owner/repo ISSUE=<n> node scripts/e2e-votes.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = process.env.SANDBOX ?? 'PixelAtLarge/peanut-gallery-sandbox';
const gh = (...args) => {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`gh ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
const comment = (issue, body) => JSON.parse(gh('api', '-X', 'POST', `repos/${SANDBOX}/issues/${issue}/comments`, '-f', `body=${body}`)).id;

const post = (id, title, summary, pr) =>
  [
    `### Proposed update: ${title}`,
    '_1 comment from e2e-reviewer_',
    '',
    summary,
    '',
    `Pull request: https://github.com/${SANDBOX}/pull/${pr}`,
    '',
    '**Which do you prefer?** React 👍 on this comment for **After**, 👎 to keep **Before**, or reply with more feedback (e.g. “after, but keep the old colour”).',
    '',
    `<sub>peanut-gallery proposal \`${id}\`</sub>`,
  ].join('\n');

if (process.argv.includes('--setup')) {
  const issue = JSON.parse(gh('api', '-X', 'POST', `repos/${SANDBOX}/issues`, '-f', 'title=e2e: nuanced vote replies', '-f', 'body=Test thread for scripts/e2e-votes.mjs. Safe to close.', '-f', 'labels[]=peanut-gallery:proposal')).number;
  comment(issue, post('pr_e2e_pay', 'Make “Pay now” the primary action with the total', 'The pay button becomes the filled accent button and shows the order total.', 95));
  comment(issue, 'Before. The old button was clearer to me, honestly.');
  comment(issue, post('pr_e2e_promo', 'Say what the promo code saves', 'The applied message says how much was saved instead of the percentage.', 96));
  comment(issue, 'The pay button one is a big improvement, but can we keep the old green instead of the new accent colour?');
  comment(issue, 'after');
  comment(issue, "Neither for the promo message, honestly. I'd rather see the new total than the amount saved.");
  comment(issue, 'Is this message also shown on the order confirmation page?');
  console.log(`ISSUE=${issue}`);
  process.exit(0);
}

const ISSUE = Number(process.env.ISSUE);
if (!ISSUE) throw new Error('Set ISSUE (from --setup).');
const lib = await import(join(ROOT, 'packages/cli/dist/index.js'));

let failed = 0;
let passed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? passed++ : failed++;
};

// Votes in a scratch project that only knows this issue's posts.
const raw = JSON.parse(gh('api', '--paginate', `repos/${SANDBOX}/issues/${ISSUE}/comments?per_page=100`));
const comments = raw.map((c) => ({ id: c.id, author: c.user.login, body: c.body ?? '', createdAt: c.created_at, url: c.html_url }));
const runs = lib.runsFromComments(ISSUE, comments);
check('found both proposals in the thread', runs.length === 2, runs.map((r) => r.proposalId).join(', '));
const dir = mkdtempSync(join(tmpdir(), 'pg-votes-'));
mkdirSync(join(dir, '.peanut-gallery'));
writeFileSync(join(dir, 'peanut-gallery.config.json'), JSON.stringify({ repo: SANDBOX }));
writeFileSync(join(dir, '.peanut-gallery/runs.json'), JSON.stringify(runs));
process.chdir(dir);

const out = await lib.votesCommand({ local: true });
const pay = out.find((v) => v.proposalId === 'pr_e2e_pay');
const promo = out.find((v) => v.proposalId === 'pr_e2e_promo');
const show = (v) => JSON.stringify(v?.replies.map((r) => [r.lean, r.by, r.note ?? '', r.text.slice(0, 40)]));
const has = (v, text) => v?.replies.find((r) => r.text.startsWith(text));

check('Claude read the replies that needed it', [...(pay?.replies ?? []), ...(promo?.replies ?? [])].some((r) => r.by === 'claude'));
check('every reply counted once, for one proposal', (pay?.replies.length ?? 0) + (promo?.replies.length ?? 0) === 5, `pay ${pay?.replies.length}, promo ${promo?.replies.length}`);
check('“Before. The old button…” → before, on the pay change', has(pay, 'Before.')?.lean === 'before', show(pay));
const green = has(pay, 'The pay button one');
check('“The pay button one…, but keep the old green” → after, on the pay change (though posted under the promo one)', green?.lean === 'after', show(pay));
check('…and the request is kept', /green/i.test(green?.note ?? ''), green?.note);
check('a bare “after” under the promo post → after, on the promo change', has(promo, 'after')?.lean === 'after', show(promo));
const neither = has(promo, 'Neither');
check('“Neither for the promo message…” → neither, with what they want instead', neither?.lean === 'neither' && /total/i.test(neither?.note ?? ''), `${neither?.lean} · ${neither?.note}`);
check('a question is not a vote', has(promo, 'Is this message')?.lean === 'unclear', show(promo));
check('tallies: pay 1–1, promo 1–1 (“neither” counts against)', pay?.after === 1 && pay?.before === 1 && promo?.after === 1 && promo?.before === 1, `pay ${pay?.after}–${pay?.before}, promo ${promo?.after}–${promo?.before}`);
check('the requests are listed for the verdict', pay?.notes.length === 1 && promo?.notes.length >= 1, JSON.stringify([pay?.notes, promo?.notes]));
const cachePath = join(dir, '.peanut-gallery/vote-readings.json');
check("Claude's readings are cached for the next run", existsSync(cachePath) && Object.keys(JSON.parse(readFileSync(cachePath, 'utf8'))).length >= 3);

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);

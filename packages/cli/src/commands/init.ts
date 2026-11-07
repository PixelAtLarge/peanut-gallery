import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import pc from 'picocolors';
import { LABELS } from '@peanut-gallery/core';
import { CONFIG_FILE, ensureWorkDir, type PeanutGalleryConfig } from '../config.js';
import { ensureLabels, gh, git } from '../github.js';
import { detectDesignSystem } from '../design.js';

export async function initCommand(opts: { yes?: boolean; repo?: string; prototypeUrl?: string; dev?: string }) {
  if (existsSync(CONFIG_FILE) && !opts.yes) {
    console.log(pc.yellow(`${CONFIG_FILE} already exists; edit it directly or re-run with --yes to overwrite.`));
    return;
  }
  let detected = '';
  try {
    // Read the origin remote directly (no network); fall back to gh, which needs GraphQL.
    detected = repoFromRemote(await git(['remote', 'get-url', 'origin']));
  } catch {
    /* no origin remote */
  }
  if (!detected) {
    try {
      detected = JSON.parse(await gh(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;
    } catch {
      /* not in a gh-known repo */
    }
  }
  const rl = opts.yes ? null : createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, def: string) => {
    if (!rl) return def;
    const a = (await rl.question(`${q}${def ? pc.dim(` (${def})`) : ''}: `)).trim();
    return a || def;
  };
  const repo = opts.repo ?? (await ask('GitHub repo (owner/name)', detected));
  const prototypeUrl = opts.prototypeUrl ?? (await ask('Hosted prototype URL for "before" screenshots (blank = use local dev server)', ''));
  const devCommand = opts.dev ?? (await ask('Command to run the prototype locally ({port} is substituted)', 'npm run dev -- --port {port}'));
  rl?.close();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('repo must look like owner/name');

  const found = detectDesignSystem(process.cwd());
  const cfg: PeanutGalleryConfig = {
    repo,
    prototypeUrl: prototypeUrl || undefined,
    baseBranch: 'main',
    dev: { command: devCommand, port: 4310 },
    sourceHints: ['src/**'],
    agentNotes: '',
    ...(found.tokens.length || found.docs.length
      ? { designSystem: { ...(found.tokens.length ? { tokens: found.tokens } : {}), ...(found.docs.length ? { docs: found.docs } : {}), rules: '' } }
      : {}),
    models: { interpret: 'claude-haiku-5-5', apply: 'claude-sonnet-5-5' },
    budget: 10,
    screenshot: { width: 1280, height: 800 },
  };
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
  ensureWorkDir();
  console.log(pc.green(`✔ wrote ${CONFIG_FILE}`));
  if (found.tokens.length || found.docs.length) {
    console.log(pc.green(`✔ design system: found ${[...found.tokens, ...found.docs].join(', ')}`) + pc.dim(` — check "designSystem" in ${CONFIG_FILE}; add your component package and rules`));
  } else {
    console.log(pc.dim(`  No token files found. If you use a design system, add a "designSystem" block to ${CONFIG_FILE} (see README).`));
  }
  if (found.guidance.length) console.log(pc.green(`✔ the agent will also read ${found.guidance.join(', ')}`) + pc.dim(' (as text only)'));

  await ensureLabels(repo, [
    { name: LABELS.root, color: '1E4D36', description: 'Created by peanut-gallery' },
    { name: LABELS.feedback, color: 'EAC26C', description: 'Prototype feedback captured with the peanut-gallery widget' },
    { name: LABELS.proposal, color: '6C8EBD', description: 'A peanut-gallery proposal / PR exists for this feedback' },
    { name: LABELS.accepted, color: '0F7B52', description: 'Reviewers preferred the "after"' },
    { name: LABELS.rejected, color: 'A5B0B6', description: 'Reviewers preferred the "before"' },
  ]);
  console.log(pc.green(`✔ labels ensured on ${repo}`));

  console.log(`
${pc.bold('Add the widget to your prototype:')}

  ${pc.cyan(`<script src="https://unpkg.com/@peanut-gallery/widget/dist/peanut-gallery.global.js" data-repo="${repo}" data-activation="query"></script>`)}

  then open the prototype with ${pc.cyan('?peanut')} in the URL. Reviewers click "Comment", click elements, write notes, and "Submit to GitHub".
  For one-click submission without GitHub accounts, deploy @peanut-gallery/relay and add ${pc.cyan('data-relay-url="https://…/api/peanut-gallery"')}.

${pc.bold('Then, in this repo:')}
  ${pc.cyan('npx playwright install chromium')}   ${pc.dim('(once, for screenshots)')}
  ${pc.cyan('claude')} ${pc.dim('then /login (Claude Code) — or export ANTHROPIC_API_KEY=…')}
  ${pc.cyan('npx peanut-gallery review')}            ${pc.dim('pull → interpret → implement → before/after → PRs')}
`);
}

/** `git@github.com:o/r.git`, `https://github.com/o/r(.git)`, `ssh://git@github.com/o/r` → `o/r`. */
export function repoFromRemote(url: string): string {
  const m = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : '';
}

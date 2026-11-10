import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import pc from 'picocolors';
import { initCommand } from './commands/init.js';
import { pullCommand } from './commands/pull.js';
import { interpretCommand } from './commands/interpret.js';
import { applyCommand } from './commands/apply.js';
import { votesCommand } from './commands/votes.js';
import { variantsCommand } from './commands/variants.js';
import { loadConfig, readJson, workPath, writeJson } from './config.js';
import type { RunRecord } from './commands/apply.js';
import type { Proposal } from '@pixelatlarge/peanut-gallery-core';
import { git } from './github.js';

const program = new Command()
  .name('peanut-gallery')
  .description('Turn prototype feedback (GitHub Issues from the peanut-gallery widget) into Claude-implemented design updates with before/after and PRs.')
  .version('0.1.6');

program
  .command('init')
  .description('Create peanut-gallery.config.json and the GitHub labels')
  .option('-y, --yes', 'non-interactive, accept defaults')
  .option('--repo <owner/name>')
  .option('--prototype-url <url>')
  .option('--dev <command>', 'local dev command, {port} substituted')
  .option('--action', 'also add a GitHub Actions workflow that runs the loop automatically (on its own if already set up)')
  .action(wrap(initCommand));

program
  .command('pull')
  .description('Fetch open feedback issues into .peanut-gallery/feedback.json')
  .option('--all', 'include closed issues')
  .option('--new', 'only feedback that has no proposal yet')
  .option('--issue <numbers...>', 'only these issue numbers')
  .action(wrap(pullCommand));

program
  .command('interpret')
  .description('Cluster pulled feedback into change proposals with Claude')
  .action(wrap(() => interpretCommand()));

const applyOpts = (c: Command) =>
  c
    .option('--only <ids...>', 'proposal ids (or id suffixes) to apply')
    .option('--no-pr', 'implement + screenshot but do not push or open PRs')
    .option('--draft', 'open PRs as drafts')
    .option('--no-screenshots', 'skip before/after capture')
    .option('--no-comment', 'do not post comparison back to the issues')
    .option('--include-contested', 'apply contested proposals using the recommended position instead of skipping')
    .option('--budget <usd>', 'stop before a proposal whose estimated agent cost would exceed this spend', (v) => Number(v))
    .option('--port <n>', 'base port for local dev servers', (v) => Number(v));

applyOpts(program.command('apply').description('Implement proposals on branches, capture before/after, open PRs, ask reviewers to vote'))
  .option('--dry-run', 'print the cost estimate and exit')
  .action(wrap(applyCommand));

applyOpts(
  program
    .command('review')
    .description('pull → interpret → (confirm) → apply, in one go')
    .option('-y, --yes', 'skip confirmation')
    .option('--new', 'only feedback that has no proposal yet (what CI should use)')
    .option('--issue <numbers...>', 'only these issue numbers')
    .option('--dry-run', 'stop after interpreting (prints the cost estimate)'),
).action(
  wrap(async (opts: { yes?: boolean; dryRun?: boolean; new?: boolean; issue?: string[] } & Record<string, unknown>) => {
    const issues = await pullCommand({ new: opts.new, issue: opts.issue });
    if (!issues.length) return;
    const proposals = await interpretCommand({ issues });
    if (!proposals.length) return;
    if (opts.dryRun) return void (await applyCommand({ ...opts, proposals, issues, dryRun: true }));
    if (!opts.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const a = (await rl.question(pc.bold(`\nImplement ${proposals.length} proposal(s), capture before/after and open PRs? [y/N] `))).trim().toLowerCase();
      rl.close();
      if (a !== 'y' && a !== 'yes') return console.log(pc.dim('aborted — edit .peanut-gallery/proposals.json and run `peanut-gallery apply` when ready'));
    }
    await applyCommand({ ...opts, proposals, issues });
    console.log(pc.bold('\nDone. When reviewers have voted, run `peanut-gallery votes --label`.'));
  }),
);

program
  .command('decide <proposalId> <option>')
  .description('Resolve a contested proposal by choosing one of its positions (see `interpret` output)')
  .action(
    wrap(async (id: string, option: string) => {
      loadConfig();
      const proposals = readJson<Proposal[]>(workPath('proposals.json'), []);
      const p = proposals.find((x) => x.id === id || x.id.endsWith(id));
      if (!p) throw new Error(`No proposal ${id} in .peanut-gallery/proposals.json`);
      if (!p.contested) throw new Error(`${p.id} is not contested`);
      const n = Number(option);
      const pos = p.contested.positions[n];
      if (!pos) throw new Error(`Option must be 0–${p.contested.positions.length - 1}`);
      p.instructions = pos.instructions;
      p.summary = `${pos.summary} (chosen over: ${p.contested.positions.filter((_, i) => i !== n).map((x) => x.summary).join(' / ')})`;
      p.support = { reviewers: pos.reviewers, count: pos.reviewers.length, annotationCount: pos.annotationIds.length || p.support.annotationCount };
      delete p.contested;
      writeJson(workPath('proposals.json'), proposals);
      console.log(pc.green(`✔ ${p.id} → option ${n}: ${pos.summary}`));
      console.log(pc.dim(`now run: peanut-gallery apply --only ${p.id}`));
    }),
  );

applyOpts(
  program
    .command('variants <proposalId>')
    .description('Generate 1–3 alternative implementations of a proposal, each on its own branch, with a combined before / A / B / C comparison')
    .option('-n, --count <n>', 'how many options (1–3)', (v) => Number(v), 2)
    .option('--note <text>', "builder's steer, e.g. \"first attempt was too heavy; one lighter, one bolder\""),
).action(wrap((id: string, opts: Record<string, unknown>) => variantsCommand(id, opts)));

program
  .command('votes')
  .description('Tally reviewer reactions and replies on posted comparisons (Claude reads replies that are more than a plain vote)')
  .option('--label', 'apply accepted/rejected labels and comment on the PRs')
  .option('--local', 'only proposals in .peanut-gallery/runs.json (skip reading comparisons from GitHub)')
  .option('--keywords', "read replies with keywords only, without Claude")
  .action(wrap(votesCommand));

program
  .command('compare <proposalId>')
  .description('Open the interactive before/after page for a proposal (checks out its compare folder from the branch)')
  .action(
    wrap(async (id: string) => {
      loadConfig();
      const run = readJson<RunRecord[]>(workPath('runs.json'), []).find((r) => r.proposalId === id || r.proposalId.endsWith(id));
      if (!run?.comparePath) throw new Error(`No comparison recorded for ${id}`);
      const dest = workPath('compare', run.proposalId);
      if (!existsSync(join(dest, 'compare.html'))) {
        await git(['fetch', 'origin', run.branch]).catch(() => {});
        await git(['checkout', run.branch, '--', `.peanut-gallery/compare/${run.proposalId}`]);
        await git(['reset', '-q', '--', `.peanut-gallery/compare/${run.proposalId}`]).catch(() => {});
      }
      const file = join(dest, 'compare.html');
      console.log(file);
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      spawn(opener, [file], { shell: process.platform === 'win32', stdio: 'ignore', detached: true }).unref();
    }),
  );

program.parseAsync().catch(fail);

function wrap<T extends unknown[]>(fn: (...args: T) => Promise<unknown>) {
  return async (...args: T) => {
    try {
      await fn(...args);
    } catch (err) {
      fail(err);
    }
  };
}

function fail(err: unknown) {
  console.error(pc.red(`\n✖ ${(err as Error).message}`));
  process.exit(1);
}

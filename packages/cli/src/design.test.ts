import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ prompts: [] as string[] }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { prompt: string }) => {
    sdk.prompts.push(args.prompt);
    return (async function* () {
      yield { type: 'result', subtype: 'success', result: 'Changed the button.', total_cost_usd: 0.1, num_turns: 1 };
    })();
  },
}));

import { designSystemBrief, designSystemSummary, detectDesignSystem, effectivePolicy, readProjectGuidance } from './design.js';
import { checksMarkdown, runChecks } from './checks.js';
import { evaluateToolUse, globToRegExp, isProtected } from './policy.js';
import { implementProposal } from './agent.js';

const ds = { packages: ['@acme/ui'], tokens: ['src/styles/tokens.css'], components: ['src/components/**'], docs: ['docs/design-system.md'], rules: 'Buttons use the primary variant.' };
const tmp = () => mkdtempSync(join(tmpdir(), 'pg-ds-'));

describe('design system', () => {
  it('briefs the agent to read the files, use tokens and not extend the system', () => {
    const b = designSystemBrief(ds);
    expect(b).toContain('`docs/design-system.md`, `src/styles/tokens.css`');
    expect(b).toContain('`@acme/ui`');
    expect(b).toMatch(/No raw hex/);
    expect(b).toMatch(/do not add it/);
    expect(b).toContain('Buttons use the primary variant.');
    expect(designSystemBrief({ ...ds, allowEdits: true })).toMatch(/may extend the tokens/);
    expect(designSystemBrief(undefined)).toBe('');
    expect(designSystemBrief({ rules: '  ' })).toBe('');
  });

  it('summarises for interpret/variants without file contents', () => {
    const s = designSystemSummary(ds);
    expect(s).toContain('@acme/ui');
    expect(s).toMatch(/existing tokens and components/);
    expect(designSystemSummary({})).toBe('');
  });

  it('protects token and doc files from edits unless allowEdits', () => {
    const policy = effectivePolicy({ protectedPaths: ['legal/'] }, { ...ds, tokens: ['src/tokens/**'] });
    expect(isProtected('src/tokens/color.json', policy)).toMatch(/protected/);
    expect(isProtected('docs/design-system.md', policy)).toMatch(/protected/);
    expect(isProtected('legal/terms.md', policy)).toMatch(/protected/);
    expect(isProtected('src/components/Button.tsx', policy)).toBeNull();
    expect(effectivePolicy({}, { ...ds, allowEdits: true }).protectedPaths ?? []).toEqual([]);
  });

  it('reads CLAUDE.md / AGENTS.md as text, honours false and custom lists, caps size', () => {
    const d = tmp();
    writeFileSync(join(d, 'CLAUDE.md'), '# Conventions\nUse CSS modules.');
    writeFileSync(join(d, 'AGENTS.md'), 'x'.repeat(9000));
    writeFileSync(join(d, 'STYLE.md'), 'Sentence case for labels.');
    const g = readProjectGuidance(d);
    expect(g.files).toEqual(['CLAUDE.md', 'AGENTS.md']);
    expect(g.text).toContain('Use CSS modules.');
    expect(g.text).toContain('…(truncated)');
    expect(g.text.length).toBeLessThan(13000);
    expect(readProjectGuidance(d, false).files).toEqual([]);
    expect(readProjectGuidance(d, ['STYLE.md']).text).toContain('Sentence case');
  });

  it('detects token files and design docs, skipping node_modules and build output', () => {
    const d = tmp();
    mkdirSync(join(d, 'src/styles'), { recursive: true });
    mkdirSync(join(d, 'node_modules/x'), { recursive: true });
    mkdirSync(join(d, 'dist'), { recursive: true });
    mkdirSync(join(d, 'docs'), { recursive: true });
    for (const f of ['tailwind.config.ts', 'src/styles/tokens.css', 'src/styles/_variables.scss', 'node_modules/x/tokens.css', 'dist/theme.css', 'docs/design-system.md', 'src/app.css', 'CLAUDE.md']) writeFileSync(join(d, f), '');
    const found = detectDesignSystem(d);
    expect(found.tokens).toEqual(['src/styles/_variables.scss', 'src/styles/tokens.css', 'tailwind.config.ts']);
    expect(found.docs).toEqual(['docs/design-system.md']);
    expect(found.guidance).toEqual(['CLAUDE.md']);
  });

  it('puts the design system and project guidance in the agent prompt, inside the rules', async () => {
    const d = tmp();
    await implementProposal(
      { id: 'pr_1', title: 'Primary pay button', summary: 's', instructions: 'i', annotationIds: [], issueNumbers: [1], effort: 'small', confidence: 1 } as never,
      [],
      { cwd: d, model: 'm', sourceHints: ['src/**'], designSystem: ds, projectGuidance: { files: ['CLAUDE.md'], text: '### CLAUDE.md\nUse CSS modules.' } },
    );
    const prompt = sdk.prompts.at(-1)!;
    expect(prompt).toContain('## Design system');
    expect(prompt).toContain('<project_guidance>\n### CLAUDE.md\nUse CSS modules.');
    expect(prompt.indexOf('<project_guidance>')).toBeLessThan(prompt.indexOf('## Rules'));
    expect(prompt).toMatch(/as described in the Design system section/);
  });
});

describe('policy hardening', () => {
  it('matches globs', () => {
    expect(globToRegExp('src/tokens/**').test('src/tokens/a/b.json')).toBe(true);
    expect(globToRegExp('**/*.tokens.{json,css}').test('a/b/c.tokens.css')).toBe(true);
    expect(globToRegExp('**/*.tokens.{json,css}').test('c.tokens.css')).toBe(true);
    expect(globToRegExp('src/*.css').test('src/a/b.css')).toBe(false);
  });

  it('never lets the agent write into node_modules (it links to the real install)', () => {
    const d = tmp();
    expect(evaluateToolUse('Edit', { file_path: join(d, 'node_modules/@acme/ui/dist/index.js') }, { cwd: d, policy: {} }).allow).toBe(false);
    expect(evaluateToolUse('Read', { file_path: join(d, 'node_modules/@acme/ui/README.md') }, { cwd: d, policy: {} }).allow).toBe(true);
  });

  it('refuses reads and writes through links that leave the worktree', () => {
    const outside = tmp();
    writeFileSync(join(outside, 'secret.txt'), 'nope');
    const wt = tmp();
    symlinkSync(outside, join(wt, 'escape'));
    const decide = (tool: string, p: string, readRoots?: string[]) => evaluateToolUse(tool, { file_path: join(wt, p) }, { cwd: wt, policy: {}, readRoots });
    expect(decide('Read', 'escape/secret.txt').allow).toBe(false);
    expect(decide('Write', 'escape/new.txt').allow).toBe(false);
    expect(decide('Write', 'escape/new.txt').reason).toMatch(/link that leaves the worktree/);
    // ...unless the target is an allowed read root (the main checkout's node_modules)
    expect(decide('Read', 'escape/secret.txt', [outside]).allow).toBe(true);
    // ordinary new files are fine
    expect(decide('Write', 'src/new/file.css').allow).toBe(true);
  });
});

describe('checks', () => {
  it('runs commands in the worktree with the changed files, and reports pass / fail / timeout', async () => {
    const d = tmp();
    const res = await runChecks(
      [
        { name: 'lists files', command: 'printf "%s" "$PEANUT_GALLERY_CHANGED_FILES" | wc -l; test "$PEANUT_GALLERY_BASE" = main' },
        { name: 'drift', command: 'echo "styles.css:3 raw hex #0F7B52"; exit 1', required: true },
        { name: 'slow', command: 'sleep 5', timeoutSec: 0.3 },
      ],
      d,
      { changedFiles: ['index.html', 'styles.css'], base: 'main', proposalId: 'pr_1' },
    );
    expect(res.map((r) => r.ok)).toEqual([true, false, false]);
    expect(res[0].output.trim()).toBe('1');
    expect(res[1]).toMatchObject({ required: true, exitCode: 1 });
    expect(res[2].timedOut).toBe(true);
    const md = checksMarkdown(res);
    expect(md).toContain('✅ **lists files**');
    expect(md).toContain('❌ **drift** — failed (exit 1)');
    expect(md).toContain('raw hex #0F7B52');
    expect(md).toContain('⚠️ **slow** — timed out');
    expect(checksMarkdown([])).toBe('');
  });
});

describe('work folder', () => {
  it('git-ignores local compare copies, and adds missing entries to an existing ignore file', async () => {
    const { ensureWorkDir } = await import('./config.js');
    const { readFileSync: read, writeFileSync: write, mkdirSync: mk } = await import('node:fs');
    const d = tmp();
    const cwd = process.cwd();
    try {
      process.chdir(d);
      ensureWorkDir();
      expect(read(join(d, '.peanut-gallery/.gitignore'), 'utf8').split('\n')).toEqual(expect.arrayContaining(['worktrees/', 'compare/', 'runs.json']));
      const d2 = tmp();
      process.chdir(d2);
      mk(join(d2, '.peanut-gallery'));
      write(join(d2, '.peanut-gallery/.gitignore'), 'worktrees/\nfeedback.json\nproposals.json\nruns.json\nmy-notes.txt');
      ensureWorkDir();
      const lines = read(join(d2, '.peanut-gallery/.gitignore'), 'utf8').split('\n');
      expect(lines).toContain('compare/');
      expect(lines).toContain('my-notes.txt');
      expect(lines.filter((l) => l === 'worktrees/')).toHaveLength(1);
    } finally {
      process.chdir(cwd);
    }
  });
});

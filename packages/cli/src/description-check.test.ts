import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { changeDiff, descriptionCheck, findingsMarkdown } from './description-check.js';
import { checksMarkdown } from './checks.js';

/** A repo with a base branch and one change on top: a promo message, a lockfile, our artifacts. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'pg-desc-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/Checkout.jsx'), '<p>{applied} applied: 10% off</p>\n');
  writeFileSync(join(dir, 'package-lock.json'), '{}\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  g('checkout', '-qb', 'change');
  writeFileSync(join(dir, 'src/Checkout.jsx'), '<p>{applied} applied: you save {money(subtotal - total)}</p>\n');
  writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
  mkdirSync(join(dir, '.peanut-gallery'));
  writeFileSync(join(dir, '.peanut-gallery/summary.png'), 'png');
  g('add', '-A');
  g('commit', '-qm', 'change');
  return dir;
}

function fakeClient(findings: unknown[]) {
  const create = vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify({ findings }) }] }));
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

const input = { title: 'Say what the promo code saves', plan: 'The applied message shows the amount saved.', summary: 'Changed the promo message to show the amount saved.', requests: ['Show how much I saved'], model: 'm' };

describe('description check', () => {
  it('diffs the change without lockfiles or our own artifacts', async () => {
    const d = await changeDiff(repo(), 'main');
    expect(d.files).toEqual(['src/Checkout.jsx']);
    expect(d.diff).toContain('+<p>{applied} applied: you save');
    expect(d.diff).not.toContain('lockfileVersion');
    expect(d.cut).toBe(false);
  });

  it('passes when Claude finds nothing, and sends it the plan, summary, requests and diff', async () => {
    const { client, create } = fakeClient([]);
    const r = await descriptionCheck(repo(), 'main', { ...input, client });
    expect(r).toMatchObject({ ok: true, name: 'Description matches the code', status: 'checked against the diff' });
    const sent = (create.mock.calls[0] as unknown as [{ messages: { content: string }[] }])[0].messages[0].content;
    for (const s of [input.plan, input.summary, 'Show how much I saved', 'you save {money(subtotal - total)}', 'src/Checkout.jsx']) expect(sent).toContain(s);
  });

  it('lists what does not match, grouped, and drops anything malformed', async () => {
    const { client } = fakeClient([
      { kind: 'not-in-code', detail: 'The description says the Apply button is now primary; the diff does not touch it.' },
      { kind: 'not-described', detail: 'src/styles/app.css changes the promo colour, which is not mentioned.' },
      { kind: 'request-missed', detail: 'The reviewer asked for the new total; only the amount saved is shown.' },
      { kind: 'vibes', detail: 'nope' },
      { kind: 'not-in-code' },
    ]);
    const r = await descriptionCheck(repo(), 'main', { ...input, client, required: true });
    expect(r?.ok).toBe(false);
    expect(r?.required).toBe(true);
    expect(r?.findings).toHaveLength(3);
    expect(r?.status).toBe('3 things to look at');
    expect(r?.detail).toBe(findingsMarkdown(r!.findings));
    expect(r?.detail).toMatch(/^\*\*Described, but not in the code\*\*\n- The description says the Apply button/);
    expect(r?.detail).toContain('**In the code, but not described**\n- src/styles/app.css');
    expect(r?.detail).toContain('**Reviewer request not addressed**\n- The reviewer asked for the new total');
    // Findings are shown in the PR, not folded into an "output" block.
    const md = checksMarkdown([r!]);
    expect(md).toContain('❌ **Description matches the code** — 3 things to look at\n\n**Described, but not in the code**');
    expect(md).not.toContain('<details>');
  });

  it('skips quietly when Claude is unavailable or there is nothing to compare', async () => {
    const client = { messages: { create: vi.fn(async () => Promise.reject(new Error('no login'))) } } as unknown as Anthropic;
    expect(await descriptionCheck(repo(), 'main', { ...input, client })).toBeNull();
    const dir = repo();
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: dir });
    expect(await descriptionCheck(dir, 'main', { ...input, client: fakeClient([]).client })).toBeNull();
  });
});

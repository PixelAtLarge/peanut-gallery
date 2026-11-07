import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { addedClassesFromDiff, classesInLine, undefinedClassesCheck } from './builtin-checks.js';

const BASE_HTML = '<link rel="stylesheet" href="styles.css">\n<button class="btn" data-testid="pay">Pay now</button>\n';
const BASE_CSS = '.btn { padding: 9px 16px; }\n';

/** A git repo on `main` with the checkout button, then `change` applied and committed on a branch. */
function repo(change: Record<string, string>, base: Record<string, string> = {}): string {
  const d = mkdtempSync(join(tmpdir(), 'pg-cls-'));
  const run = (...a: string[]) => execFileSync('git', a, { cwd: d, stdio: 'pipe' });
  run('init', '-q', '-b', 'main');
  for (const [f, c] of Object.entries({ 'index.html': BASE_HTML, 'styles.css': BASE_CSS, ...base })) writeFileSync(join(d, f), c);
  run('add', '-A');
  run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  run('checkout', '-qb', 'change');
  for (const [f, c] of Object.entries(change)) writeFileSync(join(d, f), c);
  run('add', '-A');
  run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'change');
  return d;
}

describe('undefined classes check', () => {
  it('flags the PR #26 mistake: a modifier class added to markup but never styled', async () => {
    const d = repo({ 'index.html': BASE_HTML.replace('class="btn"', 'class="btn btn--primary"') });
    const r = await undefinedClassesCheck(d, 'main');
    expect(r?.ok).toBe(false);
    expect(r?.output).toContain('.btn--primary  (index.html)');
    expect(r?.output).not.toContain('.btn ');
  });

  it('passes when the same change defines the class (PR #28)', async () => {
    const d = repo({
      'index.html': BASE_HTML.replace('class="btn"', 'class="btn btn--primary"'),
      'styles.css': BASE_CSS + '.btn--primary, .btn--primary:hover { background: var(--accent); }\n',
    });
    expect((await undefinedClassesCheck(d, 'main'))?.ok).toBe(true);
  });

  it('counts classes styled in an inline <style> block or used as script hooks', async () => {
    const d = repo({
      'index.html': BASE_HTML.replace('class="btn"', 'class="btn btn-hero js-pay"') + '<style>.btn-hero{font-weight:700}</style>\n',
      'app.js': "document.querySelector('.js-pay').addEventListener('click', pay);\n",
    });
    expect((await undefinedClassesCheck(d, 'main'))?.ok).toBe(true);
  });

  it('only looks at classes the change added (not ones that were already there)', async () => {
    const d = repo({ 'index.html': BASE_HTML.replace('Pay now', 'Pay $150.50') }, { 'index.html': BASE_HTML.replace('class="btn"', 'class="btn legacy-undefined"') });
    expect(await undefinedClassesCheck(d, 'main')).toBeNull();
  });

  it('skips utility-CSS projects and can be required', async () => {
    const tw = repo({ 'index.html': BASE_HTML.replace('class="btn"', 'class="btn px-4 bg-blue-600"') }, { 'tailwind.config.js': 'module.exports = {}\n' });
    expect(await undefinedClassesCheck(tw, 'main')).toBeNull();
    const d = repo({ 'index.html': BASE_HTML.replace('class="btn"', 'class="btn btn--primary"') });
    expect((await undefinedClassesCheck(d, 'main', { required: true }))?.required).toBe(true);
  });

  it('parses class attributes in HTML and JSX, ignoring dynamic and utility-variant syntax', () => {
    expect(classesInLine('<a class="btn btn--primary" href="#">')).toEqual(['btn', 'btn--primary']);
    expect(classesInLine('<Button className="card-title" />')).toEqual(['card-title']);
    expect(classesInLine("<div className={'a b'}>")).toEqual(['a', 'b']);
    expect(classesInLine('<div className={`x ${y}`}>')).toEqual(['x']);
    expect(classesInLine('<div class="hover:bg-red w-[2px] p-4/50 ok">')).toEqual(['ok']);
    expect(addedClassesFromDiff('+++ b/styles.css\n+.a { }\n')).toEqual([]);
    expect(addedClassesFromDiff('+++ b/.peanut-gallery/compare/p/compare.html\n+<div class="stage">\n+++ b/dist/x.html\n+<i class="y">')).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { locateSources, resolveFile, searchSource, searchTokens, uiFiles, whereToLook } from './source-locate.js';

/** A small shop repo, committed. */
function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'pg-src-'));
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir });
  g('init', '-q');
  g('add', '-A');
  g('-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', 'x');
  return dir;
}

const shop = {
  'src/pages/Cart.jsx': 'export default function Cart() {\n  return (<ul className="cart-list">\n    <CartRow />\n    <Link to="/checkout" className="btn" data-testid="to-checkout">Continue to checkout</Link>\n  </ul>);\n}\n',
  'src/pages/Checkout.jsx': 'export default function Checkout() {\n  return (<form aria-describedby="pay">\n    <div className="summary"><span>Total</span><span data-testid="total">{money(total)}</span></div>\n    <button className="btn" data-testid="pay">Pay now</button>\n  </form>);\n}\n',
  'src/styles/app.css': '.summary { display: flex; }\n.cart-list { padding: 0; }\n',
  'src/pages/Checkout.test.jsx': 'it("pays", () => screen.getByTestId("pay"));\n',
  'node_modules/lib/index.js': 'data-testid="pay"\n',
  'README.md': 'Continue to checkout\n',
};
const anchor = (selector: string, textFingerprint = '') => ({ selector, tag: 'button', textFingerprint, rect: { x: 0, y: 0, width: 1, height: 1 }, offset: { x: 0.5, y: 0.5 } });

describe('finding the file behind an element', () => {
  it('matches a hint path to the repo, without guessing between lookalikes', () => {
    const files = ['src/App.vue', 'src/components/Row.tsx', 'apps/web/src/components/Row.tsx', 'src/pages/Cart.jsx'];
    expect(resolveFile('src/pages/Cart.jsx', files)).toBe('src/pages/Cart.jsx');
    expect(resolveFile('src/projects/shop/src/App.vue', files)).toBe('src/App.vue');
    expect(resolveFile('web/src/components/Row.tsx', files)).toBe('apps/web/src/components/Row.tsx');
    expect(resolveFile('Row.tsx', files)).toBeNull();
    expect(resolveFile('src/Gone.jsx', files)).toBeNull();
  });

  it('knows which files are UI code', async () => {
    expect((await uiFiles(repo(shop))).sort()).toEqual(['src/pages/Cart.jsx', 'src/pages/Checkout.jsx', 'src/styles/app.css']);
  });

  it('searches for test ids, ids, text and distinctive classes', () => {
    expect(searchTokens({ anchor: anchor('main > form > button[data-testid="pay"]', 'Pay $104.00') }).map((t) => t.label)).toEqual(['test id "pay"', 'text "Pay"']);
    expect(searchTokens({ anchor: anchor('#hero .headline.mt-4.css-1x2y3z', 'Grow something') }).map((t) => t.label)).toEqual(['id "hero"', 'text "Grow something"', 'class "headline"']);
  });

  it("finds the markup that renders it, with the line, ignoring tests and dependencies", async () => {
    const dir = repo(shop);
    const files = await uiFiles(dir);
    expect(await searchSource({ anchor: anchor('form > button[data-testid="pay"]', 'Pay $104.00') }, dir, files)).toEqual({ file: 'src/pages/Checkout.jsx', line: 4, components: [], from: 'search', matched: ['test id "pay"', 'text "Pay"'] });
    const total = await searchSource({ anchor: anchor('div.summary > span', 'Total') }, dir, files);
    expect(total).toMatchObject({ file: 'src/pages/Checkout.jsx', line: 3, from: 'search', also: ['src/styles/app.css'] });
    // A lone class, or nothing to go on: no guess.
    expect(await searchSource({ anchor: anchor('ul.cart-list') }, dir, files)).toBeNull();
    expect(await searchSource({ anchor: anchor('div > span') }, dir, files)).toBeNull();
  });

  it("uses the app's hint when the file is here, searches when it isn't, and says where to look", async () => {
    const dir = repo(shop);
    const base = { pageUrl: 'http://x/', viewport: { width: 1, height: 1 }, createdAt: 'now', issueNumber: 1, issueUrl: '', reviewer: 'r' };
    const notes = [
      { ...base, id: 'a', text: 'Make the checkout link a button', anchor: anchor('a[data-testid="to-checkout"]', 'Continue to checkout'), source: { framework: 'react' as const, components: ['Cart'], file: '/Users/anna/shop/src/pages/Cart.jsx', line: 4 } },
      { ...base, id: 'b', text: 'Pay should be the main action', anchor: anchor('button[data-testid="pay"]', 'Pay now'), source: { framework: 'react' as const, components: ['Checkout'], file: 'src/pages/Old.jsx' } },
      { ...base, id: 'c', text: 'What is this?', anchor: anchor('div > i') },
    ];
    const found = await locateSources(notes, dir);
    expect(found.get('a')).toEqual({ file: 'src/pages/Cart.jsx', line: 4, components: ['Cart'], from: 'app' });
    expect(found.get('b')).toMatchObject({ file: 'src/pages/Checkout.jsx', from: 'search', components: ['Checkout'] });
    expect(found.has('c')).toBe(false);
    expect(whereToLook(notes, found)).toEqual([
      '"Make the checkout link a button" → src/pages/Cart.jsx:4 (from the running app: component Cart)',
      '"Pay should be the main action" → src/pages/Checkout.jsx:4 (found by searching the code for test id "pay", text "Pay now")',
    ]);
  });
});

// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { buildSelector, createAnchor, resolveAnchor, sessionToIssue, issueToSession, newIssueUrl, stepPhrase, stepsPhrase, isPrivateField, isTypingField, fieldName, standInValue } from './index.js';
import type { ReviewSession } from './index.js';

function page(html: string) {
  document.body.innerHTML = html;
  return document;
}

describe('anchors', () => {
  it('prefers data-testid and ids', () => {
    page(`<main><section><button data-testid="save">Save</button><p id="hint">Hi</p></section></main>`);
    expect(buildSelector(document.querySelector('button')!)).toBe('button[data-testid="save"]');
    expect(buildSelector(document.querySelector('p')!)).toBe('#hint');
  });

  it('falls back to a structural path with nth-of-type', () => {
    page(`<main><ul><li>a</li><li>b</li><li>c</li></ul></main>`);
    const li = document.querySelectorAll('li')[1];
    expect(buildSelector(li)).toBe('body > main > ul > li:nth-of-type(2)');
    expect(resolveAnchor(createAnchor(li, 0, 0), document).el).toBe(li);
  });

  it('survives reordering via text fingerprint', () => {
    page(`<main><ul><li>Apples</li><li>Bananas</li></ul></main>`);
    const anchor = createAnchor(document.querySelectorAll('li')[1], 0, 0);
    page(`<main><ul><li>Bananas</li><li>Apples</li><li>Cherries</li></ul></main>`);
    const { el, confidence } = resolveAnchor(anchor, document);
    expect(el?.textContent).toBe('Bananas');
    expect(confidence).toBeGreaterThan(0.5);
  });

  it('survives a moved element when the selector breaks', () => {
    page(`<div><section><h2>Pricing</h2><button class="cta">Start free trial</button></section></div>`);
    const anchor = createAnchor(document.querySelector('button')!, 0, 0);
    expect(anchor.context).toBe('Pricing');
    page(`<div><header></header><aside><button class="primary">Start free trial</button></aside></div>`);
    const { el } = resolveAnchor(anchor, document);
    expect(el?.textContent).toBe('Start free trial');
  });

  it('ignores hashed class names', () => {
    page(`<div class="css-1a2b3c4d card"><span class="sc-f00dbeef">x</span></div>`);
    expect(buildSelector(document.querySelector('span')!)).toBe('body > div.card > span');
  });
});

const session: ReviewSession = {
  id: 'rs_1',
  prototypeUrl: 'https://proto.example.com',
  createdAt: '2026-11-05T00:00:00.000Z',
  author: 'anna',
  annotations: [
    {
      id: 'an_1',
      text: 'This button is too small\nAnd the label is unclear',
      kind: 'visual',
      pageUrl: 'https://proto.example.com/checkout',
      viewport: { width: 1280, height: 800 },
      createdAt: '2026-11-05T00:00:00.000Z',
      anchor: {
        selector: 'button[data-testid="pay"]',
        textFingerprint: 'Pay now',
        tag: 'button',
        rect: { x: 10.5, y: 20.25, width: 100, height: 40 },
        offset: { x: 0.5, y: 0.5 },
        context: 'Checkout',
      },
    },
  ],
};

describe('issue format', () => {
  it('round-trips a session through an issue body', () => {
    const { title, body } = sessionToIssue(session);
    expect(title).toBe('Feedback: 1 comment on /checkout');
    expect(body).toContain('### 1. [visual] This button is too small');
    expect(issueToSession(body)).toEqual(session);
  });

  it('shows and round-trips the clicks that led to a note', () => {
    const step = { ...session.annotations[0].anchor, selector: 'button[data-testid="remove"]', textFingerprint: 'Remove', tag: 'button' };
    const withSteps: ReviewSession = { ...session, annotations: [{ ...session.annotations[0], steps: [step] }] };
    const { body } = sessionToIssue(withSteps);
    expect(body).toContain('- **Reached by:** clicking “Remove”');
    expect(issueToSession(body)).toEqual(withSteps);
  });

  it('returns null for unrelated bodies', () => {
    expect(issueToSession('just an ordinary issue')).toBeNull();
  });

  it('builds a new-issue URL that fits within limits', () => {
    const big: ReviewSession = {
      ...session,
      annotations: Array.from({ length: 40 }, (_, i) => ({
        ...session.annotations[0],
        id: `an_${i}`,
        text: 'Lorem ipsum dolor sit amet '.repeat(6),
      })),
    };
    const url = newIssueUrl('owner/repo', big, ['peanut-gallery:feedback']);
    expect(url.startsWith('https://github.com/owner/repo/issues/new?')).toBe(true);
    expect(url.length).toBeLessThanOrEqual(7500);
    const params = new URL(url).searchParams;
    expect(params.get('labels')).toBe('peanut-gallery:feedback');
    const parsed = issueToSession(params.get('body')!);
    expect(parsed?.annotations.length).toBeGreaterThan(0);
  });
});

describe('sessionToIssue with partial notes', () => {
  it('omits the viewport line instead of throwing when a note has none', () => {
    const s = { id: 'rs_1', prototypeUrl: 'https://p', createdAt: 'x', annotations: [{ id: 'an_1', text: 'hi', kind: 'copy', pageUrl: 'https://p/', anchor: { selector: 'h1', textFingerprint: 'Hi', tag: 'h1', rect: { x: 0, y: 0, width: 1, height: 1 }, offset: { x: 0.5, y: 0.5 } }, createdAt: 'x' }] };
    const { body } = sessionToIssue(s as never);
    expect(body).toContain('`h1` → `h1`');
    expect(body).not.toContain('Viewport');
  });
});

describe('steps', () => {
  const base = { selector: 'input#q', tag: 'input', textFingerprint: '', rect: { x: 0, y: 0, width: 1, height: 1 }, offset: { x: 0.5, y: 0.5 } };
  it('reads as a sentence', () => {
    expect(stepPhrase({ ...base, selector: 'button#f', tag: 'button', textFingerprint: 'Filters' })).toBe('clicking “Filters”');
    expect(stepPhrase({ ...base, action: 'type', value: 'blue lamp', field: 'Search' })).toBe('typing “blue lamp” into “Search”');
    expect(stepPhrase({ ...base, action: 'type', masked: true, field: 'Email' })).toBe('filling in “Email”');
    expect(stepPhrase({ ...base, action: 'select', value: 'Large', field: 'Size' })).toBe('choosing “Large” in “Size”');
    expect(stepPhrase({ ...base, action: 'enter', field: 'Search' })).toBe('pressing Enter');
    expect(stepsPhrase([{ ...base, action: 'type', value: 'x', field: 'Search' }, { ...base, action: 'enter' }])).toBe('typing “x” into “Search” → pressing Enter');
  });

  it('shows typing in the issue, never a private value', () => {
    const s: ReviewSession = {
      id: 's', prototypeUrl: 'https://p.test', createdAt: 'now',
      annotations: [{ id: 'a', text: 'Say how many matched', anchor: base, pageUrl: 'https://p.test/', viewport: { width: 1, height: 1 }, createdAt: 'now',
        steps: [{ ...base, action: 'type', masked: true, field: 'Email' }, { ...base, action: 'type', value: 'lamp', field: 'Search' }, { ...base, action: 'enter' }] }],
    };
    expect(sessionToIssue(s).body).toContain('- **Reached by:** filling in “Email” → typing “lamp” into “Search” → pressing Enter');
  });
});

describe('fields', () => {
  it('knows text fields, their names, and which are private', () => {
    page(`<form>
      <label>Search <input id="q"></label>
      <input id="promo" placeholder="Promo code">
      <input id="em" type="email" aria-label="Email">
      <input id="pw" type="password" name="pw">
      <input id="card" name="cardNumber">
      <input id="addr" placeholder="Street, city, ZIP">
      <input id="nick" autocomplete="name">
      <div data-private><input id="marked"></div>
      <input id="fs" class="fs-exclude">
      <input id="cb" type="checkbox">
      <textarea id="msg" aria-labelledby="ml"></textarea><span id="ml">Gift message</span>
      <label>Size <select id="size"><option>Small</option><option>Large</option></select></label>
    </form>`);
    const $ = (id: string) => document.getElementById(id)!;
    expect(isTypingField($('q'))).toBe(true);
    expect(isTypingField($('msg'))).toBe(true);
    expect(isTypingField($('cb'))).toBe(false);
    expect(fieldName($('q'))).toBe('Search');
    expect(fieldName($('promo'))).toBe('Promo code');
    expect(fieldName($('msg'))).toBe('Gift message');
    expect(fieldName($('size'))).toBe('Size');
    for (const id of ['q', 'promo', 'msg', 'size']) expect(isPrivateField($(id)), id).toBe(false);
    for (const id of ['em', 'pw', 'card', 'addr', 'nick', 'marked', 'fs']) expect(isPrivateField($(id)), id).toBe(true);
    expect(standInValue($('em'))).toBe('reviewer@example.com');
    expect(standInValue($('addr'))).toBe('1 Example Street');
    expect(standInValue($('nick'))).toBe('Alex Example');
    expect(standInValue($('pw'))).toBeNull();
    expect(standInValue($('card'))).toBeNull();
    expect(standInValue($('marked'))).toBeNull();
  });
});

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PeanutGalleryWidget, normalizePageUrl } from './widget.js';
import { MAX_STEPS } from '@pixelatlarge/peanut-gallery-core';

// Node 25+ ships its own Web Storage `localStorage` global, which hides jsdom's in this
// environment (and has no methods unless Node is given --localstorage-file). Use jsdom's.
const jsdomStorage = (globalThis as { jsdom?: { window: Window } }).jsdom?.window.localStorage;
if (jsdomStorage && typeof (globalThis.localStorage as Storage | undefined)?.clear !== 'function') {
  Object.defineProperty(globalThis, 'localStorage', { value: jsdomStorage, configurable: true, writable: true });
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = `<main><h1>Checkout</h1><button data-testid="pay">Pay now</button></main>`;
  document.querySelectorAll('peanut-gallery').forEach((n) => n.remove());
});

const frame = () => new Promise((r) => setTimeout(r, 40));

function shadow(w: PeanutGalleryWidget): ShadowRoot {
  return document.querySelector('peanut-gallery')!.shadowRoot!;
}

describe('widget', () => {
  it('mounts in a shadow root and adds a note on click', () => {
    const w = new PeanutGalleryWidget({ repo: 'owner/repo', author: 'anna' }).mount();
    const sr = shadow(w);
    (sr.querySelector('[data-role=comment]') as HTMLButtonElement).click();
    const btn = document.querySelector('button[data-testid="pay"]')!;
    btn.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, composed: true, clientX: 5, clientY: 5 }));
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, clientX: 5, clientY: 5 }));
    const ta = sr.querySelector('textarea') as HTMLTextAreaElement;
    expect(ta).toBeTruthy();
    ta.value = 'Make this primary and bigger';
    (sr.querySelector('.pg-composer .pg-primary') as HTMLButtonElement).click();

    const notes = w.getAnnotations();
    expect(notes).toHaveLength(1);
    expect(notes[0].anchor.selector).toBe('button[data-testid="pay"]');
    expect(notes[0].anchor.context).toBe('Checkout');
    expect(sr.querySelectorAll('.pg-pin')).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem('peanut-gallery:owner/repo')!).annotations).toHaveLength(1);
  });

  it('restores notes from localStorage and opens a GitHub issue URL on submit', () => {
    const w1 = new PeanutGalleryWidget({ repo: 'owner/repo', author: 'anna' }).mount();
    const sr1 = shadow(w1);
    (sr1.querySelector('[data-role=comment]') as HTMLButtonElement).click();
    const h1 = document.querySelector('h1')!;
    h1.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, composed: true }));
    h1.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    (sr1.querySelector('textarea') as HTMLTextAreaElement).value = 'Title should say Payment';
    (sr1.querySelector('.pg-composer .pg-primary') as HTMLButtonElement).click();
    w1.destroy();

    const w2 = new PeanutGalleryWidget({ repo: 'owner/repo', author: 'anna' }).mount();
    expect(w2.getAnnotations()).toHaveLength(1);
    const sr2 = shadow(w2);
    (sr2.querySelector('[data-role=review]') as HTMLButtonElement).click();
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    (sr2.querySelector('.pg-panel .pg-primary') as HTMLButtonElement).click();
    expect(open).toHaveBeenCalledTimes(1);
    const url = new URL(open.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/owner/repo/issues/new');
    expect(url.searchParams.get('labels')).toBe('peanut-gallery,peanut-gallery:feedback');
    expect(url.searchParams.get('body')).toContain('Title should say Payment');
  });

  it('hands the session to onSubmit, then clears pins, count and panel', async () => {
    const received: unknown[] = [];
    const w = new PeanutGalleryWidget({ repo: 'owner/repo', author: 'anna', onSubmit: (s) => void received.push(s) }).mount();
    const sr = shadow(w);
    (sr.querySelector('[data-role=comment]') as HTMLButtonElement).click();
    const h1 = document.querySelector('h1')!;
    h1.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, composed: true }));
    h1.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    (sr.querySelector('textarea') as HTMLTextAreaElement).value = 'Say Payment';
    (sr.querySelector('.pg-composer .pg-primary') as HTMLButtonElement).click();
    (sr.querySelector('[data-role=review]') as HTMLButtonElement).click();
    const btn = sr.querySelector('.pg-panel .pg-primary') as HTMLButtonElement;
    expect(btn.textContent).toBe('Submit');
    const open = vi.spyOn(window, 'open');
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(open).not.toHaveBeenCalled();
    expect(received).toHaveLength(1);
    expect((received[0] as { annotations: { text: string }[] }).annotations[0].text).toBe('Say Payment');
    expect(w.getAnnotations()).toHaveLength(0);
    expect(sr.querySelectorAll('.pg-pin')).toHaveLength(0);
    expect(sr.querySelector('[data-role=count]')!.textContent).toBe('0');
    expect(sr.querySelector('.pg-panel')).toBeNull();
  });

  it('keeps the notes when onSubmit throws or asks to keep them', async () => {
    const add = (sr: ShadowRoot) => {
      (sr.querySelector('[data-role=comment]') as HTMLButtonElement).click();
      const h1 = document.querySelector('h1')!;
      h1.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, composed: true }));
      h1.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
      (sr.querySelector('textarea') as HTMLTextAreaElement).value = 'x';
      (sr.querySelector('.pg-composer .pg-primary') as HTMLButtonElement).click();
      (sr.querySelector('[data-role=review]') as HTMLButtonElement).click();
      (sr.querySelector('.pg-panel .pg-primary') as HTMLButtonElement).click();
    };
    const w1 = new PeanutGalleryWidget({ repo: 'owner/a', author: 'anna', onSubmit: () => { throw new Error('offline'); } }).mount();
    add(shadow(w1));
    await new Promise((r) => setTimeout(r, 0));
    expect(w1.getAnnotations()).toHaveLength(1);
    expect(shadow(w1).querySelector('.pg-toast')!.textContent).toContain('offline');
    w1.destroy();
    const w2 = new PeanutGalleryWidget({ repo: 'owner/b', author: 'anna', onSubmit: async () => ({ keep: true }) }).mount();
    add(shadow(w2));
    await new Promise((r) => setTimeout(r, 0));
    expect(w2.getAnnotations()).toHaveLength(1);
  });

  it('still works when localStorage and prompt are blocked (sandboxed frames)', () => {
    const proto = Object.getPrototypeOf(localStorage) as Storage;
    const get = vi.spyOn(proto, 'getItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    const set = vi.spyOn(proto, 'setItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    const pr = vi.spyOn(window, 'prompt').mockImplementation(() => { throw new Error('blocked'); });
    const w = new PeanutGalleryWidget({ repo: 'owner/repo', onSubmit: () => ({ keep: true }) }).mount();
    const sr = shadow(w);
    (sr.querySelector('[data-role=comment]') as HTMLButtonElement).click();
    const h1 = document.querySelector('h1')!;
    h1.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, composed: true }));
    h1.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    (sr.querySelector('textarea') as HTMLTextAreaElement).value = 'works anyway';
    (sr.querySelector('.pg-composer .pg-primary') as HTMLButtonElement).click();
    expect(w.getAnnotations()).toHaveLength(1);
    (sr.querySelector('[data-role=review]') as HTMLButtonElement).click();
    expect(() => (sr.querySelector('.pg-panel .pg-primary') as HTMLButtonElement).click()).not.toThrow();
    get.mockRestore(); set.mockRestore(); pr.mockRestore();
  });

  it('starts from a provided session, with pins on their elements', () => {
    const w = new PeanutGalleryWidget({
      repo: 'owner/repo',
      author: 'anna',
      session: {
        id: 'rs_demo', prototypeUrl: 'http://x', createdAt: '2026-11-07T00:00:00Z',
        annotations: [{ id: 'an_1', text: 'Make this primary', kind: 'visual', pageUrl: location.origin + location.pathname + location.search, anchor: { selector: 'button[data-testid="pay"]', textFingerprint: 'Pay now', tag: 'button', rect: { x: 0, y: 0, width: 10, height: 10 }, offset: { x: 0.5, y: 0.5 } }, createdAt: '2026-11-07T00:00:00Z' }],
      } as never,
    }).mount();
    expect(w.getAnnotations()[0].text).toBe('Make this primary');
    expect(shadow(w).querySelectorAll('.pg-pin')).toHaveLength(1);
    expect(shadow(w).querySelector('[data-role=count]')!.textContent).toBe('1');
  });

  it('redraws pins on client-side navigation (pushState / popstate)', async () => {
    const start = location.pathname;
    const note = (path: string, id: string) => ({ id, text: id, kind: 'visual', pageUrl: location.origin + path, anchor: { selector: 'button[data-testid="pay"]', textFingerprint: 'Pay now', tag: 'button', rect: { x: 0, y: 0, width: 10, height: 10 }, offset: { x: 0.5, y: 0.5 } }, createdAt: '2026-11-07T00:00:00Z' });
    history.replaceState(null, '', '/cart');
    const w = new PeanutGalleryWidget({
      repo: 'owner/repo', author: 'anna',
      session: { id: 'rs', prototypeUrl: 'http://x', createdAt: '2026-11-07T00:00:00Z', annotations: [note('/cart', 'cart-1'), note('/checkout', 'co-1'), note('/checkout', 'co-2')] } as never,
    }).mount();
    const pins = () => Array.from(shadow(w).querySelectorAll('.pg-pin')).map((p) => (p as HTMLElement).title);
    expect(pins()).toEqual(['cart-1']);
    history.pushState(null, '', '/checkout');
    await frame();
    expect(pins()).toEqual(['co-1', 'co-2']);
    history.back();
    await new Promise((r) => window.addEventListener('popstate', r, { once: true }));
    await frame();
    expect(pins()).toEqual(['cart-1']);
    w.destroy();
    history.replaceState(null, '', start);
  });

  it('hides pins whose element leaves the DOM (closed modal) and restores them when it returns', async () => {
    const w = new PeanutGalleryWidget({
      repo: 'owner/repo', author: 'anna',
      session: { id: 'rs', prototypeUrl: 'http://x', createdAt: '2026-11-07T00:00:00Z', annotations: [{ id: 'm1', text: 'Clearer title', kind: 'copy', pageUrl: location.origin + location.pathname + location.search, anchor: { selector: 'h2[data-testid="modal-title"]', textFingerprint: 'Remove item?', tag: 'h2', rect: { x: 0, y: 0, width: 10, height: 10 }, offset: { x: 0.5, y: 0.5 } }, createdAt: '2026-11-07T00:00:00Z' }] } as never,
    }).mount();
    const count = () => shadow(w).querySelectorAll('.pg-pin').length;
    expect(count()).toBe(0);
    const dialog = document.createElement('div');
    dialog.innerHTML = '<h2 data-testid="modal-title">Remove item?</h2>';
    document.body.append(dialog);
    await frame();
    expect(count()).toBe(1);
    dialog.remove();
    await frame();
    expect(count()).toBe(0);
    expect(shadow(w).querySelector('[data-role=count]')!.textContent).toBe('1');
    // Real browsers have elementFromPoint, so the resolver guesses "whatever is there now";
    // a pin must not follow that guess.
    const d = document as unknown as { elementFromPoint?: () => Element | null };
    const original = d.elementFromPoint;
    d.elementFromPoint = () => document.querySelector('main');
    document.body.append(document.createElement('span'));
    await frame();
    expect(count()).toBe(0);
    d.elementFromPoint = original;
    w.destroy();
  });

  it('leaves history working normally and stops listening after destroy', async () => {
    const w = new PeanutGalleryWidget({ repo: 'owner/repo', author: 'anna' }).mount();
    w.destroy();
    history.pushState({ a: 1 }, '', '/after-destroy');
    expect(location.pathname).toBe('/after-destroy');
    expect(history.state).toEqual({ a: 1 });
    await frame();
  });

  it('records typing, options and Enter; private fields keep no value', async () => {
    document.body.innerHTML = `<main>
      <input type="email" aria-label="Email" data-testid="email">
      <form><input placeholder="Promo code" data-testid="promo"><button data-testid="apply">Apply</button></form>
      <label>Size <select data-testid="size"><option>Small</option><option>Large</option></select></label>
      <p data-testid="result">Applied</p></main>`;
    const w = new PeanutGalleryWidget({ repo: 'owner/repo', author: 'anna' }).mount();
    const sr = shadow(w);
    const $ = <T extends Element>(id: string) => document.querySelector(`[data-testid=${id}]`) as unknown as T;
    const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, clientX: 5, clientY: 5 }));
    const type = (el: HTMLInputElement, text: string) => {
      for (const ch of text) {
        el.value += ch;
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      }
    };
    click($('email'));
    type($('email'), 'anna@secret.example');
    click($('promo'));
    type($('promo'), 'PLANTS10');
    $<HTMLInputElement>('promo').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
    // What browsers do next: "click" the form's submit button (detail 0). Not a step of its own.
    $('apply').dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, detail: 0 }));
    click($('size'));
    $<HTMLSelectElement>('size').value = 'Large';
    $('size').dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    (sr.querySelector('[data-role=comment]') as HTMLButtonElement).click();
    $('result').dispatchEvent(new MouseEvent('mousemove', { bubbles: true, composed: true, clientX: 5, clientY: 5 }));
    click($('result'));
    (sr.querySelector('textarea') as HTMLTextAreaElement).value = 'Show the new total';
    (sr.querySelector('.pg-composer .pg-primary') as HTMLButtonElement).click();
    const [n] = w.getAnnotations();
    expect(n.steps?.map((s) => [s.action ?? 'click', s.field, s.value, s.masked])).toEqual([
      ['type', 'Email', undefined, true],
      ['type', 'Promo code', 'PLANTS10', undefined],
      ['enter', 'Promo code', undefined, undefined],
      ['select', 'Size', 'Large', undefined],
    ]);
    expect(JSON.stringify(w.getAnnotations())).not.toContain('secret');
    w.destroy();
  });

  it('keeps clicks only when recordTyping is false', async () => {
    document.body.innerHTML = `<main><input placeholder="Search" data-testid="q"><p data-testid="r">Results</p></main>`;
    const w = new PeanutGalleryWidget({ repo: 'owner/repo', author: 'anna', recordTyping: false }).mount();
    const sr = shadow(w);
    const q = document.querySelector('[data-testid=q]') as HTMLInputElement;
    const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, clientX: 5, clientY: 5 }));
    click(q);
    q.value = 'lamp';
    q.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    (sr.querySelector('[data-role=comment]') as HTMLButtonElement).click();
    click(document.querySelector('[data-testid=r]')!);
    (sr.querySelector('textarea') as HTMLTextAreaElement).value = 'x';
    (sr.querySelector('.pg-composer .pg-primary') as HTMLButtonElement).click();
    expect(w.getAnnotations()[0].steps?.map((s) => s.action ?? 'click')).toEqual(['click']);
    expect(JSON.stringify(w.getAnnotations())).not.toContain('lamp');
    w.destroy();
  });

  it('records the clicks that led to a note (not the note click itself), reset on navigation', async () => {
    const start = location.pathname;
    document.body.innerHTML = `<main><h1>Cart</h1><button data-testid="remove">Remove</button><div id="slot"></div></main>`;
    document.querySelector('[data-testid=remove]')!.addEventListener('click', () => {
      document.getElementById('slot')!.innerHTML = '<div role="dialog"><h2 data-testid="dialog-title">Remove item?</h2></div>';
    });
    const w = new PeanutGalleryWidget({ repo: 'owner/repo', author: 'anna' }).mount();
    const sr = shadow(w);
    const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, clientX: 5, clientY: 5 }));
    const addNote = (el: Element, text: string) => {
      (sr.querySelector('[data-role=comment]') as HTMLButtonElement).click();
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, composed: true, clientX: 5, clientY: 5 }));
      click(el);
      (sr.querySelector('textarea') as HTMLTextAreaElement).value = text;
      (sr.querySelector('.pg-composer .pg-primary') as HTMLButtonElement).click();
    };
    click(document.querySelector('[data-testid=remove]')!);
    addNote(document.querySelector('[data-testid=dialog-title]')!, 'Name the plant');
    const [n1] = w.getAnnotations();
    expect(n1.steps?.map((s) => s.selector)).toEqual(['button[data-testid="remove"]']);
    expect(n1.steps?.[0].textFingerprint).toBe('Remove');

    history.pushState(null, '', '/elsewhere');
    addNote(document.querySelector('h1')!, 'Bigger heading');
    expect(w.getAnnotations()[1].steps).toBeUndefined();

    for (let i = 0; i < 12; i++) click(document.querySelector('h1')!);
    addNote(document.querySelector('h1')!, 'Again');
    expect(w.getAnnotations()[2].steps).toHaveLength(MAX_STEPS);
    w.destroy();
    history.replaceState(null, '', start);
  });

  it('respects activation=query', () => {
    const w = new PeanutGalleryWidget({ repo: 'owner/repo', activation: 'query' }).mount();
    expect(document.querySelector('peanut-gallery')).toBeNull();
    w.destroy();
  });
});

describe('normalizePageUrl', () => {
  it('drops the ?peanut switch and tracking params, keeps real query and hash routes', () => {
    expect(normalizePageUrl('http://x.io/?peanut')).toBe('http://x.io/');
    expect(normalizePageUrl('http://x.io/list?peanut&page=2&utm_campaign=a')).toBe('http://x.io/list?page=2');
    expect(normalizePageUrl('http://x.io/#/checkout')).toBe('http://x.io/#/checkout');
    expect(normalizePageUrl('http://x.io/about#team')).toBe('http://x.io/about');
  });
});

describe('theme', () => {
  it('applies the default palette and per-role overrides as CSS variables', () => {
    const w = new PeanutGalleryWidget({ repo: 'owner/repo', theme: { primary: '#ff0000' } }).mount();
    const style = document.querySelector('peanut-gallery')!.shadowRoot!.querySelector('style')!.textContent!;
    expect(style).toContain('--pg-primary: #ff0000;');
    expect(style).toContain('--pg-toolbar: #1E4D36;');
    expect(style).toContain('--pg-accent: #EAC26C;');
    expect(document.querySelector('link[href*="fonts.googleapis.com"]')).toBeNull();
    w.destroy();
  });

  it('uses the cool look by default, and the warm one as a preset', () => {
    const css = (theme?: never) => {
      const w = new PeanutGalleryWidget({ repo: 'owner/repo', ...(theme ? { theme } : {}) }).mount();
      const t = document.querySelector('peanut-gallery')!.shadowRoot!.querySelector('style')!.textContent!;
      w.destroy();
      return t;
    };
    expect(css()).toContain('--pg-bg: #E1EDF6;');
    expect(css('warm' as never)).toContain('--pg-bg: #F6F3E4;');
    const mixed = css({ preset: 'warm', primary: '#ff0000' } as never);
    expect(mixed).toContain('--pg-bg: #F6F3E4;');
    expect(mixed).toContain('--pg-primary: #ff0000;');
  });

    it('only loads fonts when asked', () => {
    const w = new PeanutGalleryWidget({ repo: 'owner/repo', loadFonts: true }).mount();
    expect(document.querySelectorAll('link[href*="fonts.googleapis.com"]')).toHaveLength(1);
    w.destroy();
  });
});

describe('other reviewers’ notes (relay shareNotes)', () => {
  const theirs = (over: Record<string, unknown> = {}) => ({
    id: 'an_sam',
    text: 'Make it green',
    kind: 'copy',
    author: 'Sam Rivera',
    anchor: { selector: 'button[data-testid="pay"]', tag: 'button', textFingerprint: 'Pay now', rect: { x: 0, y: 0, width: 1, height: 1 }, offset: { x: 0.5, y: 0.5 } },
    pageUrl: location.href,
    createdAt: 'now',
    issueNumber: 12,
    issueUrl: 'https://github.com/owner/repo/issues/12',
    ...over,
  });
  const relayWith = (notes: unknown[]) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === 'POST') return new Response(JSON.stringify({ issueUrl: 'https://github.com/owner/repo/issues/13', issueNumber: 13 }), { status: 201 });
      return new Response(JSON.stringify({ notes }), { status: 200 });
    });
    return calls;
  };

  it('pins them read-only, with initials, a link to the issue, and a list in the panel', async () => {
    const calls = relayWith([theirs(), theirs({ id: 'an_mine' }), theirs({ id: 'an_other_page', pageUrl: 'http://localhost:3000/elsewhere', author: 'kim' })]);
    const w = new PeanutGalleryWidget({
      repo: 'owner/repo',
      author: 'anna',
      relayUrl: 'https://relay.test/notes',
      relayKey: 'k',
      session: { id: 's', prototypeUrl: location.href, createdAt: 'now', annotations: [{ ...(theirs({ id: 'an_mine' }) as never), viewport: { width: 1, height: 1 } }] },
    }).mount();
    await frame();
    const sr = shadow(w);
    expect(calls[0].url).toBe(`https://relay.test/notes?origin=${encodeURIComponent(location.origin)}`);
    expect((calls[0].init?.headers as Record<string, string>)['x-peanut-gallery-key']).toBe('k');
    // Yours stays numbered; theirs shows initials. Your own note (same id) isn't shown twice.
    const other = sr.querySelectorAll('.pg-pin.pg-other');
    expect(other).toHaveLength(1);
    expect(other[0].textContent).toBe('SR');
    expect(sr.querySelectorAll('.pg-pin:not(.pg-other)')).toHaveLength(1);
    (other[0] as HTMLButtonElement).click();
    const pop = sr.querySelector('.pg-theirs')!;
    expect(pop.textContent).toContain('Sam Rivera · #12');
    expect(pop.textContent).toContain('Make it green');
    expect(pop.querySelector('textarea')).toBeNull();
    expect((pop.querySelector('a') as HTMLAnchorElement).href).toBe('https://github.com/owner/repo/issues/12');
    (sr.querySelector('[data-role=review]') as HTMLButtonElement).click();
    await frame();
    const panel = sr.querySelector('.pg-panel')!;
    expect(panel.querySelector('h4')!.textContent).toBe('From other reviewers (2)');
    expect(Array.from(panel.querySelectorAll('.pg-their .pg-meta')).map((m) => m.textContent)).toEqual(['Sam Rivera · this page · #12', 'kim · /elsewhere · #12']);
    // While picking an element to comment on, their pins let clicks through.
    (sr.querySelector('[data-role=comment]') as HTMLButtonElement).click();
    expect(sr.querySelector('.pg-pin.pg-other')!.parentElement!.classList.contains('pg-commenting')).toBe(true);
    (sr.querySelector('[data-role=comment]') as HTMLButtonElement).click();
    expect(sr.querySelector('.pg-pin.pg-other')!.parentElement!.classList.contains('pg-commenting')).toBe(false);
    // Hide their pins (remembered), and show them again.
    (panel.querySelector('.pg-others-head button') as HTMLButtonElement).click();
    expect(sr.querySelectorAll('.pg-pin.pg-other')).toHaveLength(0);
    expect(localStorage.getItem('peanut-gallery:hide-others')).toBe('1');
    (sr.querySelector('.pg-others-head button') as HTMLButtonElement).click();
    expect(sr.querySelectorAll('.pg-pin.pg-other')).toHaveLength(1);
    w.destroy();
    vi.unstubAllGlobals();
  });

  it('fans out pins on the same element so each can be opened; yours stay put', async () => {
    relayWith([theirs(), theirs({ id: 'b' }), theirs({ id: 'c' })]);
    const w = new PeanutGalleryWidget({ repo: 'owner/repo', relayUrl: 'https://relay.test/', session: { id: 's', prototypeUrl: location.href, createdAt: 'now', annotations: [{ ...(theirs({ id: 'mine' }) as never), viewport: { width: 1, height: 1 } }] } }).mount();
    await frame();
    const sr = shadow(w);
    const mine = sr.querySelector('.pg-pin:not(.pg-other)') as HTMLElement;
    const xs = Array.from(sr.querySelectorAll('.pg-pin.pg-other')).map((p) => parseFloat((p as HTMLElement).style.left));
    expect(new Set([parseFloat(mine.style.left), ...xs]).size).toBe(4);
    expect(Math.min(...xs)).toBeGreaterThan(parseFloat(mine.style.left));
    w.destroy();
    vi.unstubAllGlobals();
  });

  it('reads shared notes from a relay even when submitting through onSubmit', async () => {
    const calls = relayWith([theirs()]);
    const w = new PeanutGalleryWidget({ repo: 'owner/repo', relayUrl: 'https://relay.test/', onSubmit: () => ({}) }).mount();
    await frame();
    expect(calls).toHaveLength(1);
    expect(shadow(w).querySelectorAll('.pg-pin.pg-other')).toHaveLength(1);
    w.destroy();
    vi.unstubAllGlobals();
  });

  it('sends the relay key with a submission, then shows what was sent as shared', async () => {
    const calls = relayWith([]);
    const w = new PeanutGalleryWidget({ repo: 'owner/repo', author: 'anna', relayUrl: 'https://relay.test/', relayKey: 'k', session: { id: 's', prototypeUrl: location.href, createdAt: 'now', annotations: [{ ...(theirs({ id: 'an_x' }) as never), viewport: { width: 1, height: 1 } }] } }).mount();
    vi.spyOn(window, 'open').mockReturnValue(null);
    const sr = shadow(w);
    (sr.querySelector('[data-role=review]') as HTMLButtonElement).click();
    (sr.querySelector('.pg-panel .pg-primary') as HTMLButtonElement).click();
    await frame();
    const post = calls.find((c) => c.init?.method === 'POST')!;
    expect((post.init!.headers as Record<string, string>)['x-peanut-gallery-key']).toBe('k');
    // Fetched on mount, on opening the panel, and again after submitting.
    expect(calls.filter((c) => c.init?.method !== 'POST').length).toBeGreaterThanOrEqual(3);
    w.destroy();
    vi.unstubAllGlobals();
  });

  it("doesn't ask outside relay mode, or with showOthers: false, and skips odd links", async () => {
    let calls = relayWith([]);
    new PeanutGalleryWidget({ repo: 'owner/repo' }).mount().destroy();
    new PeanutGalleryWidget({ repo: 'owner/repo', relayUrl: 'https://relay.test/', showOthers: false }).mount().destroy();
    new PeanutGalleryWidget({ repo: 'owner/repo', relayUrl: 'https://relay.test/', mode: 'issue-url' }).mount().destroy();
    await frame();
    expect(calls).toHaveLength(0);
    calls = relayWith([theirs({ issueUrl: 'javascript:alert(1)' })]);
    const w = new PeanutGalleryWidget({ repo: 'owner/repo', relayUrl: 'https://relay.test/' }).mount();
    await frame();
    (shadow(w).querySelector('.pg-pin.pg-other') as HTMLButtonElement).click();
    expect(shadow(w).querySelector('.pg-theirs a')).toBeNull();
    w.destroy();
    vi.unstubAllGlobals();
  });
});

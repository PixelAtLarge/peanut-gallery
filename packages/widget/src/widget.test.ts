// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PeanutGalleryWidget } from './widget.js';

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = `<main><h1>Checkout</h1><button data-testid="pay">Pay now</button></main>`;
  document.querySelectorAll('peanut-gallery').forEach((n) => n.remove());
});

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

  it('respects activation=query', () => {
    const w = new PeanutGalleryWidget({ repo: 'owner/repo', activation: 'query' }).mount();
    expect(document.querySelector('peanut-gallery')).toBeNull();
    w.destroy();
  });
});

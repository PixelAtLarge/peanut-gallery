/**
 * Form fields: which ones a reviewer types into, which ones are private, and what to call them.
 * Shared by the widget (recording steps) and the screenshot browser (replaying them).
 */

const TYPING_INPUTS = new Set(['', 'text', 'search', 'email', 'tel', 'url', 'number', 'password', 'date', 'time', 'datetime-local', 'month', 'week']);

/**
 * Markup that session-replay tools already use to keep fields out of recordings
 * (LogRocket, FullStory, Hotjar, Sentry), plus our own `data-peanut-private`.
 */
export const PRIVATE_MARKUP = '[data-peanut-private], [data-private], .fs-exclude, .fs-mask, [data-hj-suppress], .sentry-mask, [data-sentry-mask]';

const PRIVATE_AUTOCOMPLETE =
  /(^|\s)(cc-[\w-]+|current-password|new-password|one-time-code|email|tel(-[\w-]+)?|username|name|given-name|family-name|additional-name|honorific-(prefix|suffix)|nickname|street-address|address-line[123]|address-level[1-4]|postal-code|bday(-\w+)?|sex|transaction-[\w-]+|impp|photo)(\s|$)/i;

const PRIVATE_HINT =
  /pass(word|code|phrase)?|pwd|secret|token|api.?key|card|cc.?(num|no)|cvv|cvc|csc|security.?code|expir|ssn|social.?security|tax.?id|\btin\b|iban|swift|routing|account.?(no|num)|\bpin\b|otp|one.?time|e-?mail|phone|mobile|\btel\b|birth|\bdob\b|address|street|\bzip\b|postal|post.?code|first.?name|last.?name|full.?name|given.?name|family.?name|surname|your.?name|licen[cs]e|passport/i;

/** Fields we never try to type a stand-in into: a made-up value would be wrong or risky. */
const NO_STAND_IN = /pass(word|code|phrase)?|pwd|secret|token|api.?key|card|cc.?(num|no)|cvv|cvc|csc|security.?code|expir|ssn|social.?security|tax.?id|\btin\b|iban|swift|routing|account|\bpin\b|otp|one.?time|licen[cs]e|passport/i;

/** A text-like field a reviewer types into (not checkboxes, files, sliders…). */
export function isTypingField(el: unknown): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el || typeof el !== 'object' || !('tagName' in el)) return false;
  const e = el as HTMLInputElement;
  if (e.disabled || e.readOnly) return false;
  if (e.tagName === 'TEXTAREA') return true;
  return e.tagName === 'INPUT' && TYPING_INPUTS.has((e.getAttribute('type') ?? '').toLowerCase());
}

const clean = (s: string | null | undefined, n = 40) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** The field's name as a person would say it: aria-label, its <label>, placeholder, then name. */
export function fieldName(el: Element): string {
  const aria = clean(el.getAttribute('aria-label'));
  if (aria) return aria;
  const ids = el.getAttribute('aria-labelledby');
  if (ids) {
    const t = clean(ids.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '').join(' '));
    if (t) return t;
  }
  const label = (el as HTMLInputElement).labels?.[0];
  if (label) {
    // A wrapping <label> also contains the field (and a select's options): leave those out.
    const copy = label.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('input, select, textarea, option').forEach((n) => n.remove());
    const t = clean(copy.textContent);
    if (t) return t;
  }
  return clean(el.getAttribute('placeholder')) || clean(el.getAttribute('name')) || clean(el.getAttribute('title'));
}

function hints(el: Element): string {
  return ['name', 'id', 'aria-label', 'placeholder', 'data-testid', 'autocomplete'].map((a) => el.getAttribute(a) ?? '').join(' ') + ' ' + fieldName(el);
}

/**
 * Should what's typed here stay out of the issue? Passwords, card and bank details, codes,
 * personal details (email, phone, name, address, birthday), anything marked private.
 */
export function isPrivateField(el: Element): boolean {
  if (el.closest(PRIVATE_MARKUP)) return true;
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  if (type === 'password' || type === 'email' || type === 'tel') return true;
  if (PRIVATE_AUTOCOMPLETE.test(el.getAttribute('autocomplete') ?? '')) return true;
  return PRIVATE_HINT.test(hints(el));
}

/**
 * A harmless value to type into a private field when replaying, so a form can move on without
 * the reviewer's real details. Null when no made-up value is safe (passwords, cards, codes…).
 */
export function standInValue(el: Element): string | null {
  if (el.closest(PRIVATE_MARKUP)) return null;
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  const ac = (el.getAttribute('autocomplete') ?? '').toLowerCase();
  const h = hints(el);
  if (type === 'password' || /cc-|password|one-time-code|transaction-/.test(ac) || NO_STAND_IN.test(h)) return null;
  if (type === 'email' || /email/.test(ac) || /e-?mail/i.test(h)) return 'reviewer@example.com';
  if (type === 'tel' || /tel/.test(ac) || /phone|mobile|\btel\b/i.test(h)) return '5555550100';
  if (/^(number|date|time|datetime-local|month|week)$/.test(type) || /bday/.test(ac) || /birth|\bdob\b/i.test(h)) return null;
  if (/street|address/.test(ac) && !/postal-code/.test(ac) || /address|street/i.test(h)) return '1 Example Street';
  if (/postal-code/.test(ac) || /\bzip\b|postal|post.?code/i.test(h)) return '12345';
  if (/name/.test(ac) || /name|surname/i.test(h)) return 'Alex Example';
  return 'example';
}

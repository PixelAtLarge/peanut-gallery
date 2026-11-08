import {
  createAnchor,
  resolveAnchor,
  newIssueUrl,
  uid,
  LABELS,
  type Annotation,
  type AnnotationKind,
  type ReviewSession,
  resolveTheme,
  themeToCssVars,
  DEFAULT_FONTS_URL,
  type Theme,
} from '@pixelatlarge/peanut-gallery-core';
import { css } from './styles.js';

type SubmitResult = void | { issueUrl?: string; keep?: boolean };

const LOCATION_EVENT = 'peanut-gallery:locationchange';

/**
 * The page a note belongs to. Drops the `?peanut` switch and tracking parameters (they
 * disappear as soon as the reviewer navigates inside the app), and keeps hash routes
 * (`#/checkout`) because in hash-routed apps the hash is the page.
 */
export function normalizePageUrl(href: string): string {
  try {
    const u = new URL(href);
    for (const key of [...u.searchParams.keys()]) {
      if (key === 'peanut' || key.startsWith('utm_') || key === 'fbclid' || key === 'gclid') u.searchParams.delete(key);
    }
    const search = u.searchParams.toString();
    const hash = /^#!?\//.test(u.hash) ? u.hash : '';
    return u.origin + u.pathname + (search ? `?${search}` : '') + hash;
  } catch {
    return href;
  }
}

/**
 * Fire LOCATION_EVENT whenever the app calls history.pushState/replaceState (client-side
 * routers: React Router, Next, Vue Router...). Wraps once per page and leaves the original
 * behaviour untouched.
 */
function watchHistory() {
  if (typeof history === 'undefined') return;
  const h = history as History & { __peanutGallery?: true };
  if (h.__peanutGallery) return;
  h.__peanutGallery = true;
  for (const name of ['pushState', 'replaceState'] as const) {
    const original = h[name];
    h[name] = function (this: History, ...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args);
      try {
        window.dispatchEvent(new Event(LOCATION_EVENT));
      } catch {
        /* never break the app's navigation */
      }
      return result;
    } as History['pushState'];
  }
}

export interface PeanutGalleryConfig {
  /** GitHub repo as "owner/name". Required. */
  repo: string;
  /**
   * How to submit:
   * - "issue-url": open a prefilled github.com/.../issues/new tab (zero infra, reviewer needs GitHub access)
   * - "relay": POST the session to `relayUrl`, which creates the issue server-side
   * - "auto" (default): relay if `relayUrl` is set, otherwise issue-url
   */
  mode?: 'issue-url' | 'relay' | 'auto';
  relayUrl?: string;
  /** Labels to apply. Defaults to ["peanut-gallery", "peanut-gallery:feedback"]. */
  labels?: string[];
  /** Reviewer name; if omitted the widget asks once and remembers it. */
  author?: string;
  /** Base URL of the prototype, defaults to location.origin. */
  prototypeUrl?: string;
  /**
   * When to show the widget:
   * - "always" (default)
   * - "query": only when the URL has ?peanut (sticky for the session)
   */
  activation?: 'always' | 'query';
  /** Which annotation kinds to offer. */
  kinds?: AnnotationKind[];
  /** Override any colour or font role. Defaults to the Conifer / Prep / Wasabi palette. */
  theme?: Partial<Theme>;
  /**
   * Load the default fonts (Manrope, Young Serif, JetBrains Mono) from Google Fonts into the page.
   * Off by default so the widget never adds third-party requests to a prototype unasked;
   * without it the widget uses those fonts if the page already has them, else the system UI font.
   */
  loadFonts?: boolean;
  /**
   * Handle submission yourself instead of GitHub (e.g. send to your own backend, or a demo).
   * Overrides `mode`. Resolve to clear the notes; return `{ issueUrl }` to link to the result,
   * or `{ keep: true }` to leave the notes on the page. Throw to show an error and keep them.
   */
  onSubmit?: (session: ReviewSession) => SubmitResult | Promise<SubmitResult>;
  /** Start from these notes instead of the ones saved in this browser (e.g. a demo or a test). */
  session?: ReviewSession;
}

/** localStorage that never throws: sandboxed frames and strict privacy modes can block it. */
const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* notes still work for this page view; they just won't survive a reload */
    }
  },
};

const DEFAULT_KINDS: AnnotationKind[] = ['bug', 'copy', 'layout', 'visual', 'flow', 'question', 'praise'];

type Mode = 'idle' | 'commenting';

export class PeanutGalleryWidget {
  private cfg: Required<Pick<PeanutGalleryConfig, 'repo' | 'mode' | 'labels' | 'activation' | 'kinds' | 'prototypeUrl'>> &
    PeanutGalleryConfig;
  private host!: HTMLElement;
  private root!: ShadowRoot;
  private session!: ReviewSession;
  private mode: Mode = 'idle';
  private hoverEl: Element | null = null;
  private highlight!: HTMLElement;
  private pinsLayer!: HTMLElement;
  private panel: HTMLElement | null = null;
  private composer: HTMLElement | null = null;
  private toolbar!: HTMLElement;
  private raf = 0;
  private destroyed = false;
  private observer?: MutationObserver;

  constructor(cfg: PeanutGalleryConfig) {
    if (!cfg.repo || !/^[\w.-]+\/[\w.-]+$/.test(cfg.repo)) throw new Error('PeanutGallery: config.repo must be "owner/name"');
    this.cfg = {
      mode: 'auto',
      labels: [LABELS.root, LABELS.feedback],
      activation: 'always',
      kinds: DEFAULT_KINDS,
      prototypeUrl: typeof location !== 'undefined' ? location.origin : '',
      ...cfg,
    };
  }

  get storageKey() {
    return `peanut-gallery:${this.cfg.repo}`;
  }

  /** Mount the widget. Safe to call once DOM is ready. */
  mount(): this {
    if (this.cfg.activation === 'query') {
      const want = new URLSearchParams(location.search).has('peanut');
      const sticky = sessionStorage.getItem('peanut-gallery:active') === '1';
      if (!want && !sticky) return this;
      sessionStorage.setItem('peanut-gallery:active', '1');
    }
    this.session = this.loadSession();
    this.host = document.createElement('peanut-gallery');
    this.host.setAttribute('data-peanut-gallery', '');
    this.root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `:host { ${themeToCssVars(resolveTheme(this.cfg.theme))} }\n${css}`;
    if (this.cfg.loadFonts && !document.querySelector(`link[href="${DEFAULT_FONTS_URL}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = DEFAULT_FONTS_URL;
      document.head.append(link);
    }
    this.root.append(style);

    this.highlight = el('div', 'pg-highlight pg-hidden');
    this.highlight.append(el('span', 'pg-tag'));
    this.pinsLayer = el('div');
    this.toolbar = this.buildToolbar();
    this.root.append(this.highlight, this.pinsLayer, this.toolbar);
    document.body.append(this.host);

    document.addEventListener('mousemove', this.onMouseMove, true);
    document.addEventListener('click', this.onClick, true);
    document.addEventListener('keydown', this.onKey, true);
    window.addEventListener('scroll', this.schedulePins, true);
    window.addEventListener('resize', this.schedulePins);
    // Single-page apps change the URL without a reload and re-render without scrolling,
    // so also redraw on history changes and on DOM changes outside our own shadow root.
    watchHistory();
    window.addEventListener(LOCATION_EVENT, this.onLocationChange);
    window.addEventListener('popstate', this.onLocationChange);
    window.addEventListener('hashchange', this.onLocationChange);
    if (typeof MutationObserver !== 'undefined') {
      this.observer = new MutationObserver((records) => {
        if (records.some((r) => r.target !== this.host)) this.schedulePins();
      });
      this.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-hidden'], characterData: true });
    }
    this.renderPins();
    this.updateCount();
    return this;
  }

  private onLocationChange = () => {
    if (this.destroyed) return;
    this.closeComposer();
    this.schedulePins();
    if (this.panel) this.renderPanel();
  };

  destroy() {
    this.destroyed = true;
    document.removeEventListener('mousemove', this.onMouseMove, true);
    document.removeEventListener('click', this.onClick, true);
    document.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('scroll', this.schedulePins, true);
    window.removeEventListener('resize', this.schedulePins);
    window.removeEventListener(LOCATION_EVENT, this.onLocationChange);
    window.removeEventListener('popstate', this.onLocationChange);
    window.removeEventListener('hashchange', this.onLocationChange);
    this.observer?.disconnect();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.host?.remove();
  }

  /** Current annotations (all pages). */
  getAnnotations(): Annotation[] {
    return [...this.session.annotations];
  }

  // ---------- state ----------

  private loadSession(): ReviewSession {
    if (this.cfg.session && Array.isArray(this.cfg.session.annotations)) return structuredClone(this.cfg.session);
    try {
      const raw = store.get(this.storageKey);
      if (raw) {
        const s = JSON.parse(raw) as ReviewSession;
        if (Array.isArray(s.annotations)) return s;
      }
    } catch {
      /* ignore */
    }
    return this.freshSession();
  }

  private freshSession(): ReviewSession {
    return {
      id: uid('rs'),
      prototypeUrl: this.cfg.prototypeUrl,
      annotations: [],
      createdAt: new Date().toISOString(),
      author: this.cfg.author ?? store.get('peanut-gallery:author') ?? undefined,
      userAgent: navigator.userAgent,
    };
  }

  private save() {
    store.set(this.storageKey, JSON.stringify(this.session));
    this.updateCount();
    this.renderPins();
    if (this.panel) this.renderPanel();
  }

  private pageUrl() {
    return normalizePageUrl(location.href);
  }

  // ---------- toolbar ----------

  private buildToolbar(): HTMLElement {
    const bar = el('div', 'pg-toolbar');
    const brand = el('span', 'pg-brand', 'Notes');
    const comment = el('button', 'pg-btn', 'Comment') as HTMLButtonElement;
    comment.dataset.role = 'comment';
    comment.onclick = () => this.setMode(this.mode === 'commenting' ? 'idle' : 'commenting');
    const review = el('button', 'pg-btn', 'Review') as HTMLButtonElement;
    review.dataset.role = 'review';
    review.onclick = () => this.togglePanel();
    const count = el('span', 'pg-count', '0');
    count.dataset.role = 'count';
    review.append(count);
    bar.append(brand, comment, review);
    return bar;
  }

  private updateCount() {
    const c = this.toolbar.querySelector('[data-role=count]')!;
    c.textContent = String(this.session.annotations.length);
  }

  private setMode(m: Mode) {
    this.mode = m;
    const btn = this.toolbar.querySelector('[data-role=comment]')!;
    btn.classList.toggle('pg-active', m === 'commenting');
    btn.textContent = m === 'commenting' ? 'Click an element… (Esc)' : 'Comment';
    document.body.style.cursor = m === 'commenting' ? 'crosshair' : '';
    if (m === 'idle') this.hideHighlight();
  }

  // ---------- events ----------

  private isOwn(target: EventTarget | null): boolean {
    return target instanceof Node && (this.host === target || this.host.contains(target));
  }

  private onMouseMove = (e: MouseEvent) => {
    if (this.mode !== 'commenting') return;
    const path = e.composedPath();
    if (path.includes(this.host)) return this.hideHighlight();
    const target = path[0];
    if (!(target instanceof Element) || target === document.documentElement || target === document.body) return this.hideHighlight();
    this.hoverEl = target;
    const r = target.getBoundingClientRect();
    Object.assign(this.highlight.style, {
      left: `${r.left + scrollX}px`,
      top: `${r.top + scrollY}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    this.highlight.querySelector('.pg-tag')!.textContent = describe(target);
    this.highlight.classList.remove('pg-hidden');
  };

  private hideHighlight() {
    this.hoverEl = null;
    this.highlight.classList.add('pg-hidden');
  }

  private onClick = (e: MouseEvent) => {
    if (this.mode !== 'commenting') return;
    if (e.composedPath().includes(this.host)) return;
    const target = this.hoverEl ?? (e.target as Element);
    if (!(target instanceof Element)) return;
    e.preventDefault();
    e.stopPropagation();
    this.setMode('idle');
    this.openComposer(target, e.clientX, e.clientY);
  };

  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (this.composer) this.closeComposer();
      else if (this.mode === 'commenting') this.setMode('idle');
    }
  };

  // ---------- composer ----------

  private openComposer(target: Element, clientX: number, clientY: number, existing?: Annotation) {
    this.closeComposer();
    const anchor = existing?.anchor ?? createAnchor(target, clientX, clientY);
    const box = el('div', 'pg-composer');
    const meta = el('div', 'pg-meta', `${anchor.tag} · ${anchor.selector}`);
    meta.title = anchor.selector;
    const ta = document.createElement('textarea');
    ta.placeholder = 'What should change here? Be specific — this becomes a task.';
    ta.value = existing?.text ?? '';
    const kind = document.createElement('select');
    kind.append(new Option('type…', ''));
    for (const k of this.cfg.kinds) kind.append(new Option(k, k, false, existing?.kind === k));
    const row = el('div', 'pg-row');
    const save = el('button', 'pg-btn pg-primary', existing ? 'Update' : 'Add note') as HTMLButtonElement;
    const cancel = el('button', 'pg-btn pg-ghost', 'Cancel') as HTMLButtonElement;
    cancel.onclick = () => this.closeComposer();
    save.onclick = () => {
      const text = ta.value.trim();
      if (!text) return ta.focus();
      if (existing) {
        existing.text = text;
        existing.kind = (kind.value || undefined) as AnnotationKind | undefined;
      } else {
        this.session.annotations.push({
          id: uid('an'),
          text,
          kind: (kind.value || undefined) as AnnotationKind | undefined,
          anchor,
          pageUrl: this.pageUrl(),
          viewport: { width: innerWidth, height: innerHeight },
          createdAt: new Date().toISOString(),
          author: this.session.author,
        });
      }
      this.save();
      this.closeComposer();
    };
    row.append(kind, el('span', 'pg-spacer'));
    if (existing) {
      const del = el('button', 'pg-btn pg-danger', 'Delete') as HTMLButtonElement;
      del.onclick = () => {
        this.session.annotations = this.session.annotations.filter((a) => a.id !== existing.id);
        this.save();
        this.closeComposer();
      };
      row.append(del);
    }
    row.append(cancel, save);
    box.append(meta, ta, row);
    // Position near click, clamped to viewport.
    const x = Math.min(clientX + 12, innerWidth - 312) + scrollX;
    const y = Math.min(clientY + 12, innerHeight - 190) + scrollY;
    box.style.left = `${Math.max(8, x)}px`;
    box.style.top = `${Math.max(8, y)}px`;
    this.root.append(box);
    this.composer = box;
    ta.focus();
  }

  private closeComposer() {
    this.composer?.remove();
    this.composer = null;
  }

  // ---------- pins ----------

  private schedulePins = () => {
    if (this.raf || this.destroyed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.renderPins();
    });
  };

  private pinsSignature = '';

  private renderPins() {
    const here = this.pageUrl();
    const placed: { a: Annotation; n: number; x: number; y: number; low: boolean }[] = [];
    this.session.annotations.forEach((a, i) => {
      if (normalizePageUrl(a.pageUrl) !== here) return;
      const { el: target, confidence } = resolveAnchor(a.anchor, document);
      // Element not on screen right now (a closed modal, a collapsed panel, another tab of the
      // UI): leave the pin out rather than floating it over unrelated content. The note is
      // still listed in the panel. Below 0.4 the resolver is only guessing from the old
      // position (whatever now sits where the element was), so treat that as not found too.
      if (!target || confidence < 0.4) return;
      const vis = (target as Element & { checkVisibility?: () => boolean }).checkVisibility;
      if (typeof vis === 'function' && !vis.call(target)) return;
      const r = target.getBoundingClientRect();
      const x = Math.round(r.left + scrollX + r.width * a.anchor.offset.x);
      const y = Math.round(r.top + scrollY + r.height * a.anchor.offset.y);
      placed.push({ a, n: i + 1, x, y, low: confidence < 0.5 });
    });
    // Busy apps mutate the DOM constantly; only rebuild when a pin actually changed, so
    // hover and clicks on pins aren't interrupted.
    const sig = placed.map((p) => `${p.a.id}:${p.n}:${p.x}:${p.y}:${p.low}:${p.a.text}`).join('|');
    if (sig === this.pinsSignature && this.pinsLayer.childElementCount === placed.length) return;
    this.pinsSignature = sig;
    this.pinsLayer.replaceChildren(
      ...placed.map(({ a, n, x, y, low }) => {
        const pin = el('div', 'pg-pin' + (low ? ' pg-low' : ''), String(n));
        pin.title = a.text;
        pin.style.left = `${x}px`;
        pin.style.top = `${y}px`;
        pin.onclick = (ev) => {
          ev.stopPropagation();
          const target = resolveAnchor(a.anchor, document).el ?? document.body;
          this.openComposer(target, x - scrollX, y - scrollY, a);
        };
        return pin;
      }),
    );
  }

  // ---------- panel ----------

  private togglePanel() {
    if (this.panel) {
      this.panel.remove();
      this.panel = null;
      return;
    }
    this.panel = el('div', 'pg-panel');
    this.root.append(this.panel);
    this.renderPanel();
  }

  private renderPanel() {
    const p = this.panel!;
    p.replaceChildren();
    const h = el('h3', '', `Feedback (${this.session.annotations.length})`);
    p.append(h);
    if (!this.session.annotations.length) {
      p.append(el('div', 'pg-empty', 'No notes yet. Click “Comment”, then click anything on the page.'));
    }
    const here = this.pageUrl();
    this.session.annotations.forEach((a, i) => {
      const item = el('div', 'pg-item');
      const text = el('div', 'pg-text');
      if (a.kind) text.append(el('span', 'pg-kind', a.kind));
      text.append(`${i + 1}. ${a.text}`);
      const meta = el('div', 'pg-meta', `${normalizePageUrl(a.pageUrl) === here ? 'this page' : pathOf(a.pageUrl)} · ${a.anchor.tag}${a.anchor.textFingerprint ? ` “${a.anchor.textFingerprint.slice(0, 30)}”` : ''}`);
      item.append(text, meta);
      p.append(item);
    });
    const row = el('div', 'pg-row');
    const clear = el('button', 'pg-btn pg-ghost', 'Clear') as HTMLButtonElement;
    clear.onclick = () => {
      if (!this.session.annotations.length || confirm('Discard all notes?')) {
        this.session = this.freshSession();
        this.save();
      }
    };
    const submit = el('button', 'pg-btn pg-primary', this.effectiveMode() === 'issue-url' ? 'Submit to GitHub' : 'Submit') as HTMLButtonElement;
    submit.disabled = !this.session.annotations.length;
    submit.onclick = () => this.submit(submit);
    row.append(clear, el('span', 'pg-spacer'), submit);
    p.append(row);
  }

  private effectiveMode(): 'issue-url' | 'relay' | 'callback' {
    if (this.cfg.onSubmit) return 'callback';
    if (this.cfg.mode === 'relay') return 'relay';
    if (this.cfg.mode === 'issue-url') return 'issue-url';
    return this.cfg.relayUrl ? 'relay' : 'issue-url';
  }

  private ensureAuthor() {
    if (this.session.author) return;
    let name: string | undefined;
    try {
      name = prompt('Your name (shown on the feedback):')?.trim();
    } catch {
      /* prompt is blocked in some sandboxed frames; the notes go in unsigned */
    }
    if (name) {
      this.session.author = name;
      store.set('peanut-gallery:author', name);
      this.session.annotations.forEach((a) => (a.author ??= name));
    }
  }

  private async submit(btn: HTMLButtonElement) {
    this.ensureAuthor();
    const session: ReviewSession = { ...this.session, createdAt: new Date().toISOString() };
    if (this.effectiveMode() === 'callback') {
      btn.disabled = true;
      btn.textContent = 'Submitting…';
      try {
        const out = (await this.cfg.onSubmit!(session)) || {};
        if (!out.keep) this.resetAfterSubmit();
        this.toast(out.issueUrl ? `Submitted: ${out.issueUrl}` : 'Submitted. Thank you!');
      } catch (err) {
        this.toast(`Could not submit: ${(err as Error).message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Submit';
      }
      return;
    }
    if (this.effectiveMode() === 'issue-url') {
      const url = newIssueUrl(this.cfg.repo, session, this.cfg.labels);
      const w = window.open(url, '_blank', 'noopener');
      if (!w) {
        this.toast('Popup blocked — allow popups and try again.');
        return;
      }
      this.toast('Opened GitHub. Press “Submit new issue” there; notes stay here until you Clear.');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Submitting…';
    try {
      const res = await fetch(this.cfg.relayUrl!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session, labels: this.cfg.labels }),
      });
      if (!res.ok) throw new Error(`Relay responded ${res.status}`);
      const data = (await res.json()) as { issueUrl?: string };
      this.resetAfterSubmit();
      this.toast(data.issueUrl ? `Submitted: ${data.issueUrl}` : 'Submitted. Thank you!');
      if (data.issueUrl) window.open(data.issueUrl, '_blank', 'noopener');
    } catch (err) {
      this.toast(`Could not submit: ${(err as Error).message}`);
      btn.disabled = false;
      btn.textContent = 'Submit';
    }
  }

  /** Clear the submitted notes and redraw: pins, count and the panel. */
  private resetAfterSubmit() {
    this.session = this.freshSession();
    this.save();
    if (this.panel) {
      this.panel.remove();
      this.panel = null;
    }
    this.renderPins();
    this.updateCount();
  }

  private toast(msg: string) {
    const t = el('div', 'pg-toast', msg);
    this.root.append(t);
    setTimeout(() => t.remove(), 5000);
  }
}

function el(tag: string, className = '', text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function describe(target: Element): string {
  const id = target.getAttribute('data-testid') ?? target.id;
  return target.tagName.toLowerCase() + (id ? `#${id}` : '');
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

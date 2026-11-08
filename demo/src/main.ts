// Demo page: live GitHub-issue preview from the widget's notes, before/after slider, votes, copy buttons.
import { sessionToIssue, type ReviewSession } from '@pixelatlarge/peanut-gallery-core';
import example from './example-session.json';

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T;

// ── issue preview ───────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/** Just enough Markdown for the issue body sessionToIssue writes. */
export function renderIssueMarkdown(md: string): string {
  const out: string[] = [];
  const lines = md.split('\n');
  let list = false;
  const endList = () => {
    if (list) out.push('</ul>');
    list = false;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      endList();
      const body: string[] = [];
      while (++i < lines.length && !lines[i].startsWith('```')) body.push(lines[i]);
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
    } else if (/^<details>/.test(line)) {
      endList();
      const summary = /<summary>(.*?)<\/summary>/.exec(line)?.[1] ?? 'Details';
      out.push(`<details><summary>${esc(summary)}</summary>`);
    } else if (/^<\/details>/.test(line)) {
      endList();
      out.push('</details>');
    } else if (/^#{1,6} /.test(line)) {
      endList();
      out.push(`<h4>${inline(line.replace(/^#{1,6} /, ''))}</h4>`);
    } else if (/^\s*- /.test(line)) {
      if (!list) out.push('<ul>');
      list = true;
      out.push(`<li>${inline(line.replace(/^\s*- /, ''))}</li>`);
    } else if (line.trim()) {
      endList();
      out.push(`<p>${inline(line)}</p>`);
    } else endList();
  }
  endList();
  return out.join('\n');
}

let current = example as unknown as ReviewSession;

function renderIssue(session: ReviewSession) {
  current = session;
  const { title, body } = sessionToIssue({ ...session, author: session.author ?? 'You' });
  $('#issue-title').textContent = session.annotations.length ? title : 'Prototype feedback: no notes yet';
  $('#issue-body').innerHTML = session.annotations.length
    ? renderIssueMarkdown(body)
    : '<p>Add a note on the checkout above and it appears here.</p>';
}

/** Notes other than the two example ones means the visitor wrote their own. */
function hasOwnNotes(session: ReviewSession): boolean {
  const ids = new Set((example as unknown as ReviewSession).annotations.map((a) => a.id));
  return session.annotations.some((a) => !ids.has(a.id));
}

window.addEventListener('message', (ev) => {
  const proto = $<HTMLIFrameElement>('#proto');
  if (ev.source !== proto.contentWindow) return;
  const msg = ev.data as { type?: string; session?: ReviewSession };
  if (!msg?.session) return;
  if (msg.type === 'peanut-demo:notes') renderIssue(msg.session);
  if (msg.type === 'peanut-demo:submit') {
    renderIssue(msg.session);
    $('#issue-caption').textContent = 'Submitted. This is the issue the widget would file in your repo. Next, Claude reads it.';
    $('#own-notes').hidden = !hasOwnNotes(msg.session);
    $('#issue').scrollIntoView({ block: 'start' });
  }
});

renderIssue(current);

// ── before / after slider ───────────────────────────────────────────────────

const slider = $('#slider');
const range = $<HTMLInputElement>('#cut');
const setCut = (pct: number) => {
  const v = Math.max(0, Math.min(100, pct));
  slider.style.setProperty('--cut', `${v}%`);
  range.value = String(Math.round(v));
};
range.addEventListener('input', () => setCut(Number(range.value)));
let dragging = false;
const fromPointer = (e: PointerEvent) => {
  const r = slider.getBoundingClientRect();
  setCut(((e.clientX - r.left) / r.width) * 100);
};
slider.addEventListener('pointerdown', (e) => {
  dragging = true;
  slider.setPointerCapture(e.pointerId);
  fromPointer(e);
});
slider.addEventListener('pointermove', (e) => dragging && fromPointer(e));
slider.addEventListener('pointerup', () => (dragging = false));
slider.addEventListener('pointercancel', () => (dragging = false));

const views = {
  el: { before: 'assets/pr35-before-el1.png', after: 'assets/pr35-after-el1.png', w: 1120, h: 480, alt: ['Before: a plain outlined Pay now button next to Back', 'After: a filled blue button reading Pay $150.50'] },
  page: { before: 'assets/pr35-before-page1.png', after: 'assets/pr35-after-page1.png', w: 2560, h: 1600, alt: ['Before: the whole checkout page', 'After: the whole checkout page with the filled Pay $150.50 button'] },
} as const;
document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    const v = views[b.dataset.view as keyof typeof views];
    const before = $<HTMLImageElement>('#img-before');
    const after = $<HTMLImageElement>('#img-after');
    before.src = v.before;
    after.src = v.after;
    for (const img of [before, after]) {
      img.width = v.w;
      img.height = v.h;
    }
    before.alt = v.alt[0];
    after.alt = v.alt[1];
    document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }),
);

// ── votes ───────────────────────────────────────────────────────────────────

const outcomes: Record<string, { text: string; outcome: string }> = {
  after: { text: 'After, definitely. Ship it.', outcome: '`npx peanut-gallery votes` counts this for After: the issue is labelled peanut-gallery:accepted and the PR gets a "Ready to merge" comment.' },
  before: { text: 'Honestly I prefer the before.', outcome: '`npx peanut-gallery votes` counts this for Before: the issue is labelled peanut-gallery:rejected and the PR gets a comment suggesting you close or revise it.' },
  neither: { text: "Neither, it still doesn't feel like the main action.", outcome: 'No preference, so the PR stays open. This is when you ask for options (step 5), or run another round of review.' },
};
document.querySelectorAll<HTMLButtonElement>('.vote button').forEach((b) =>
  b.addEventListener('click', () => {
    const o = outcomes[b.dataset.vote!];
    $('#reply-text').textContent = o.text;
    $('#reply-outcome').innerHTML = inline(o.outcome);
    $('#reply').hidden = false;
    document.querySelectorAll('.vote button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }),
);

// ── copy buttons ────────────────────────────────────────────────────────────

document.querySelectorAll<HTMLButtonElement>('.copy').forEach((b) =>
  b.addEventListener('click', async () => {
    const text = b.parentElement?.querySelector('code')?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(text);
      b.textContent = 'Copied';
    } catch {
      // Clipboard can be blocked in embedded frames: select the text so it can be copied by hand.
      const code = b.parentElement?.querySelector('code');
      if (code) getSelection()?.selectAllChildren(code);
      b.textContent = 'Selected';
    }
    setTimeout(() => (b.textContent = 'Copy'), 1600);
  }),
);

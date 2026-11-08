// Runs inside the prototype frame: the real widget, starting with the two example notes from the
// recorded run. Submitting hands the notes to the demo page instead of GitHub.
import { init } from '@peanut-gallery/widget';
import type { ReviewSession } from '@peanut-gallery/core';
import example from './example-session.json';

const here = location.origin + location.pathname + location.search;
const session = structuredClone(example) as unknown as ReviewSession;
session.prototypeUrl = location.origin;
for (const a of session.annotations) a.pageUrl = here;

const post = (msg: unknown) => parent.postMessage(msg, '*');

const widget = init({
  repo: 'acme/checkout-prototype',
  author: 'You',
  loadFonts: true,
  session,
  onSubmit: (s) => {
    post({ type: 'peanut-demo:submit', session: s });
    return { keep: true };
  },
});

// Keep the demo page's issue preview in step with the notes as they change.
let last = '';
setInterval(() => {
  const notes = widget.getAnnotations();
  const sig = JSON.stringify(notes.map((n) => [n.id, n.text, n.kind]));
  if (sig !== last) {
    last = sig;
    post({ type: 'peanut-demo:notes', session: { ...session, annotations: notes } });
  }
}, 500);

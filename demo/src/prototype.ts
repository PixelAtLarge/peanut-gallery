// Runs inside the prototype frame: the real widget, starting with the two example notes from the
// recorded run. Submitting hands the notes to the demo page instead of GitHub.
import { init } from '@pixelatlarge/peanut-gallery-widget';
import type { ReviewSession } from '@pixelatlarge/peanut-gallery-core';
import example from './example-session.json';

const here = location.origin + location.pathname + location.search;
const session = structuredClone(example) as unknown as ReviewSession;
session.prototypeUrl = location.origin;
for (const a of session.annotations) a.pageUrl = here;

const post = (msg: unknown) => parent.postMessage(msg, '*');

// A teammate's note, as a relay with shareNotes would hand it over. Nothing is fetched: the demo
// answers the widget's request itself.
const RELAY = 'https://relay.demo.invalid/';
const teammate = [
  {
    id: 'an_teammate',
    text: 'Hide this until someone has a code. It pulls people away from paying.',
    kind: 'copy',
    author: 'Sam Rivera',
    anchor: { selector: 'p.promo > a', tag: 'a', textFingerprint: 'Have a promo code?', rect: { x: 0, y: 0, width: 1, height: 1 }, offset: { x: 1.12, y: 0.5 } },
    pageUrl: here,
    createdAt: '2026-11-04T15:12:00.000Z',
    issueNumber: 33,
    // The demo's own issue preview stands in for the GitHub issue.
    issueUrl: 'https://pixelatlarge.github.io/peanut-gallery/#issue',
  },
];
const realFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
  String(input instanceof Request ? input.url : input).startsWith(RELAY)
    ? Promise.resolve(new Response(JSON.stringify({ notes: teammate }), { headers: { 'content-type': 'application/json' } }))
    : realFetch(input, init);

const widget = init({
  repo: 'acme/checkout-prototype',
  author: 'You',
  loadFonts: true,
  relayUrl: RELAY,
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

// Script-tag entry. Also supports declarative config:
//   <script src="peanut-gallery.global.js" data-repo="owner/name" data-relay-url="..." data-activation="query"></script>
import { init, destroy } from './index.js';

export { init, destroy };

const script = typeof document !== 'undefined' ? (document.currentScript as HTMLScriptElement | null) : null;
if (script?.dataset.repo) {
  init({
    repo: script.dataset.repo,
    relayUrl: script.dataset.relayUrl,
    mode: script.dataset.mode as 'issue-url' | 'relay' | 'auto' | undefined,
    activation: script.dataset.activation as 'always' | 'query' | undefined,
    loadFonts: script.dataset.loadFonts === 'true',
    recordTyping: script.dataset.recordTyping !== 'false',
    author: script.dataset.author,
    labels: script.dataset.labels?.split(',').map((s) => s.trim()),
  });
}

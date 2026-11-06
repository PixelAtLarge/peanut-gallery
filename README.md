# Peanut Gallery 🥜

> Everyone's a critic. Now their critiques ship.

Annotate a hosted prototype → feedback lands in GitHub Issues → Claude turns it into concrete proposals, implements each on a branch, captures **before / after**, asks reviewers which they prefer, and opens a PR per change.

```
reviewer (browser)            your repo (CLI)                       GitHub
──────────────────            ───────────────                       ──────
click element, write note ─▶  issue w/ selector+text+page   ◀──── peanut-gallery:feedback
                              peanut-gallery review
                                pull      ─ parse issues
                                interpret ─ Claude clusters → proposals
                                apply     ─ Agent SDK edits on a branch
                                          ─ Playwright before/after shots
                                          ─ push, open PR  ───────────▶ PR + comparison
                                          ─ comment on issue ─────────▶ "👍 after / 👎 before?"
                                votes     ─ tally reactions/replies → label accepted/rejected
```

| Reviewers annotate the live prototype | Each change ships with a before / after | Not sold? Generate options |
| --- | --- | --- |
| ![Widget](docs/images/widget.png) | ![Before and after](docs/images/before-after.png) | ![Options](docs/images/options.png) |

Three packages, one CLI:

| package | what it is |
| --- | --- |
| `@peanut-gallery/widget` | Drop-in annotation layer (script tag or React). Shadow-DOM UI, pins attached to DOM elements, persists across pages, submits to GitHub. |
| `@peanut-gallery/relay` | Optional one-file serverless function that creates issues with a server-held token (one-click submit, reviewers don't need GitHub). |
| `peanut-gallery` (CLI) | Runs in the prototype repo: `init · pull · interpret · apply · review · votes · compare`. |
| `@peanut-gallery/core` | Shared types, robust element anchoring, issue body format. |

**What you need — and what you don't**

- **No local AI.** Nothing runs a model on anyone's machine; every AI step is a Claude API call. No GPU, no downloads.
- **Reviewers** need a browser. That's it.
- **The builder** (whoever runs the CLI) needs Node ≥ 20, git, the `gh` CLI (authenticated), a Chromium for screenshots (`npx playwright install chromium`, or `PEANUT_GALLERY_BROWSER=/path/to/chrome`), and Claude credentials: either an existing **Claude Code login** (`claude login` — picked up automatically) or `ANTHROPIC_API_KEY`.
- **Cost:** interpretation is pennies (Haiku). Each implemented proposal is an agentic coding session — typically **$0.50–2** with Sonnet depending on codebase size; the CLI prints an estimate before it starts and the actual spend after. `variants -n 3` ≈ three proposals.

---

## 1. Add the widget to the prototype

**Script tag (any page):**

```html
<script src="https://unpkg.com/@peanut-gallery/widget/dist/peanut-gallery.global.js"
        data-repo="owner/prototype-repo"
        data-activation="query"></script>
```

Open the prototype with `?peanut` in the URL. A toolbar appears: **Comment** → click any element → write a note (optionally tag it bug / copy / layout / visual / flow / question / praise). Pins are numbered and re-attach to their element on reload, resize and reorder. **Review** lists everything; **Submit to GitHub** opens a prefilled issue.

**React:**

```tsx
import { PeanutGallery } from '@peanut-gallery/widget/react';

{import.meta.env.VITE_PEANUT_GALLERY && <PeanutGallery repo="owner/prototype-repo" />}
```

**Programmatic:**

```ts
import { init } from '@peanut-gallery/widget';
init({ repo: 'owner/prototype-repo', relayUrl: 'https://…/api/peanut-gallery', author: 'Anna' });
```

| option | default | notes |
| --- | --- | --- |
| `repo` | — | `owner/name` |
| `mode` | `auto` | `issue-url` (zero infra, reviewer needs GitHub access) · `relay` · `auto` = relay if `relayUrl` set |
| `relayUrl` | — | see §2 |
| `activation` | `always` | `query` = only with `?peanut` (sticky per tab) |
| `author` | asks once | reviewer name on the issue |
| `labels` | `peanut-gallery, peanut-gallery:feedback` | |
| `kinds` | all seven | which tags to offer |
| `theme` | Conifer / Prep / Wasabi | override any colour or font role, e.g. `{ primary: '#5b3df5', fontBody: 'Inter, sans-serif' }` |
| `loadFonts` | `false` | load Manrope, Young Serif and JetBrains Mono from Google Fonts (`data-load-fonts="true"` on the script tag) |

### Theming

The widget and the generated comparison pages share one theme: a deep forest toolbar, emerald actions, sunny-yellow pins and outlines, carbon text on linen, with Young Serif headings and Manrope UI text. Every role (`primary`, `toolbar`, `accent`, `highlight`, `chip`, `bg`, `fontBody`, …, see `packages/core/src/theme.ts`) can be overridden — `theme` in `init()` for the widget, `theme` in `peanut-gallery.config.json` for the CLI's before/after and options pages:

```jsonc
{ "theme": { "primary": "#5b3df5", "toolbar": "#1b1340", "accent": "#ffcc4d" } }
```

The widget never loads webfonts on its own; it uses the theme fonts if the page already has them (or with `loadFonts: true`) and falls back to the system UI font.

### How anchoring works

Each note stores a CSS selector that prefers stable hooks (`data-testid`, `id`, `aria-label`, non-hashed classes, then a structural path), the element's text, tag, nearby heading, document rect and the click offset. On resolve it tries selector → selector + text → same-tag text search → stored coordinates, and reports a confidence. The same code runs in the widget and in the CLI's Playwright screenshots, so the "after" close-up finds the element even when the fix changed its text or moved it. Add `data-testid`s to important elements for best results.

## 2. (Optional) Relay for one-click submission

The browser can't hold a GitHub token. If reviewers shouldn't need GitHub accounts, deploy the relay — it's one function that validates the payload and creates the issue.

```ts
// api/peanut-gallery.ts (Vercel) — templates for Cloudflare, Netlify and Node are in packages/relay/templates
import { createRelayHandler } from '@peanut-gallery/relay';
export default createRelayHandler({
  githubToken: process.env.PEANUT_GALLERY_TOKEN!,        // fine-grained PAT, Issues: write on that one repo
  repo: process.env.PEANUT_GALLERY_REPO!,
  allowedOrigins: ['https://proto.example.com'],      // CORS
  sharedKey: process.env.PEANUT_GALLERY_KEY,             // optional, widget sends x-peanut-gallery-key
});
```

Then `data-relay-url="https://…/api/peanut-gallery"` on the widget.

## 3. Run the loop in the prototype repo

```bash
npm i -D peanut-gallery
npx peanut-gallery init          # writes peanut-gallery.config.json, creates labels, prints the widget snippet
npx peanut-gallery review        # pull → interpret → confirm → apply
```

`peanut-gallery.config.json`:

```jsonc
{
  "repo": "owner/prototype-repo",
  "prototypeUrl": "https://proto.example.com",   // "before" shots come from here; omit to use a local base-branch server
  "baseBranch": "main",
  "dev": { "command": "npm run dev -- --port {port}", "port": 4310 },
  "sourceHints": ["src/**"],                     // where the agent should look
  "agentNotes": "Tailwind + shadcn. Use tokens from src/theme.ts.",
  "models": { "interpret": "claude-haiku-5-5", "apply": "claude-sonnet-5-5" },   // try claude-opus-5-5 for apply on big codebases
  "budget": 10,                                   // USD cap per apply/review/variants run; --budget overrides
  "theme": {},                                    // optional colour/font overrides for comparison pages
  "screenshot": { "width": 1280, "height": 800 }
}
```

### Cost guardrails

- `apply --dry-run` / `review --dry-run` print a per-proposal estimate (by effort, refined from what earlier runs actually cost) and exit.
- `--budget 5` (or `budget` in config) stops **before** starting a proposal that would push spend over the cap, so a run never surprises you. Already-built proposals are kept.
- Per-stage models: cheap model for triage and option generation, stronger model for the code. A single `model` still works as a shortcut for both.

### Commands

| command | does |
| --- | --- |
| `pull [--all]` | Fetch issues labelled `peanut-gallery:feedback`, parse the embedded session → `.peanut-gallery/feedback.json` |
| `interpret` | Claude groups comments into independent proposals (title, summary, agent spec, affected pages/elements, effort, confidence) → `.peanut-gallery/proposals.json`. Edit this file if you disagree. |
| `apply [--only id…] [--draft] [--no-pr] [--no-screenshots] [--no-comment] [--include-contested]` | Per proposal: git worktree from base → Agent SDK implements (edits auto-accepted; shell limited to npm/npx/pnpm/yarn) → commit → start the dev server in the worktree → Playwright before/after (close-ups of each annotated element + full page) → `compare.html` (side-by-side / slider / toggle) + `summary.png` committed on the branch → push → PR with the image → comment on each source issue asking for a vote. |
| `variants <id> [-n 1–3] [--note "…"]` | Not happy with the before/after? Generate 1–3 genuinely different directions for the same proposal (Claude is told what was already tried and your note), build each on its own branch + PR, and post one combined **before / A / B / C** image to the issue. Reviewers reply with a letter; `votes` tallies it. Re-run with a new note for another round (labels become A2, B2…). |
| `decide <id> <n>` | Resolve a contested proposal by picking one of its positions, then `apply --only <id>`. |
| `review [-y] [--dry-run]` | The three above in sequence with a confirmation. |
| `votes [--label]` | Tallies 👍/❤️/🚀 (after) vs 👎/😕 (before) on the comparison comments plus replies ("after", "keep the original", …). `--label` applies `peanut-gallery:accepted` / `rejected` and comments on the PR. |
| `compare <id>` | Opens the interactive before/after page for a proposal locally. |

### Agreement and conflict

`interpret` doesn't just cluster — it records **who** asked for each change and flags **disagreement**:

- Every proposal carries `support` (distinct reviewers, comment count), computed from the annotations rather than guessed by the model. PRs and issue comments open with it: _"3 reviewers agree — anna, bob, cy (5 comments)"_ vs _"requested by anna"_.
- When comments about the same element pull in different directions, the proposal is marked `contested` with each position (summary, its own implementable instructions, which reviewers hold it) and a recommendation. `apply` **skips** contested proposals and posts a "⚑ Decision needed" comment on the source issues listing the options. Once the team picks one, `peanut-gallery decide <id> <n>` rewrites the proposal and `apply --only <id>` builds it. `--include-contested` applies the recommendation instead, if you'd rather see it built than discussed.

### Not sold on the "after"? Ask for options

```bash
peanut-gallery variants pr_3f2a --note "first attempt was too heavy — one lighter, one bolder" -n 2
```

Each option is a real branch with a real PR, so picking one is a merge, not a re-brief. Options are reviewed in one grid rather than a chain of PRs, and "none, because…" is a legitimate answer that seeds the next round.

Everything is reviewable and reversible: proposals are a JSON file you can edit before applying, each change is its own branch/PR, and the agent never touches `main`.

### The reviewer's second look

After `apply`, each feedback issue gets a comment with the side-by-side image, the PR link and a vote prompt. Reviewers react or reply in plain language; `votes` reads it back. For a live "after", point reviewers at the PR's preview deployment (Vercel/Netlify/Pages) with `?peanut` — they can annotate the new version and the loop runs again.

## Development

```bash
npm i
npm run build
npm test
node scripts/e2e-smoke.mjs     # drives the widget in a real browser + runs the screenshot/compare pipeline (no AI/GitHub needed)
```

`examples/vanilla-prototype` is a static checkout page with the widget wired up (`npm run example`, then open `http://localhost:5173/?peanut`).

## Roadmap / known limits

- `issue-url` mode truncates very long sessions to fit GitHub's URL limit (~40 short notes); use the relay for big sessions.
- Screenshots are desktop-only (`screenshot.width`); mobile viewports per proposal are a TODO.
- Prototypes that need auth: set `prototypeUrl` to a local server, or extend `captureShots` with a storage state.
- Relay-mode shared pins (see teammates' comments while annotating, +1 instead of re-writing) are the planned next pass.
- `variants` publishes the combined image to a `peanut-gallery/assets` branch so it can be embedded in issue comments; delete that branch any time.
- Vote classification is keyword-based; a Claude pass for nuanced replies ("after, but the old colour") is planned.
- Framework-aware source mapping (React component names/`data-source` attributes) would tighten the agent's edits further.

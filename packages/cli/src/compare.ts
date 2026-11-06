import { DEFAULT_FONTS_URL, DEFAULT_THEME, themeToCssVars, type Proposal, type Theme } from '@peanut-gallery/core';

export interface ComparePair {
  label: string;
  before: string; // relative path from the compare page
  after: string;
}

/** Shared <head> bits: theme variables + the default webfonts (falls back to system fonts offline). */
const themeHead = (theme: Theme) => `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="${DEFAULT_FONTS_URL}">
<style>:root{color-scheme:light;${themeToCssVars(theme)}}
body{font-family:var(--pg-font-body);color:var(--pg-text);background:var(--pg-bg);-webkit-font-smoothing:antialiased}
h1{font-family:var(--pg-font-display);font-weight:400;color:var(--pg-heading);letter-spacing:-.01em}
code{font-family:var(--pg-font-mono)}
a{color:var(--pg-link)}</style>`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Self-contained before/after page with side-by-side, slider and toggle views. */
export function renderComparePage(proposal: Proposal, pairs: ComparePair[], meta: { prUrl?: string; issueNumbers: number[]; repo: string }, theme: Theme = DEFAULT_THEME): string {
  const issues = meta.issueNumbers.map((n) => `<a href="https://github.com/${meta.repo}/issues/${n}">#${n}</a>`).join(', ');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(proposal.title)} — before / after</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
${themeHead(theme)}
<style>
  body{margin:0}
  header{padding:28px 36px 24px;border-bottom:1px solid var(--pg-line);background:var(--pg-surface)}
  .brand{font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--pg-muted);margin-bottom:10px}
  h1{margin:0 0 8px;font-size:30px;line-height:1.15}
  .meta{color:var(--pg-muted);font-size:13px}
  .meta code{background:var(--pg-ghost);padding:1px 6px;border-radius:5px;font-size:12px}
  .summary{max-width:70ch;margin:12px 0 0;font-size:15px;line-height:1.55}
  main{padding:28px 36px;display:grid;gap:28px}
  section{background:var(--pg-surface);border:1px solid var(--pg-line);border-radius:14px;overflow:hidden}
  section h2{margin:0;padding:12px 16px;font-size:14px;font-weight:700;border-bottom:1px solid var(--pg-line);display:flex;justify-content:space-between;align-items:center}
  .views{display:flex;gap:4px}
  .views button{font:inherit;font-size:12px;font-weight:600;border:1px solid var(--pg-line);background:var(--pg-surface);color:var(--pg-text);border-radius:999px;padding:4px 12px;cursor:pointer}
  .views button[aria-pressed=true]{background:var(--pg-heading);color:var(--pg-on-primary);border-color:var(--pg-heading)}
  .views button:focus-visible{outline:2px solid var(--pg-accent);outline-offset:2px}
  .side{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--pg-line)}
  .side figure{margin:0;background:var(--pg-surface);padding:14px}
  .side figcaption{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--pg-muted);margin-bottom:8px}
  .side figure:last-child figcaption{color:var(--pg-success)}
  .side img{display:block;max-width:100%;height:auto;border:1px solid var(--pg-line);border-radius:8px}
  .slider{position:relative;overflow:hidden;background:var(--pg-surface);padding:14px;display:none}
  .slider .stage{position:relative;display:inline-block;max-width:100%}
  .slider img{display:block;max-width:100%;height:auto}
  .slider .top{position:absolute;inset:0;overflow:hidden;width:50%}
  .slider .top img{max-width:none}
  .slider input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:ew-resize;margin:0}
  .slider .bar{position:absolute;top:0;bottom:0;left:50%;width:3px;margin-left:-1px;background:var(--pg-accent);pointer-events:none}
  .toggle{display:none;padding:14px;background:var(--pg-surface)}
  .toggle img{display:block;max-width:100%;height:auto;border:1px solid var(--pg-line);border-radius:8px}
  .toggle .hint{font-size:12px;color:var(--pg-muted);margin-top:6px}
  section[data-view=slider] .side,section[data-view=toggle] .side{display:none}
  section[data-view=slider] .slider{display:block}
  section[data-view=toggle] .toggle{display:block}
  footer{padding:16px 36px 32px;color:var(--pg-muted);font-size:12px}
</style></head>
<body>
<header>
  <div class="brand">🥜 Peanut Gallery · before / after</div>
  <h1>${esc(proposal.title)}</h1>
  <div class="meta">Proposal <code>${esc(proposal.id)}</code> · from ${issues}${meta.prUrl ? ` · <a href="${esc(meta.prUrl)}">pull request</a>` : ''} · effort ${esc(proposal.effort)} · confidence ${(proposal.confidence * 100).toFixed(0)}%</div>
  <p class="summary">${esc(proposal.summary)}</p>
</header>
<main>
${pairs
  .map(
    (p, i) => `<section data-view="side" id="pair-${i}">
  <h2><span>${esc(p.label)}</span><span class="views"><button aria-pressed="true" data-v="side">Side by side</button><button data-v="slider">Slider</button><button data-v="toggle">Toggle</button></span></h2>
  <div class="side">
    <figure><figcaption>Before</figcaption><img src="${esc(p.before)}" alt="Before: ${esc(p.label)}"></figure>
    <figure><figcaption>After</figcaption><img src="${esc(p.after)}" alt="After: ${esc(p.label)}"></figure>
  </div>
  <div class="slider"><div class="stage"><img src="${esc(p.after)}" alt=""><div class="top"><img src="${esc(p.before)}" alt=""></div><div class="bar"></div><input type="range" min="0" max="100" value="50" aria-label="Reveal"></div></div>
  <div class="toggle"><img src="${esc(p.before)}" data-before="${esc(p.before)}" data-after="${esc(p.after)}" alt=""><div class="hint">Showing <b>before</b> — click image or press space to toggle</div></div>
</section>`,
  )
  .join('\n')}
</main>
<footer>Generated by peanut-gallery. Reply on the issue with “after” or “before”, or react 👍 / 👎 on the comparison comment.</footer>
<script>
document.querySelectorAll('section').forEach(s=>{
  s.querySelectorAll('.views button').forEach(b=>b.onclick=()=>{s.dataset.view=b.dataset.v;s.querySelectorAll('.views button').forEach(x=>x.setAttribute('aria-pressed',x===b));});
  const r=s.querySelector('.slider input'),top=s.querySelector('.slider .top'),bar=s.querySelector('.slider .bar'),stage=s.querySelector('.slider .stage');
  const sync=()=>{top.style.width=r.value+'%';bar.style.left=r.value+'%';top.querySelector('img').style.width=stage.clientWidth+'px';};
  r.oninput=sync;new ResizeObserver(sync).observe(stage);
  const t=s.querySelector('.toggle img'),h=s.querySelector('.toggle .hint');let after=false;
  const flip=()=>{after=!after;t.src=after?t.dataset.after:t.dataset.before;h.innerHTML='Showing <b>'+(after?'after':'before')+'</b> — click image or press space to toggle';};
  t.onclick=flip;document.addEventListener('keydown',e=>{if(e.code==='Space'&&s.dataset.view==='toggle'){e.preventDefault();flip();}});
});
</script>
</body></html>`;
}

/** Compact static page used to render the PR summary PNG (no controls). */
export function renderSummaryPage(proposal: Proposal, pairs: ComparePair[], theme: Theme = DEFAULT_THEME): string {
  return `<!doctype html><html><head><meta charset="utf-8">${themeHead(theme)}<style>
  body{margin:0;padding:28px;width:1352px}
  .brand{font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--pg-muted);margin-bottom:6px}
  h1{font-size:24px;margin:0 0 18px}
  .pair{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:22px}
  .pair>div{background:var(--pg-surface);border:1px solid var(--pg-line);border-radius:10px;padding:12px}
  .cap{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--pg-muted);margin-bottom:8px}
  .pair>div:last-child .cap{color:var(--pg-success)}
  img{display:block;max-width:100%;height:auto;border-radius:6px}
  .label{font-size:13px;font-weight:700;margin:0 0 8px}
  </style></head><body><div class="brand">🥜 Peanut Gallery</div><h1>${esc(proposal.title)}</h1>
  ${pairs.map((p) => `<p class="label">${esc(p.label)}</p><div class="pair"><div><div class="cap">Before</div><img src="${esc(p.before)}"></div><div><div class="cap">After</div><img src="${esc(p.after)}"></div></div>`).join('')}
  </body></html>`;
}

export interface OptionColumn {
  label: string; // "A"
  title: string; // option title
  summary: string;
  /** image paths per target, same order as `targets` */
  images: string[];
  prUrl?: string;
}

/** before | A | B | C grid, one row per screenshot target. Used for the variants round. */
export function renderOptionsPage(
  proposal: Pick<Proposal, 'title' | 'summary'>,
  targets: string[],
  before: string[],
  options: OptionColumn[],
  opts: { compact?: boolean; theme?: Theme } = {},
): string {
  const theme = opts.theme ?? DEFAULT_THEME;
  const cols = 1 + options.length;
  const head = opts.compact
    ? `<style>body{margin:0;padding:28px;width:${Math.min(1600, 360 * cols + 56)}px}</style>`
    : `<style>body{margin:0;padding:28px 36px}</style>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(proposal.title)} — options</title>${themeHead(theme)}${head}
<style>
  .brand{font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--pg-muted);margin-bottom:6px}
  h1{font-size:24px;margin:0 0 4px} .sub{color:var(--pg-muted);font-size:14px;margin:0 0 18px;max-width:80ch}
  .grid{display:grid;grid-template-columns:repeat(${cols},minmax(0,1fr));gap:12px;align-items:start}
  .hd{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--pg-muted);padding:6px 0}
  .hd b{display:inline-block;background:var(--pg-heading);color:var(--pg-on-primary);border-radius:6px;padding:1px 8px;margin-right:6px;letter-spacing:0}
  .hd .t{display:block;text-transform:none;letter-spacing:0;color:var(--pg-text);font-weight:700;font-size:14px;margin-top:4px}
  .hd .s{display:block;text-transform:none;letter-spacing:0;color:var(--pg-muted);font-size:12px;font-weight:500;margin-top:2px;line-height:1.4}
  .row{font-size:13px;font-weight:700;grid-column:1/-1;margin-top:10px;padding-top:12px;border-top:1px solid var(--pg-line)}
  .cell{border:1px solid var(--pg-line);border-radius:10px;padding:8px;background:var(--pg-surface)}
  img{display:block;max-width:100%;height:auto;border-radius:6px}
  a{font-size:12px;font-weight:600}
</style></head><body>
<div class="brand">🥜 Peanut Gallery · options</div><h1>${esc(proposal.title)}</h1><p class="sub">${esc(proposal.summary)}</p>
<div class="grid">
  <div class="hd">Before</div>
  ${options.map((o) => `<div class="hd"><b>${esc(o.label)}</b>option<span class="t">${esc(o.title)}</span><span class="s">${esc(o.summary)}</span>${o.prUrl && !opts.compact ? `<a href="${esc(o.prUrl)}">pull request</a>` : ''}</div>`).join('')}
  ${targets
    .map(
      (t, i) =>
        `<div class="row">${esc(t)}</div><div class="cell"><img src="${esc(before[i] ?? '')}" alt="Before"></div>` +
        options.map((o) => `<div class="cell"><img src="${esc(o.images[i] ?? '')}" alt="Option ${esc(o.label)}"></div>`).join(''),
    )
    .join('')}
</div></body></html>`;
}

import { ISSUE_BLOCK_LANG, stepLabel, type Annotation, type ReviewSession } from './types.js';

/** Human-readable + machine-parseable GitHub issue body for a review session. */
export function sessionToIssue(session: ReviewSession): { title: string; body: string } {
  const n = session.annotations.length;
  const page = safePath(session.annotations[0]?.pageUrl ?? session.prototypeUrl);
  const title = `Feedback: ${n} comment${n === 1 ? '' : 's'} on ${page}`;

  const lines: string[] = [];
  lines.push(`**Prototype:** ${session.prototypeUrl}`);
  if (session.author) lines.push(`**Reviewer:** ${session.author}`);
  lines.push(`**Session:** \`${session.id}\` · ${session.createdAt}`);
  lines.push('');
  session.annotations.forEach((a, i) => {
    lines.push(`### ${i + 1}. ${a.kind ? `[${a.kind}] ` : ''}${firstLine(a.text)}`);
    if (a.text.includes('\n')) lines.push(a.text.split('\n').slice(1).join('\n'));
    lines.push('');
    lines.push(`- **Page:** ${a.pageUrl}`);
    lines.push(`- **Element:** \`${a.anchor.tag ?? '?'}\` → \`${a.anchor.selector}\``);
    if (a.anchor.textFingerprint) lines.push(`- **Text:** “${a.anchor.textFingerprint}”`);
    if (a.anchor.context) lines.push(`- **Near:** ${a.anchor.context}`);
    if (a.steps?.length) lines.push(`- **Reached by clicking:** ${a.steps.map(stepLabel).join(' → ')}`);
    if (a.viewport && Number.isFinite(a.viewport.width) && Number.isFinite(a.viewport.height)) lines.push(`- **Viewport:** ${a.viewport.width}×${a.viewport.height}`);
    lines.push('');
  });
  lines.push('<details><summary>peanut-gallery data (do not edit)</summary>');
  lines.push('');
  lines.push('```' + ISSUE_BLOCK_LANG);
  lines.push(JSON.stringify(session, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('</details>');
  return { title, body: lines.join('\n') };
}

/** Parse a session back out of an issue body. Returns null if no block found. */
export function issueToSession(body: string): ReviewSession | null {
  const re = new RegExp('```' + ISSUE_BLOCK_LANG.replace(/ /g, '\\s+') + '\\s*\\n([\\s\\S]*?)\\n```');
  const m = body.match(re);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]) as ReviewSession;
    if (!Array.isArray(parsed.annotations)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Build a `/issues/new` URL. GitHub caps URLs around 8k chars; if the body
 * is too long we trim the machine block to the essentials and note it.
 */
export function newIssueUrl(repo: string, session: ReviewSession, labels: string[] = [], maxLen = 7500): string {
  const base = `https://github.com/${repo}/issues/new`;
  const build = (s: ReviewSession) => {
    const { title, body } = sessionToIssue(s);
    const params = new URLSearchParams({ title, body });
    if (labels.length) params.set('labels', labels.join(','));
    return `${base}?${params.toString()}`;
  };
  let url = build(session);
  if (url.length <= maxLen) return url;
  // Shrink: drop context + rect precision, shorten fingerprints.
  const slim: ReviewSession = {
    ...session,
    userAgent: undefined,
    annotations: session.annotations.map((a) => ({
      ...a,
      anchor: {
        ...a.anchor,
        context: undefined,
        textFingerprint: a.anchor.textFingerprint.slice(0, 40),
        rect: roundRect(a.anchor.rect),
      },
      steps: a.steps?.map((st) => ({ ...st, context: undefined, textFingerprint: st.textFingerprint.slice(0, 40), rect: roundRect(st.rect) })),
    })),
  };
  url = build(slim);
  if (url.length <= maxLen) return url;
  // Last resort: split annotations across multiple issues isn't possible in one URL;
  // keep the first N that fit.
  const kept: Annotation[] = [];
  for (const a of slim.annotations) {
    const trial = build({ ...slim, annotations: [...kept, a] });
    if (trial.length > maxLen) break;
    kept.push(a);
  }
  return build({ ...slim, annotations: kept });
}

function roundRect(r: { x: number; y: number; width: number; height: number }) {
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
}

function firstLine(s: string): string {
  return s.split('\n')[0].trim().slice(0, 100) || '(no text)';
}

function safePath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === '/' ? u.host : u.pathname;
  } catch {
    return url;
  }
}

export function uid(prefix = ''): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return prefix ? `${prefix}_${rand}` : rand;
}

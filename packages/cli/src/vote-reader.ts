import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { completeText, extractJson } from './llm.js';

/** What a reply says about one proposal: keep the change, keep the original, neither, or not a vote. */
export type Lean = 'after' | 'before' | 'neither' | 'unclear';

/** Something peanut-gallery posted on an issue for people to vote on. */
export interface VotePost {
  /** proposalId, or the proposal an options round is for. */
  key: string;
  kind: 'proposal' | 'options';
  commentId: number;
  title: string;
  summary?: string;
  prNumber?: number;
  /** Option letters, for an options round. */
  labels?: string[];
}

export interface Reply {
  id: number;
  author: string;
  body: string;
}

export interface Reading {
  replyId: number;
  /** The post this reply is about (VotePost.key), or null if it came before any. */
  post: string | null;
  lean: Lean;
  /** For an options round: the letter they picked. */
  option?: string | null;
  /** Anything else they asked for ("keep the old colour"), in a few words. */
  note?: string;
  by: 'keywords' | 'claude';
}

/** Words that mean a reply is more than a plain vote, so keywords can't be trusted with it. */
const NUANCE = /\b(but|except|though|although|however|unless|only if|if only|neither|nor|both|not sure|unsure|maybe|instead|rather|wish|could (you|we)|can (you|we)|would (you|be)|should|prefer(red)? (the )?(old|original|first|second)|not (the|a) (new|old)|either)\b|\?/i;

const ours = (r: Reply) => /peanut-gallery proposal|<!-- peanut-gallery/.test(r.body) || /\[bot\]$/.test(r.author);

/** Replies people wrote (not our comparison comments, verdicts, or bots). */
export const humanReplies = (rs: Reply[]) => rs.filter((r) => !ours(r));

/**
 * Which post a reply is about, without Claude. `certain` when it names a pull request, quotes a
 * post, or only one post came before it; otherwise the nearest post above it.
 */
export function placeReply(reply: Reply, posts: VotePost[]): { key: string; certain: boolean } | null {
  const before = posts.filter((p) => p.commentId < reply.id).sort((a, b) => a.commentId - b.commentId);
  if (!before.length) return null;
  const text = reply.body;
  for (const p of before) {
    if (p.prNumber && new RegExp(`(#|/pull/)${p.prNumber}(?!\\d)`).test(text)) return { key: p.key, certain: true };
  }
  const quoted = text
    .split('\n')
    .filter((l) => l.startsWith('>'))
    .join(' ')
    .toLowerCase();
  if (quoted) {
    const hit = before.filter((p) => quoted.includes(p.title.toLowerCase()));
    if (hit.length) return { key: hit[hit.length - 1].key, certain: true };
  }
  const keys = new Set(before.map((p) => p.key));
  if (keys.size === 1) return { key: before[0].key, certain: true };
  return { key: before[before.length - 1].key, certain: false };
}

/** The text a reply adds, without quoted lines. */
const ownText = (body: string) =>
  body
    .split('\n')
    .filter((l) => !l.startsWith('>'))
    .join(' ')
    .trim();

/** A plain vote keywords can read with confidence ("after", "B", "👍 ship it"), or null. */
export function quickRead(reply: Reply, posts: VotePost[], classify: (t: string) => 'after' | 'before' | 'unclear', classifyOption: (t: string, labels: string[]) => string | null): Reading | null {
  const place = placeReply(reply, posts);
  if (!place) return { replyId: reply.id, post: null, lean: 'unclear', by: 'keywords' };
  const text = ownText(reply.body);
  const words = text.split(/\s+/).filter(Boolean).length;
  // Plain votes are short: "after", "👍 ship it", "B please". Longer replies usually say more.
  if (!place.certain || NUANCE.test(text) || words > 6) return null;
  const post = posts.find((p) => p.key === place.key)!;
  if (post.kind === 'options') {
    const option = classifyOption(text, post.labels ?? []);
    // "B please", "option A" — not "B, with the font from A".
    const others = (post.labels ?? []).filter((l) => l !== option && classifyOption(text.replace(new RegExp(`\\b${option}\\b`, 'gi'), ''), [l]));
    return option && words <= 4 && !others.length ? { replyId: reply.id, post: post.key, lean: 'unclear', option, by: 'keywords' } : null;
  }
  const lean = classify(text);
  return lean === 'unclear' ? null : { replyId: reply.id, post: post.key, lean, by: 'keywords' };
}

/** Keywords only: every reply goes to one post (named, quoted, or the nearest above it). */
export function keywordRead(reply: Reply, posts: VotePost[], classify: (t: string) => 'after' | 'before' | 'unclear', classifyOption: (t: string, labels: string[]) => string | null): Reading {
  const place = placeReply(reply, posts);
  if (!place) return { replyId: reply.id, post: null, lean: 'unclear', by: 'keywords' };
  const post = posts.find((p) => p.key === place.key)!;
  const text = ownText(reply.body);
  if (post.kind === 'options') return { replyId: reply.id, post: post.key, lean: 'unclear', option: classifyOption(text, post.labels ?? []), by: 'keywords' };
  return { replyId: reply.id, post: post.key, lean: classify(text), by: 'keywords' };
}

const SYSTEM = `You read replies on a GitHub issue where an automated tool posted before/after comparisons of proposed UI changes ("posts") and asked reviewers to vote.

For each reply, decide:
- post: which post it is about, by its id. Use what the reply says (a title, what changed, a PR number, a quote). If it doesn't say, it's about the nearest post above it ("nearest"). One post per reply. null only if it isn't about any post.
- lean, for a proposal post: "after" if they want the change (even if they also ask for tweaks), "before" if they prefer the original or want it reverted, "neither" if they reject both and want something different, "unclear" if it's a question, off-topic, or not a vote.
- option, for an options post: the option letter they picked, or null.
- note: anything else they ask for, as a short instruction in their words (at most 15 words), e.g. "keep the old colour". Omit when they only vote.

Reply with JSON only: {"readings":[{"reply":<id>,"post":"<id>"|null,"lean":"after"|"before"|"neither"|"unclear","option":"<letter>"|null,"note":"..."}]}`;

/**
 * Read replies with Claude: which proposal each is about, which way it leans, and anything else
 * the reviewer asked for. Throws if Claude can't be reached; callers fall back to keywords.
 */
export async function claudeRead(replies: Reply[], posts: VotePost[], opts: { model: string; client?: Anthropic }): Promise<(Reading | null)[]> {
  if (!replies.length) return [];
  const ids = new Map<string, VotePost>(posts.map((p, i) => [`P${i + 1}`, p]));
  const idOf = (key: string) => [...ids].find(([, p]) => p.key === key)?.[0] ?? null;
  const user = JSON.stringify(
    {
      posts: [...ids].map(([id, p]) => ({
        id,
        kind: p.kind,
        title: p.title,
        ...(p.summary ? { summary: p.summary } : {}),
        ...(p.prNumber ? { pr: `#${p.prNumber}` } : {}),
        ...(p.labels ? { options: p.labels } : {}),
      })),
      replies: replies.map((r) => {
        const place = placeReply(r, posts);
        return { id: r.id, author: r.author, text: r.body.slice(0, 2000), nearest: place ? idOf(place.key) : null, postedAfter: posts.filter((p) => p.commentId < r.id).map((p) => idOf(p.key)) };
      }),
    },
    null,
    1,
  );
  const text = await completeText({ system: SYSTEM, user, model: opts.model, maxTokens: 2000, client: opts.client });
  const parsed = extractJson(text) as { readings?: Array<{ reply: number; post: string | null; lean?: string; option?: string | null; note?: string }> };
  const byId = new Map((parsed?.readings ?? []).map((r) => [Number(r.reply), r]));
  return replies.map((r) => {
    const got = byId.get(r.id);
    const post = got?.post ? ids.get(got.post) : undefined;
    // Skipped, garbled, or about a post written after it: leave it to keywords.
    if (!got || !post || post.commentId > r.id) return null;
    const lean: Lean = got.lean === 'after' || got.lean === 'before' || got.lean === 'neither' ? got.lean : 'unclear';
    const option = post.kind === 'options' && got.option && post.labels?.some((l) => l.toLowerCase() === String(got.option).toLowerCase()) ? post.labels.find((l) => l.toLowerCase() === String(got.option).toLowerCase())! : null;
    const note = typeof got.note === 'string' && got.note.trim() ? got.note.trim().slice(0, 140) : undefined;
    return { replyId: r.id, post: post.key, lean: post.kind === 'options' ? 'unclear' : lean, ...(post.kind === 'options' ? { option } : {}), ...(note ? { note } : {}), by: 'claude' as const };
  });
}

/** Cache key for a reading: the reply and its text (an edited reply is read again). */
export const readingKey = (r: Reply) => `${r.id}:${createHash('sha1').update(r.body).digest('hex').slice(0, 12)}`;

export interface ReadOptions {
  reader: 'claude' | 'keywords';
  model: string;
  client?: Anthropic;
  classify: (t: string) => 'after' | 'before' | 'unclear';
  classifyOption: (t: string, labels: string[]) => string | null;
  /** Readings from earlier runs, by readingKey. Updated in place. */
  cache?: Record<string, Reading>;
  /** Told when Claude couldn't be reached and keywords were used instead. */
  onFallback?: (err: Error, count: number) => void;
}

/**
 * Read every reply on one issue. Plain votes are read with keywords; the rest go to Claude in
 * one request (or keywords, if Claude isn't available or `reader` is "keywords").
 */
export async function readReplies(replies: Reply[], posts: VotePost[], opts: ReadOptions): Promise<Reading[]> {
  const people = humanReplies(replies);
  const out = new Map<number, Reading>();
  const hard: Reply[] = [];
  for (const r of people) {
    const cached = opts.cache?.[readingKey(r)];
    if (cached && (cached.by === 'claude' || opts.reader === 'keywords')) {
      out.set(r.id, cached);
      continue;
    }
    const quick = quickRead(r, posts, opts.classify, opts.classifyOption);
    if (quick) out.set(r.id, quick);
    else hard.push(r);
  }
  if (hard.length) {
    let read: (Reading | null)[] | null = null;
    if (opts.reader === 'claude') {
      try {
        read = await claudeRead(hard, posts, { model: opts.model, client: opts.client });
      } catch (err) {
        opts.onFallback?.(err as Error, hard.length);
      }
    }
    for (const [i, r] of hard.entries()) out.set(r.id, read?.[i] ?? keywordRead(r, posts, opts.classify, opts.classifyOption));
  }
  const result = people.map((r) => out.get(r.id)!);
  // Remember Claude's readings; keyword readings are free to redo (and Claude may be back next time).
  if (opts.cache) for (const [i, r] of people.entries()) if (result[i].by === 'claude') opts.cache[readingKey(r)] = result[i];
  return result;
}

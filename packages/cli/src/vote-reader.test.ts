import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { placeReply, quickRead, readReplies, type Reading, type VotePost } from './vote-reader.js';
import { classify, classifyOption, notesMarkdown } from './commands/votes.js';

const pay: VotePost = { key: 'pr_pay', kind: 'proposal', commentId: 100, title: 'Make Pay now the primary action', prNumber: 41 };
const promo: VotePost = { key: 'pr_promo', kind: 'proposal', commentId: 200, title: 'Say what the promo code saves', prNumber: 42 };
const opts: VotePost = { key: 'pr_hero:options', kind: 'options', commentId: 300, title: 'Hero headline', labels: ['A', 'B'] };
const reply = (id: number, body: string, author = 'sam') => ({ id, author, body });

/** A stand-in Anthropic client that answers with `readings` and records what it was asked. */
function fakeClient(readings: (req: { replies: { id: number; nearest: string | null }[] }) => unknown[]) {
  const create = vi.fn(async (req: { messages: { content: string }[] }) => {
    const input = JSON.parse(req.messages[0].content);
    return { content: [{ type: 'text', text: JSON.stringify({ readings: readings(input) }) }] };
  });
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

const read = (replies: ReturnType<typeof reply>[], posts: VotePost[], extra: Partial<Parameters<typeof readReplies>[2]> = {}) =>
  readReplies(replies, posts, { reader: 'claude', model: 'm', classify, classifyOption, ...extra });

describe('placing a reply', () => {
  it('goes to the nearest post above it, and is certain when it names one', () => {
    expect(placeReply(reply(150, 'after'), [pay, promo])).toEqual({ key: 'pr_pay', certain: true });
    expect(placeReply(reply(250, 'after'), [pay, promo])).toEqual({ key: 'pr_promo', certain: false });
    expect(placeReply(reply(250, 'after on #41'), [pay, promo])).toEqual({ key: 'pr_pay', certain: true });
    expect(placeReply(reply(250, '> ### Proposed update: Make Pay now the primary action\n\nafter'), [pay, promo])).toEqual({ key: 'pr_pay', certain: true });
    expect(placeReply(reply(50, 'after'), [pay, promo])).toBeNull();
  });

  it('reads plain votes with keywords, and leaves anything more to Claude', () => {
    expect(quickRead(reply(150, 'After 👍'), [pay, promo], classify, classifyOption)).toMatchObject({ post: 'pr_pay', lean: 'after', by: 'keywords' });
    expect(quickRead(reply(150, 'after, but keep the old colour'), [pay], classify, classifyOption)).toBeNull();
    expect(quickRead(reply(150, 'neither, make it bigger'), [pay], classify, classifyOption)).toBeNull();
    // Two proposals and the reply doesn't say which: not certain, so not quick.
    expect(quickRead(reply(250, 'after'), [pay, promo], classify, classifyOption)).toBeNull();
    expect(quickRead(reply(350, 'B'), [opts], classify, classifyOption)).toMatchObject({ post: 'pr_hero:options', option: 'B' });
  });
});

describe('reading replies', () => {
  it('counts each reply for one proposal, and keeps what else they asked for', async () => {
    const { client, create } = fakeClient((input) =>
      input.replies.map((r) =>
        r.id === 210
          ? { reply: 210, post: 'P1', lean: 'after', note: 'keep the old button colour' }
          : { reply: r.id, post: r.nearest, lean: 'after' },
      ),
    );
    const replies = [
      reply(150, 'after'),
      reply(201, 'peanut-gallery proposal `x` (our own comment)'),
      reply(205, 'looks good', 'github-actions[bot]'),
      reply(210, 'The pay button one is great, but keep the old button colour'),
      reply(220, 'after'),
    ];
    const r = await read(replies, [pay, promo], { client });
    expect(r.map((x) => [x.replyId, x.post, x.lean, x.by])).toEqual([
      [150, 'pr_pay', 'after', 'keywords'],
      [210, 'pr_pay', 'after', 'claude'],
      [220, 'pr_promo', 'after', 'claude'],
    ]);
    expect(r[1].note).toBe('keep the old button colour');
    // One request, with only the replies keywords couldn't read.
    expect(create).toHaveBeenCalledTimes(1);
    expect(JSON.parse(create.mock.calls[0][0].messages[0].content).replies.map((x: { id: number }) => x.id)).toEqual([210, 220]);
  });

  it("doesn't let Claude give a vote to a proposal posted after the reply", async () => {
    const { client } = fakeClient(() => [{ reply: 150, post: 'P2', lean: 'before' }]);
    const r = await read([reply(150, 'meh, not sure about this one')], [pay, promo], { client });
    expect(r[0]).toMatchObject({ post: 'pr_pay', by: 'keywords' });
  });

  it('reads options rounds: the letter, checked against the real options', async () => {
    const { client } = fakeClient(() => [
      { reply: 310, post: 'P1', option: 'b', note: 'with the smaller font from A' },
      { reply: 320, post: 'P1', option: 'Z' },
    ]);
    const r = await read([reply(310, "I'd go with the second one, with the smaller font from A"), reply(320, 'hmm, are there more?')], [opts], { client });
    expect(r.map((x) => [x.option, x.note])).toEqual([
      ['B', 'with the smaller font from A'],
      [null, undefined],
    ]);
  });

  it('falls back to keywords when Claude is unavailable, and says so', async () => {
    const client = { messages: { create: vi.fn(async () => Promise.reject(new Error('no login'))) } } as unknown as Anthropic;
    const onFallback = vi.fn();
    const r = await read([reply(210, 'before, but the spacing is nicer'), reply(220, 'after')], [pay, promo], { client, onFallback });
    expect(onFallback).toHaveBeenCalledWith(expect.any(Error), 2);
    // Keywords still attribute each reply to one proposal: the nearest above it.
    expect(r.map((x) => [x.post, x.lean, x.by])).toEqual([
      ['pr_promo', 'before', 'keywords'],
      ['pr_promo', 'after', 'keywords'],
    ]);
  });

  it('never calls Claude with reader "keywords"', async () => {
    const { client, create } = fakeClient(() => []);
    await read([reply(210, 'after, but bigger')], [pay, promo], { client, reader: 'keywords' });
    expect(create).not.toHaveBeenCalled();
  });

  it("remembers Claude's readings, and reads an edited reply again", async () => {
    const cache: Record<string, Reading> = {};
    const { client, create } = fakeClient((input) => input.replies.map((r) => ({ reply: r.id, post: 'P1', lean: 'neither', note: 'try a darker green' })));
    const first = [reply(150, 'neither, try a darker green')];
    await read(first, [pay], { client, cache });
    const again = await read(first, [pay], { client, cache });
    expect(create).toHaveBeenCalledTimes(1);
    expect(again[0]).toMatchObject({ lean: 'neither', note: 'try a darker green', by: 'claude' });
    await read([reply(150, 'neither, try a darker green, or navy')], [pay], { client, cache });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('lists requests under a verdict', () => {
    expect(notesMarkdown([])).toBe('');
    expect(notesMarkdown([{ author: 'sam', note: 'keep the old colour' }])).toBe('\n\n**Reviewers also asked for:**\n- keep the old colour _(sam)_');
  });
});

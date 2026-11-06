import { describe, it, expect } from 'vitest';
import { flatten, interpret, parseJson } from './interpret.js';
import { classify } from './commands/votes.js';
import { renderComparePage } from './compare.js';
import { withDefaults } from './config.js';
import type { FeedbackIssue } from './github.js';

const issue: FeedbackIssue = {
  number: 12,
  title: 'Prototype feedback',
  url: 'https://github.com/o/r/issues/12',
  author: 'anna',
  createdAt: '2026-11-05T00:00:00Z',
  session: {
    id: 'rs_1',
    prototypeUrl: 'https://proto.example.com',
    createdAt: '2026-11-05T00:00:00Z',
    author: 'anna',
    annotations: [
      {
        id: 'an_1',
        text: 'Make this the primary button',
        kind: 'visual',
        pageUrl: 'https://proto.example.com/checkout',
        viewport: { width: 1280, height: 800 },
        createdAt: '2026-11-05T00:00:00Z',
        anchor: { selector: 'button[data-testid="pay"]', textFingerprint: 'Pay now', tag: 'button', rect: { x: 0, y: 0, width: 1, height: 1 }, offset: { x: 0.5, y: 0.5 }, context: 'Checkout' },
      },
      {
        id: 'an_2',
        text: 'Love this',
        kind: 'praise',
        pageUrl: 'https://proto.example.com/checkout',
        viewport: { width: 1280, height: 800 },
        createdAt: '2026-11-05T00:00:00Z',
        anchor: { selector: 'h1', textFingerprint: 'Checkout', tag: 'h1', rect: { x: 0, y: 0, width: 1, height: 1 }, offset: { x: 0.5, y: 0.5 } },
      },
    ],
  },
};

describe('interpret', () => {
  it('maps model output to proposals with issue numbers, pages and anchors', async () => {
    const fake = {
      messages: {
        create: async () => ({
          content: [
            {
              type: 'text',
              text:
                '```json\n' +
                JSON.stringify({
                  proposals: [
                    { title: 'Make Pay now the primary CTA', summary: 'Reviewer wants emphasis.', instructions: 'Use primary style.', annotationIds: ['an_1'], focusAnchorIds: ['an_1'], effort: 'small', confidence: 0.9 },
                  ],
                  skipped: [{ annotationId: 'an_2', reason: 'praise' }],
                }) +
                '\n```',
            },
          ],
        }),
      },
    };
    const flat = flatten([issue]);
    expect(flat[0].issueNumber).toBe(12);
    const r = await interpret(flat, { model: 'test', client: fake as never });
    expect(r.proposals).toHaveLength(1);
    const p = r.proposals[0];
    expect(p.issueNumbers).toEqual([12]);
    expect(p.pages).toEqual(['https://proto.example.com/checkout']);
    expect(p.focusAnchors[0].selector).toBe('button[data-testid="pay"]');
    expect(p.id).toMatch(/^pr_/);
    expect(r.skipped[0].annotationId).toBe('an_2');
  });

  it('tolerates prose around JSON', () => {
    expect(parseJson('Here you go: {"a":1} thanks')).toEqual({ a: 1 });
  });
});

describe('votes', () => {
  it('classifies replies', () => {
    expect(classify('After, definitely')).toBe('after');
    expect(classify('I prefer the original')).toBe('before');
    expect(classify('after but keep the old colour from before')).toBe('after');
    expect(classify('hmm')).toBe('unclear');
  });
});

describe('compare page', () => {
  it('renders both images and escapes html', () => {
    const html = renderComparePage(
      { id: 'pr_1', title: 'Fix <b>', summary: 's', instructions: 'i', annotationIds: [], issueNumbers: [12], pages: [], focusAnchors: [], effort: 'small', confidence: 0.8, support: { reviewers: ['anna'], count: 1, annotationCount: 1 } },
      [{ label: 'Button', before: 'before-el1.png', after: 'after-el1.png' }],
      { repo: 'o/r', issueNumbers: [12] },
    );
    expect(html).toContain('Fix &lt;b&gt;');
    expect(html).toContain('src="before-el1.png"');
    expect(html).toContain('src="after-el1.png"');
    expect(html).toContain('issues/12');
  });
});

describe('config', () => {
  it('fills defaults', () => {
    const c = withDefaults({ repo: 'o/r' });
    expect(c.baseBranch).toBe('main');
    expect(c.screenshot).toEqual({ width: 1280, height: 800, fullPage: false });
    expect(withDefaults({ repo: 'o/r', screenshot: { width: 390 } }).screenshot.width).toBe(390);
  });
});

describe('urls', () => {
  it('joins base subpaths and strips the prototype prefix', async () => {
    const { joinUrl } = await import('./screenshots.js');
    const { pathOf } = await import('./commands/pull.js');
    expect(joinUrl('https://x.io/app/', '/checkout?x=1')).toBe('https://x.io/app/checkout?x=1');
    expect(joinUrl('http://localhost:4310', '/')).toBe('http://localhost:4310/');
    expect(pathOf('https://x.io/app/checkout?x=1', 'https://x.io/app/')).toBe('/checkout?x=1');
    expect(pathOf('https://x.io/app/', 'https://x.io/app')).toBe('/');
    expect(pathOf('https://x.io/checkout')).toBe('/checkout');
  });
});

describe('agreement + conflict', () => {
  const two: FeedbackIssue = {
    ...issue,
    number: 13,
    url: 'https://github.com/o/r/issues/13',
    author: 'bob',
    session: {
      ...issue.session,
      id: 'rs_2',
      author: 'bob',
      annotations: [
        { ...issue.session.annotations[0], id: 'an_3', author: 'bob', text: 'Pay button needs more weight' },
        { ...issue.session.annotations[0], id: 'an_4', author: 'bob', text: 'Actually the whole footer is too loud, tone the buttons down' },
      ],
    },
  };
  const fake = (payload: unknown) => ({ messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] }) } });

  it('computes distinct-reviewer support and maps contested positions', async () => {
    const flat = flatten([issue, two]);
    const r = await interpret(flat, {
      model: 't',
      client: fake({
        proposals: [
          {
            title: 'Pay button emphasis',
            summary: 'Disagreement.',
            instructions: 'x',
            annotationIds: ['an_1', 'an_3', 'an_4'],
            focusAnchorIds: ['an_1'],
            effort: 'small',
            confidence: 0.6,
            contested: {
              reason: 'Two reviewers want it stronger, one wants it quieter.',
              positions: [
                { summary: 'Make primary', instructions: 'Use accent colour', annotationIds: ['an_1', 'an_3'] },
                { summary: 'Tone down', instructions: 'Reduce weight', annotationIds: ['an_4'] },
              ],
              recommended: 0,
            },
          },
        ],
        skipped: [],
      }) as never,
    });
    const p = r.proposals[0];
    expect(p.support).toEqual({ reviewers: ['anna', 'bob'], count: 2, annotationCount: 3 });
    expect(p.issueNumbers).toEqual([12, 13]);
    expect(p.contested?.positions[0].reviewers).toEqual(['anna', 'bob']);
    expect(p.contested?.positions[1].reviewers).toEqual(['bob']);
    expect(p.instructions).toBe('Use accent colour'); // follows the recommended position
    const { supportLine, decisionComment } = await import('./commands/apply.js');
    expect(supportLine(p)).toBe('2 reviewers agree — anna, bob (3 comments)');
    expect(decisionComment(p)).toContain('**Option 1**');
  });

  it('single-position "contested" degrades to a normal proposal', async () => {
    const r = await interpret(flatten([issue]), {
      model: 't',
      client: fake({ proposals: [{ title: 't', summary: 's', instructions: 'i', annotationIds: ['an_1'], effort: 'small', confidence: 1, contested: { reason: 'r', positions: [{ summary: 'only', instructions: 'i', annotationIds: ['an_1'] }], recommended: 0 } }], skipped: [] }) as never,
    });
    expect(r.proposals[0].contested).toBeUndefined();
    expect(r.proposals[0].support.count).toBe(1);
  });
});

describe('variants', () => {
  it('generates labelled directions and excludes what was tried', async () => {
    const { generateDirections } = await import('./commands/variants.js');
    let prompt = '';
    const client = { messages: { create: async (req: { messages: { content: string }[] }) => { prompt = req.messages[0].content; return { content: [{ type: 'text', text: JSON.stringify({ options: [{ title: 'Lighter', summary: 's1', instructions: 'i1' }, { title: 'Bolder', summary: 's2', instructions: 'i2' }, { title: 'Extra', summary: 's3', instructions: 'i3' }] }) }] }; } } };
    const p = { id: 'pr_1', title: 'Pay button', summary: 's', instructions: 'orig', annotationIds: [], issueNumbers: [12], pages: [], focusAnchors: [], effort: 'small', confidence: 1, support: { reviewers: ['anna'], count: 1, annotationCount: 1 } } as const;
    const prev = [{ proposalId: 'pr_1', title: 'Pay button', branch: 'b', screenshots: [], issueCommentIds: [], status: 'pr-opened', createdAt: '', agentSummary: 'Made it blue and huge' }] as never;
    const d = await generateDirections(p as never, prev, 2, { model: 't', note: 'less heavy', client: client as never });
    expect(d.map((x) => x.label)).toEqual(['A', 'B']);
    expect(d[0].title).toBe('Lighter');
    expect(prompt).toContain('Made it blue and huge');
    expect(prompt).toContain('less heavy');
    expect(prompt).toContain('exactly 2');
  });

  it('classifies option letters in replies', async () => {
    const { classifyOption } = await import('./commands/votes.js');
    expect(classifyOption('B please', ['A', 'B', 'C'])).toBe('B');
    expect(classifyOption('go with option a', ['A', 'B'])).toBe('A');
    expect(classifyOption('A but with the spacing from B', ['A', 'B'])).toBe('A');
    expect(classifyOption('a2 looks great', ['A2', 'B2'])).toBe('A2');
    expect(classifyOption('none of these', ['A', 'B'])).toBeNull();
    expect(classifyOption('I think a bigger button', ['A', 'B'])).toBeNull();
    expect(classifyOption('b', ['A', 'B'])).toBe('B');
    expect(classifyOption('Love A. Also b is fine', ['A', 'B'])).toBe('A');
  });

  it('renders the options grid', async () => {
    const { renderOptionsPage } = await import('./compare.js');
    const html = renderOptionsPage({ title: 'T', summary: 'S' }, ['btn', 'page'], ['b1.png', 'b2.png'], [
      { label: 'A', title: 'Lighter', summary: 's', images: ['a1.png', 'a2.png'], prUrl: 'https://x/pr/1' },
      { label: 'B', title: 'Bolder', summary: 's', images: ['b1a.png', 'b2a.png'] },
    ]);
    expect(html).toContain('repeat(3,');
    expect((html.match(/<img /g) ?? []).length).toBe(6);
    expect(html).toContain('https://x/pr/1');
  });
});

describe('models + budget', () => {
  it('resolves per-stage models with sensible precedence', () => {
    expect(withDefaults({ repo: 'o/r' }).models).toEqual({ interpret: 'claude-haiku-5-5', apply: 'claude-sonnet-5-5' });
    expect(withDefaults({ repo: 'o/r', model: 'claude-opus-5-5' }).models).toEqual({ interpret: 'claude-opus-5-5', apply: 'claude-opus-5-5' });
    expect(withDefaults({ repo: 'o/r', model: 'x', models: { apply: 'claude-opus-5-5' } }).models).toEqual({ interpret: 'x', apply: 'claude-opus-5-5' });
  });

  it('estimates from effort, then from observed spend', async () => {
    const { estimateCost } = await import('./commands/apply.js');
    expect(estimateCost({ runs: [] }, 'small')).toBe(0.5);
    expect(estimateCost({ runs: [] }, 'large')).toBe(2.5);
    const runs = [{ costUsd: 2 }, { costUsd: 4 }] as never;
    expect(estimateCost({ runs }, 'medium')).toBe(3);
    expect(estimateCost({ runs }, 'small')).toBe(1.5);
  });

  it('uses an injected client without any credentials', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { completeText } = await import('./llm.js');
      const client = { messages: { create: async () => ({ content: [{ type: 'text', text: 'hi' }] }) } };
      expect(await completeText({ system: 's', user: 'u', model: 'm', client: client as never })).toBe('hi');
    } finally {
      if (saved) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

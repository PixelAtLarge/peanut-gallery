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
    expect(c.screenshot).toEqual({ width: 1280, height: 800, fullPage: false, replayClicks: true, phone: 'auto', highlight: true });
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
    expect(pathOf('https://x.io/?peanut')).toBe('/');
    expect(pathOf('https://x.io/list?page=2&peanut&utm_source=li')).toBe('/list?page=2');
    expect(pathOf('https://x.io/#/checkout?peanut')).toBe('/#/checkout?peanut');
    expect(pathOf('https://x.io/about#team')).toBe('/about');
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

  it('estimates from defaults, then learns from past runs by size and model', async () => {
    const { estimateCost, estimateCostDetail } = await import('./commands/apply.js');
    // defaults
    expect(estimateCost({ runs: [] }, 'small')).toBe(1);
    expect(estimateCost({ runs: [] }, 'large')).toBe(4);
    expect(estimateCostDetail({ runs: [] }, 'medium').basis).toBe(0);
    // one priced run isn't enough to learn from
    expect(estimateCost({ runs: [{ costUsd: 9, effort: 'small' }] as never }, 'small')).toBe(1);
    // the real macOS run: four small changes at ~$0.90 → small ≈ $0.90, large scales with it
    const real = [0.92, 0.88, 0.88, 0.89].map((c) => ({ costUsd: c, effort: 'small', model: 'claude-sonnet-5-5' })) as never;
    expect(estimateCost({ runs: real }, 'small', 'claude-sonnet-5-5')).toBe(0.89);
    expect(estimateCost({ runs: real }, 'large', 'claude-sonnet-5-5')).toBe(3.54);
    expect(estimateCostDetail({ runs: real }, 'small', 'claude-sonnet-5-5').basis).toBe(4);
    // median shrugs off an outlier
    const spiky = [1, 1, 1, 20].map((c) => ({ costUsd: c, effort: 'small' })) as never;
    expect(estimateCost({ runs: spiky }, 'small')).toBe(1);
    // same-model history wins when there's enough of it
    const mixed = [
      { costUsd: 0.2, effort: 'small', model: 'claude-haiku-5-5' },
      { costUsd: 0.2, effort: 'small', model: 'claude-haiku-5-5' },
      { costUsd: 3, effort: 'small', model: 'claude-opus-5-5' },
      { costUsd: 3, effort: 'small', model: 'claude-opus-5-5' },
    ] as never;
    expect(estimateCost({ runs: mixed }, 'small', 'claude-haiku-5-5')).toBe(0.2);
    expect(estimateCost({ runs: mixed }, 'small', 'claude-opus-5-5')).toBe(3);
    // legacy records without a size count as medium
    expect(estimateCost({ runs: [{ costUsd: 4 }, { costUsd: 4 }] as never }, 'small')).toBe(2);
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

describe('replayed clicks', () => {
  it('labels pairs by how the element was reached', async () => {
    const { shotLabel } = await import('./commands/apply.js');
    const anchor = { selector: 'h2#t', textFingerprint: 'Remove item?', tag: 'h2', rect: { x: 0, y: 0, width: 1, height: 1 }, offset: { x: 0.5, y: 0.5 } };
    const step = { ...anchor, selector: 'button#remove', textFingerprint: 'Remove', tag: 'button' };
    const t = { key: 'el1', label: 'h2 “Remove item?” · /', pagePath: '/', anchor, steps: [step] };
    expect(shotLabel(t, { key: 'el1', label: '', file: '', found: true, replayed: ['clicking “Remove”'] }, { key: 'el1', label: '', file: '', found: true, replayed: ['clicking “Remove”'] })).toBe('h2 “Remove item?” · / — after clicking “Remove”');
    expect(shotLabel(t, { key: 'el1', label: '', file: '', found: false }, { key: 'el1', label: '', file: '', found: false })).toContain('even after replaying');
    expect(shotLabel({ ...t, steps: undefined }, { key: 'el1', label: '', file: '', found: false }, { key: 'el1', label: '', file: '', found: false })).toContain('when it first loads');
    expect(shotLabel(t, { key: 'el1', label: '', file: '', found: true }, { key: 'el1', label: '', file: '', found: true })).toBe(t.label);
  });
});


describe('running from GitHub Actions', () => {
  it('picks only new feedback, or the named issue', async () => {
    const { selectIssues } = await import('./commands/pull.js');
    const mk = (number: number, labels: string[]) => ({ number, title: '', url: '', author: '', createdAt: '', session: { id: 's', prototypeUrl: '', annotations: [], createdAt: '' }, labels });
    const all = [mk(1, ['peanut-gallery:feedback']), mk(2, ['peanut-gallery:feedback', 'peanut-gallery:proposal']), mk(3, ['peanut-gallery:feedback', 'peanut-gallery:accepted'])];
    const handled = ['peanut-gallery:proposal', 'peanut-gallery:accepted', 'peanut-gallery:rejected'];
    expect(selectIssues(all, {}, handled).map((i) => i.number)).toEqual([1, 2, 3]);
    expect(selectIssues(all, { new: true }, handled).map((i) => i.number)).toEqual([1]);
    expect(selectIssues(all, { issue: ['#2'] }, handled).map((i) => i.number)).toEqual([2]);
    expect(selectIssues(all, { issue: ['2'], new: true }, handled)).toEqual([]);
  });

  it('rebuilds proposals and option rounds from the comments posted on an issue', async () => {
    const { runsFromComments, mergeRuns } = await import('./commands/votes.js');
    const single = {
      id: 11, author: 'bot', createdAt: '2026-11-08T00:00:00Z', url: 'https://github.com/o/r/issues/5#c11',
      body: '### Proposed update: Make Pay primary\n_requested by ada_\n\nPull request: https://github.com/o/r/pull/9\n\n<sub>peanut-gallery proposal `pr_abc`</sub>',
    };
    const options = {
      id: 12, author: 'bot', createdAt: '2026-11-08T01:00:00Z', url: 'https://github.com/o/r/issues/5#c12',
      body: '### 2 options for: Make Pay primary\n_requested by ada_\n\n![before / options](x)\n\n**A** — Lighter · https://github.com/o/r/pull/10\n**B** — Bolder: full width · https://github.com/o/r/pull/11\n\n**Which one?** Reply with the letter\n\n<sub>peanut-gallery proposal `pr_abc` · options round 1</sub>',
    };
    const reply = { id: 13, author: 'ada', createdAt: '', url: '', body: 'After please' };
    const runs = runsFromComments(5, [single, options, reply]);
    expect(runs.map((r) => [r.proposalId, r.prNumber, r.variantLabel ?? null])).toEqual([
      ['pr_abc', 9, null],
      ['pr_abc_a', 10, 'A'],
      ['pr_abc_b', 11, 'B'],
    ]);
    expect(runs[0].title).toBe('Make Pay primary');
    expect(runs[2].title).toBe('Make Pay primary — Bolder: full width');
    expect(runs[1].variantOf).toBe('pr_abc');
    expect(runs[0].issueCommentIds).toEqual([{ issue: 5, commentId: 11, url: single.url }]);
    // Local history wins; GitHub fills in what it lacks.
    const local = [{ ...runs[0], title: 'local title', issueCommentIds: [] }];
    const merged = mergeRuns(local as never, runs);
    expect(merged).toHaveLength(3);
    expect(merged[0].title).toBe('local title');
    expect(merged[0].issueCommentIds.map((c) => c.commentId)).toEqual([11]);
  });

  it('posts a verdict once, and again only when it changes', async () => {
    const { lastVerdict } = await import('./commands/votes.js');
    const c = (v: string, key = 'pr_abc') => ({ body: `✅ …\n\n<!-- peanut-gallery:verdict ${key} ${v} -->` });
    expect(lastVerdict([], 'pr_abc')).toBeNull();
    expect(lastVerdict([c('after')], 'pr_abc')).toBe('after');
    expect(lastVerdict([c('after'), c('before')], 'pr_abc')).toBe('before');
    expect(lastVerdict([c('B', 'pr_abc:options')], 'pr_abc')).toBeNull();
    expect(lastVerdict([c('B', 'pr_abc:options')], 'pr_abc:options')).toBe('B');
  });

  it('writes a workflow that gates on the configured labels', async () => {
    const { workflowYaml } = await import('./workflow.js');
    const y = workflowYaml({ feedbackLabel: 'design-feedback', proposalLabel: 'design-proposal', budget: 3, ref: 'v1' });
    expect(y).toContain("github.event.label.name == 'design-feedback'");
    expect(y).toContain("contains(github.event.issue.labels.*.name, 'design-proposal')");
    expect(y).toContain('uses: PixelAtLarge/peanut-gallery@v1');
    expect(y).toContain('budget: 3');
    expect(y).toContain('deployments: read');
    expect(y).toContain('${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}');
    expect(y).not.toContain('\t');
  });
});

describe('GitHub Actions pull request permission', () => {
  it('recognises the refusal and explains the fix', async () => {
    const { ACTIONS_PR_BLOCKED, actionsPrHint } = await import('./github.js');
    expect(ACTIONS_PR_BLOCKED.test('gh: GitHub Actions is not permitted to create or approve pull requests. (HTTP 403)')).toBe(true);
    const hint = actionsPrHint('o/r');
    expect(hint).toContain('Allow GitHub Actions to create and approve pull requests');
    expect(hint).toContain('repos/o/r/actions/permissions/workflow -F can_approve_pull_request_reviews=true');
    expect(hint).not.toContain('default_workflow_permissions');
  });
});

describe('phone screenshots', () => {
  const anchor = (sel: string, text: string) => ({ selector: sel, textFingerprint: text, tag: 'div', rect: { x: 0, y: 0, width: 1, height: 1 }, offset: { x: 0.5, y: 0.5 } });
  const bar = anchor('div.mobile-bar', 'Checkout');
  const pay = anchor('button#pay', 'Pay now');
  const note = (id: string, a: ReturnType<typeof anchor>, width: number, page: string) => ({
    id, text: id, anchor: a, pageUrl: `https://p.test${page}`, viewport: { width, height: 800 }, createdAt: 'now', issueNumber: 1, issueUrl: '', reviewer: 'anna',
  });
  const proposal = (ids: string[], anchors: ReturnType<typeof anchor>[], pages: string[]) =>
    ({ id: 'pr_1', title: 't', summary: 's', instructions: 'i', annotationIds: ids, issueNumbers: [1], pages, focusAnchors: anchors, effort: 'small', confidence: 1, support: { reviewers: ['anna'], count: 1, annotationCount: 1 } }) as const;

  it('reads the setting', async () => {
    const { phoneShots } = await import('./config.js');
    expect(phoneShots(undefined)).toEqual({ mode: 'auto', width: 390, height: 844 });
    expect(phoneShots(false).mode).toBe('never');
    expect(phoneShots(true).mode).toBe('always');
    expect(phoneShots({ width: 375 })).toEqual({ mode: 'always', width: 375, height: 844 });
  });

  it('auto: notes left on a phone get phone shots, the rest stay desktop', async () => {
    const { shotTargets } = await import('./commands/apply.js');
    const anns = [note('a', bar, 390, '/'), note('b', pay, 1440, '/checkout')];
    const t = shotTargets({ ...proposal(['a', 'b'], [bar, pay], ['https://p.test/', 'https://p.test/checkout']), focusAnchors: [bar, pay] } as never, anns as never, 'https://p.test', { mode: 'auto' });
    expect(t.map((x) => [x.key, !!x.phone])).toEqual([['el1-phone', true], ['el2', false], ['page1', false], ['page1-phone', true], ['page2', false]]);
    expect(t[0].label).toBe('div “Checkout” · / · phone');
  });

  it('true: every target at both sizes; false: desktop only', async () => {
    const { shotTargets } = await import('./commands/apply.js');
    const anns = [note('a', bar, 390, '/')];
    const p = proposal(['a'], [bar], ['https://p.test/']) as never;
    expect(shotTargets(p, anns as never, 'https://p.test', { mode: 'always' }).map((x) => x.key)).toEqual(['el1', 'el1-phone', 'page1', 'page1-phone']);
    expect(shotTargets(p, anns as never, 'https://p.test', { mode: 'never' }).some((x) => x.phone)).toBe(false);
  });

  it('shows phone pairs at phone width', async () => {
    const { renderComparePage, renderSummaryPage } = await import('./compare.js');
    const p = proposal([], [], []) as never;
    const pairs = [{ label: 'desk', before: 'b.png', after: 'a.png' }, { label: 'x · phone', before: 'bp.png', after: 'ap.png', phone: true }];
    const html = renderComparePage(p, pairs, { repo: 'o/r', issueNumbers: [1] });
    expect(html).toContain('id="pair-1" class="phone"');
    expect(html).not.toContain('id="pair-0" class="phone"');
    expect(renderSummaryPage(p, pairs)).toContain('class="pair phone"');
  });
});

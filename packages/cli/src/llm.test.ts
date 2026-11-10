import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stand-in for the Claude Agent SDK (the route used with a Claude Code login and no API key).
const sdk = vi.hoisted(() => ({ calls: [] as unknown[], script: [] as unknown[][] }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: unknown) => {
    sdk.calls.push(args);
    const msgs = sdk.script.shift() ?? [];
    return (async function* () {
      for (const m of msgs) yield m;
    })();
  },
}));

import { completeJson, completeText, extractJson } from './llm.js';

const say = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const done = (result: string) => ({ type: 'result', subtype: 'success', result });

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  sdk.calls.length = 0;
  sdk.script.length = 0;
});
afterEach(() => {
  if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey;
});

describe('completeText via Claude Code login', () => {
  it('runs as a plain completion: no tools, none of the user’s settings, one turn', async () => {
    sdk.script.push([say('{"a":1}'), done('{"a":1}')]);
    expect(await completeText({ system: 'sys', user: 'u', model: 'claude-haiku-5-5' })).toBe('{"a":1}');
    const opts = (sdk.calls[0] as { options: Record<string, unknown> }).options;
    expect(opts.tools).toEqual([]);
    expect(opts.settingSources).toEqual([]);
    expect(opts.maxTurns).toBe(1);
    expect(opts.systemPrompt).toBe('sys');
  });

  it('reports login problems instead of treating the error text as the answer', async () => {
    sdk.script.push([
      { type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Invalid API key · Please run /login' }] } },
      { type: 'result', subtype: 'error_during_execution' },
    ]);
    await expect(completeText({ system: 's', user: 'u', model: 'm' })).rejects.toThrow(/\/login/);
  });

  it('treats an expired login as an auth error, not as the answer (and does not retry)', async () => {
    const msg = 'Failed to authenticate: OAuth session expired and could not be refreshed';
    sdk.script.push([say(msg), { type: 'result', subtype: 'success', is_error: true, result: msg }]);
    await expect(completeJson({ system: 's', user: 'u', model: 'm' })).rejects.toThrow(/\/login[\s\S]*OAuth session expired/);
    expect(sdk.calls).toHaveLength(1);
  });

  it('catches login errors even without an error flag', async () => {
    sdk.script.push([say('Invalid API key · Please run /login'), done('Invalid API key · Please run /login')]);
    await expect(completeText({ system: 's', user: 'u', model: 'm' })).rejects.toThrow(/\/login/);
  });

  it('reports rate limits plainly', async () => {
    sdk.script.push([{ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'Usage limit reached' }] } }]);
    await expect(completeText({ system: 's', user: 'u', model: 'm' })).rejects.toThrow(/rate_limit/);
  });
});

describe('completeJson', () => {
  it('retries once when the first reply is prose, then succeeds', async () => {
    sdk.script.push([say('Let me take a look at the page first.')], [say('{"proposals":[]}'), done('{"proposals":[]}')]);
    expect(await completeJson({ system: 's', user: 'u', model: 'm' })).toEqual({ proposals: [] });
    expect(sdk.calls).toHaveLength(2);
    expect((sdk.calls[1] as { prompt: string }).prompt).toContain('previous reply was not valid JSON');
  });

  it('says what the model replied when both attempts fail', async () => {
    sdk.script.push([say('Sorry, no.')], [say('Still no.')]);
    await expect(completeJson({ system: 's', user: 'u', model: 'm' })).rejects.toThrow(/It said: "Sorry, no\."/);
  });
});

describe('extractJson', () => {
  it('handles fences and surrounding prose', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here: {"a":{"b":2}} done')).toEqual({ a: { b: 2 } });
  });
});

describe('credentials', () => {
  it('strips line breaks and spaces a pasted token picked up', async () => {
    const { tidyCredentials } = await import('./llm.js');
    const env: NodeJS.ProcessEnv = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-abc\n', ANTHROPIC_API_KEY: '  \n' };
    tidyCredentials(env);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-abc');
    expect('ANTHROPIC_API_KEY' in env).toBe(false);
  });
});

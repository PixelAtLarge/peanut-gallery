import Anthropic from '@anthropic-ai/sdk';

/**
 * One-shot JSON completion used by `interpret` and `variants`.
 *
 * Auth, in order:
 *  1. ANTHROPIC_API_KEY → direct Messages API call.
 *  2. Otherwise → the Claude Agent SDK, which reuses an existing Claude Code login
 *     (`claude login`), so anyone with Claude Code installed needs no extra setup.
 */
export async function completeText(opts: { system: string; user: string; model: string; maxTokens?: number; client?: Anthropic }): Promise<string> {
  if (opts.client || process.env.ANTHROPIC_API_KEY) {
    const client = opts.client ?? new Anthropic();
    const msg = await client.messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 8000,
      system: opts.system,
      messages: [{ role: 'user', content: opts.user }],
    });
    return msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  let text = '';
  let failure: string | undefined;
  try {
    const q = query({
      prompt: opts.user,
      options: { model: opts.model, systemPrompt: opts.system, allowedTools: [], disallowedTools: ['*'], maxTurns: 1, permissionMode: 'dontAsk' },
    });
    for await (const msg of q) {
      const m = msg as { type: string; subtype?: string; result?: string; message?: { content?: Array<{ type: string; text?: string }> } };
      if (m.type === 'assistant' && m.message?.content) for (const b of m.message.content) if (b.type === 'text' && b.text) text += b.text;
      if (m.type === 'result' && m.subtype !== 'success') failure = m.result ?? m.subtype;
    }
  } catch (err) {
    failure = (err as Error).message;
  }
  if (!text) throw new Error(`${authHint()}${failure ? `\n(${failure.split('\n')[0]})` : ''}`);
  return text;
}

export function authHint(): string {
  return 'No Claude credentials found. Either run `claude login` (Claude Code) or set ANTHROPIC_API_KEY.';
}

/** True if either auth route looks available (cheap check, no network). */
export async function hasCredentials(): Promise<boolean> {
  if (process.env.ANTHROPIC_API_KEY) return true;
  const { existsSync } = await import('node:fs');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const home = homedir();
  return existsSync(join(home, '.claude', '.credentials.json')) || existsSync(join(home, '.claude.json')) || !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
}

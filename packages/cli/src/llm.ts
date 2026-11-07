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
  let resultText = '';
  let failure: string | undefined;
  try {
    const q = query({
      prompt: opts.user,
      options: {
        model: opts.model,
        systemPrompt: opts.system,
        // A plain completion: no built-in tools (an empty list disables them), and none of the
        // user's own Claude Code settings, hooks or CLAUDE.md files, which could reshape the reply.
        tools: [],
        settingSources: [],
        maxTurns: 1,
        permissionMode: 'dontAsk',
      },
    });
    for await (const msg of q) {
      const m = msg as {
        type: string;
        subtype?: string;
        result?: string;
        error?: string;
        message?: { content?: Array<{ type: string; text?: string }> };
      };
      if (m.type === 'assistant') {
        // Login, billing and rate-limit problems arrive as assistant messages with synthetic text.
        if (m.error) {
          failure = `${m.error}: ${(m.message?.content ?? []).map((b) => b.text ?? '').join(' ').trim()}`;
          continue;
        }
        for (const b of m.message?.content ?? []) if (b.type === 'text' && b.text) text += b.text;
      }
      if (m.type === 'result') {
        if (m.subtype === 'success' && typeof m.result === 'string') resultText = m.result;
        else failure ??= m.result ?? m.subtype;
      }
    }
  } catch (err) {
    failure ??= (err as Error).message;
  }
  const out = resultText || text;
  if (failure && !out) {
    const auth = /auth|login|credential|oauth|api key/i.test(failure);
    throw new Error(auth ? `${authHint()}\n(${failure.split('\n')[0]})` : `Claude request failed: ${failure.split('\n')[0]}`);
  }
  if (!out) throw new Error(authHint());
  return out;
}

/** Pull the first JSON object out of a model reply (tolerates code fences and surrounding prose). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    const snippet = trimmed.replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`Model did not return JSON. It said: "${snippet}${trimmed.length > 300 ? '…' : ''}"`);
  }
}

/** completeText + extractJson, with one corrective retry if the reply isn't valid JSON. */
export async function completeJson<T>(opts: Parameters<typeof completeText>[0]): Promise<T> {
  const first = await completeText(opts);
  try {
    return extractJson(first) as T;
  } catch (err) {
    const retry = await completeText({
      ...opts,
      user: `${opts.user}\n\nYour previous reply was not valid JSON:\n<previous_reply>\n${first.slice(0, 2000)}\n</previous_reply>\nReply again with ONLY the JSON object described above — no prose, no code fences.`,
    });
    try {
      return extractJson(retry) as T;
    } catch {
      throw err;
    }
  }
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

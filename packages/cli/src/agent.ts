import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Proposal } from '@peanut-gallery/core';
import type { FlatAnnotation } from './interpret.js';

export interface AgentRunResult {
  ok: boolean;
  summary: string;
  costUsd?: number;
  turns?: number;
}

/**
 * Implement a proposal inside `cwd` (an isolated git worktree) using the Claude Agent SDK.
 * Edits are auto-accepted; shell is limited to package-manager commands.
 */
export async function implementProposal(
  proposal: Proposal,
  annotations: FlatAnnotation[],
  opts: { cwd: string; model: string; sourceHints: string[]; agentNotes?: string; maxTurns?: number; onProgress?: (line: string) => void },
): Promise<AgentRunResult> {
  const anns = annotations.filter((a) => proposal.annotationIds.includes(a.id));
  const prompt = `You are implementing ONE design change in this prototype's codebase, requested by reviewers.

## Change: ${proposal.title}
${proposal.summary}

## Spec
${proposal.instructions}

## Original reviewer comments (for context; the spec above is authoritative)
${anns
  .map(
    (a) =>
      `- [${a.kind ?? 'note'}] "${a.text}" — on <${a.anchor.tag}> selector \`${a.anchor.selector}\`${a.anchor.textFingerprint ? ` with text "${a.anchor.textFingerprint}"` : ''}${a.anchor.context ? ` near "${a.anchor.context}"` : ''} (page ${a.pageUrl})`,
  )
  .join('\n')}

## Where the UI code lives
${opts.sourceHints.map((h) => `- ${h}`).join('\n')}
${opts.agentNotes ? `\n## Team notes\n${opts.agentNotes}\n` : ''}
## Rules
- Find the component/markup that renders the referenced element (search by the selector, data-testid, id, class names, and visible text).
- Make the smallest change that fully satisfies the spec. Do not refactor, rename, or touch unrelated files.
- Follow the project's existing conventions (styling approach, component patterns, tokens/design system).
- Keep accessibility intact (labels, contrast, focus states).
- Do not modify anything under .peanut-gallery/ or peanut-gallery.config.json.
- Do not commit; the tool commits for you.
- When finished, reply with a 2-4 sentence summary of what you changed and which files, suitable for a PR description.`;

  let summary = '';
  let costUsd: number | undefined;
  let turns: number | undefined;
  let ok = false;

  const q = query({
    prompt,
    options: {
      cwd: opts.cwd,
      model: opts.model,
      permissionMode: 'acceptEdits',
      allowedTools: ['Read', 'Edit', 'MultiEdit', 'Write', 'Glob', 'Grep', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(pnpm:*)', 'Bash(yarn:*)', 'Bash(ls:*)', 'Bash(cat:*)'],
      maxTurns: opts.maxTurns ?? 60,
    },
  });

  for await (const msg of q) {
    const m = msg as { type: string; subtype?: string; result?: string; total_cost_usd?: number; num_turns?: number; message?: { content?: Array<{ type: string; text?: string; name?: string }> } };
    if (m.type === 'assistant' && m.message?.content) {
      for (const block of m.message.content) {
        if (block.type === 'text' && block.text) opts.onProgress?.(block.text.split('\n')[0].slice(0, 120));
        if (block.type === 'tool_use' && block.name) opts.onProgress?.(`→ ${block.name}`);
      }
    }
    if (m.type === 'result') {
      ok = m.subtype === 'success';
      summary = m.result ?? (ok ? '' : `Agent ended with ${m.subtype}`);
      costUsd = m.total_cost_usd;
      turns = m.num_turns;
    }
  }
  return { ok, summary, costUsd, turns };
}

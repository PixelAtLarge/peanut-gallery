import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { issueToSession, type ReviewSession } from '@pixelatlarge/peanut-gallery-core';

const run = promisify(execFile);

export async function gh(args: string[], opts: { cwd?: string; input?: string } = {}): Promise<string> {
  if (opts.input !== undefined) return ghWithInput(args, opts.input, opts.cwd);
  try {
    const { stdout } = await run('gh', args, { cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string; code?: string };
    if (e.code === 'ENOENT') throw new Error('GitHub CLI (`gh`) not found. Install it and run `gh auth login`.');
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${e.stderr?.trim() || e.message}`);
  }
}

function ghWithInput(args: string[], input: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e: NodeJS.ErrnoException) =>
      reject(e.code === 'ENOENT' ? new Error('GitHub CLI (`gh`) not found. Install it and run `gh auth login`.') : e),
    );
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${err.trim() || out.trim() || `exit ${code}`}`))));
    child.stdin.end(input);
  });
}

/**
 * Call the GitHub REST API through `gh api`, sending a JSON body on stdin. REST only: some
 * environments (GitHub Enterprise setups, locked-down CI and agent sandboxes) block GraphQL,
 * which several high-level `gh` subcommands use under the hood.
 */
export async function ghApi<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown, cwd?: string): Promise<T> {
  const args = ['api', '-X', method, path];
  const out = body === undefined ? await gh(args, { cwd }) : await gh([...args, '--input', '-'], { cwd, input: JSON.stringify(body) });
  return (out.trim() ? JSON.parse(out) : undefined) as T;
}

export async function ghJson<T>(args: string[], cwd?: string): Promise<T> {
  return JSON.parse(await gh(args, { cwd })) as T;
}

export async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`git ${args.join(' ')} failed: ${e.stderr?.trim() || e.message}`);
  }
}

export interface FeedbackIssue {
  number: number;
  title: string;
  url: string;
  author: string;
  createdAt: string;
  session: ReviewSession;
}

export async function fetchFeedbackIssues(repo: string, label: string, state: 'open' | 'all' = 'open'): Promise<FeedbackIssue[]> {
  type Raw = { number: number; title: string; body: string; html_url: string; user: { login: string }; created_at: string; pull_request?: unknown };
  const raw = await ghJson<Raw[]>([
    'api',
    '--paginate',
    `repos/${repo}/issues?labels=${encodeURIComponent(label)}&state=${state}&per_page=100`,
  ]);
  const out: FeedbackIssue[] = [];
  for (const r of raw) {
    if (r.pull_request) continue;
    const session = issueToSession(r.body ?? '');
    if (!session) continue;
    out.push({ number: r.number, title: r.title, url: r.html_url, author: r.user.login, createdAt: r.created_at, session });
  }
  return out;
}

export async function ensureLabels(repo: string, labels: { name: string; color: string; description: string }[]) {
  for (const l of labels) {
    const fields = { color: l.color.replace(/^#/, ''), description: l.description };
    try {
      await ghApi('POST', `repos/${repo}/labels`, { name: l.name, ...fields });
    } catch (err) {
      // 422 = already exists → update it in place (same effect as `gh label create --force`).
      if (!/already_exists|422/.test((err as Error).message)) throw new Error(`Could not create label ${l.name}: ${(err as Error).message}`);
      try {
        await ghApi('PATCH', `repos/${repo}/labels/${encodeURIComponent(l.name)}`, fields);
      } catch (e2) {
        throw new Error(`Could not update label ${l.name}: ${(e2 as Error).message}`);
      }
    }
  }
}

export async function commentOnIssue(repo: string, issue: number, body: string): Promise<{ id: number; url: string }> {
  const res = await ghApi<{ id: number; html_url: string }>('POST', `repos/${repo}/issues/${issue}/comments`, { body });
  return { id: res.id, url: res.html_url };
}

export async function addLabels(repo: string, issue: number, labels: string[]) {
  await ghApi('POST', `repos/${repo}/issues/${issue}/labels`, { labels });
}

export async function createPr(opts: { repo: string; head: string; base: string; title: string; body: string; cwd: string; draft?: boolean }): Promise<{ url: string; number: number }> {
  const pr = await ghApi<{ html_url: string; number: number }>(
    'POST',
    `repos/${opts.repo}/pulls`,
    { head: opts.head, base: opts.base, title: opts.title, body: opts.body, draft: !!opts.draft },
    opts.cwd,
  );
  return { url: pr.html_url, number: pr.number };
}

export interface CommentReactions {
  '+1': number;
  '-1': number;
  heart: number;
  eyes: number;
  rocket: number;
  confused: number;
}

export async function getCommentReactions(repo: string, commentId: number): Promise<CommentReactions> {
  const r = await ghJson<{ reactions: CommentReactions }>(['api', `repos/${repo}/issues/comments/${commentId}`]);
  return r.reactions;
}

export async function getIssueCommentsAfter(repo: string, issue: number, afterCommentId: number): Promise<{ id: number; author: string; body: string; createdAt: string }[]> {
  type Raw = { id: number; body: string; user: { login: string }; created_at: string };
  const raw = await ghJson<Raw[]>(['api', '--paginate', `repos/${repo}/issues/${issue}/comments?per_page=100`]);
  return raw.filter((c) => c.id > afterCommentId).map((c) => ({ id: c.id, author: c.user.login, body: c.body, createdAt: c.created_at }));
}

export function blobImageUrl(repo: string, branch: string, path: string): string {
  // Renders for anyone with repo access (works for private repos when viewed on github.com).
  return `https://github.com/${repo}/blob/${encodeURIComponent(branch)}/${path.split('/').map(encodeURIComponent).join('/')}?raw=true`;
}

/**
 * Publish files to a dedicated `peanut-gallery/assets` branch so images can be embedded in
 * issue comments regardless of which feature branch they relate to. Returns blob URLs.
 */
export async function publishAssets(opts: { repo: string; root: string; branch?: string; relDir: string; files: { name: string; path: string }[] }): Promise<Record<string, string>> {
  const { cpSync, existsSync, mkdirSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const branch = opts.branch ?? 'peanut-gallery/assets';
  const wt = join(opts.root, '.peanut-gallery', 'worktrees', '__assets');
  if (existsSync(wt)) await git(['worktree', 'remove', '--force', wt], opts.root).catch(() => rmSync(wt, { recursive: true, force: true }));
  const remoteHas = await git(['ls-remote', '--heads', 'origin', branch], opts.root).then((s) => s.length > 0).catch(() => false);
  if (remoteHas) {
    await git(['fetch', 'origin', `${branch}:${branch}`], opts.root).catch(() => {});
    await git(['worktree', 'add', wt, branch], opts.root);
  } else {
    await git(['worktree', 'add', '--detach', wt], opts.root);
    await git(['checkout', '--orphan', branch], wt);
    await git(['rm', '-rfq', '--cached', '.'], wt).catch(() => {});
    // clear the orphan checkout's files (keep .git)
    const { readdirSync } = await import('node:fs');
    for (const f of readdirSync(wt)) if (f !== '.git') rmSync(join(wt, f), { recursive: true, force: true });
  }
  const dir = join(wt, opts.relDir);
  mkdirSync(dir, { recursive: true });
  for (const f of opts.files) cpSync(f.path, join(dir, f.name));
  await git(['add', '-A'], wt);
  await git(['commit', '-q', '-m', `peanut-gallery assets: ${opts.relDir}`], wt).catch(() => {});
  await git(['push', '-u', 'origin', branch], wt);
  await git(['worktree', 'remove', '--force', wt], opts.root).catch(() => {});
  const urls: Record<string, string> = {};
  for (const f of opts.files) urls[f.name] = blobImageUrl(opts.repo, branch, `${opts.relDir}/${f.name}`);
  return urls;
}

import pc from 'picocolors';
import { LABELS } from '@peanut-gallery/core';
import { ensureWorkDir, loadConfig, workPath, writeJson } from '../config.js';
import { fetchFeedbackIssues, type FeedbackIssue } from '../github.js';
import { flatten } from '../interpret.js';

export async function pullCommand(opts: { all?: boolean; quiet?: boolean } = {}): Promise<FeedbackIssue[]> {
  const cfg = loadConfig();
  ensureWorkDir();
  const label = cfg.labels?.feedback ?? LABELS.feedback;
  const issues = await fetchFeedbackIssues(cfg.repo, label, opts.all ? 'all' : 'open');
  writeJson(workPath('feedback.json'), issues);
  if (!opts.quiet) {
    const flat = flatten(issues);
    console.log(pc.bold(`${issues.length} feedback issue(s), ${flat.length} comment(s)`) + pc.dim(` → .peanut-gallery/feedback.json`));
    for (const i of issues) {
      console.log(`\n${pc.cyan(`#${i.number}`)} ${i.title} ${pc.dim(`by ${i.session.author ?? i.author}`)}`);
      i.session.annotations.forEach((a, n) => {
        console.log(`  ${n + 1}. ${a.kind ? pc.magenta(`[${a.kind}] `) : ''}${a.text.split('\n')[0]}`);
        console.log(pc.dim(`     <${a.anchor.tag}> ${a.anchor.selector}${a.anchor.textFingerprint ? ` “${a.anchor.textFingerprint.slice(0, 40)}”` : ''} · ${pathOf(a.pageUrl)}`));
      });
    }
  }
  return issues;
}

/** Path of `url` relative to the prototype base (handles prototypes hosted under a subpath). */
export function pathOf(url: string, prototypeUrl?: string): string {
  try {
    const u = new URL(url);
    let path = u.pathname;
    if (prototypeUrl) {
      const basePath = new URL(prototypeUrl).pathname.replace(/\/+$/, '');
      if (basePath && path.startsWith(basePath)) path = path.slice(basePath.length) || '/';
    }
    return path + u.search;
  } catch {
    return url;
  }
}

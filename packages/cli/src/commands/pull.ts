import pc from 'picocolors';
import { LABELS } from '@pixelatlarge/peanut-gallery-core';
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
    // Same rules as the widget: the ?peanut switch and tracking params aren't part of the page;
    // a hash route (#/checkout) is.
    for (const key of [...u.searchParams.keys()]) {
      if (key === 'peanut' || key.startsWith('utm_') || key === 'fbclid' || key === 'gclid') u.searchParams.delete(key);
    }
    const search = u.searchParams.toString();
    return path + (search ? `?${search}` : '') + (/^#!?\//.test(u.hash) ? u.hash : '');
  } catch {
    return url;
  }
}

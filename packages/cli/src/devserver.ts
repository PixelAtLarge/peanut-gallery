import { spawn, type ChildProcess } from 'node:child_process';
import type { DevServerConfig } from './config.js';

export interface RunningServer {
  url: string;
  stop(): Promise<void>;
}

export async function startDevServer(cfg: DevServerConfig, cwd: string, port: number, log?: (s: string) => void): Promise<RunningServer> {
  const cmd = cfg.command.replace(/\{port\}/g, String(port));
  const url = (cfg.urlTemplate ?? 'http://localhost:{port}').replace(/\{port\}/g, String(port));
  log?.(`starting: ${cmd} (in ${cwd})`);
  const child: ChildProcess = spawn(cmd, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(port), BROWSER: 'none' }, detached: process.platform !== 'win32' });
  let output = '';
  child.stdout?.on('data', (d) => (output += d));
  child.stderr?.on('data', (d) => (output += d));

  const timeout = (cfg.timeoutSec ?? 90) * 1000;
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (child.exitCode !== null) throw new Error(`Dev server exited early (${child.exitCode}):\n${output.slice(-2000)}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return { url, stop: () => stop(child) };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  await stop(child);
  throw new Error(`Dev server did not respond at ${url} within ${timeout / 1000}s:\n${output.slice(-2000)}`);
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  await new Promise((r) => setTimeout(r, 500));
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
  } catch {
    /* fine */
  }
}

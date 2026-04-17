/**
 * Host command execution bridge (container side).
 * Atlas uses this to run commands on the host machine.
 *
 * Usage:
 *   import { hostExec } from './host-exec.js';
 *   const result = await hostExec('npm run build', { cwd: '/workspace/nanoclaw' });
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const PENDING_DIR = '/workspace/nanoclaw/data/host-exec/pending';
const DONE_DIR = '/workspace/nanoclaw/data/host-exec/done';
const POLL_MS = 300;
const MAX_WAIT_MS = 120_000;

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

export async function hostExec(
  command: string,
  opts: { cwd?: string; timeout?: number } = {},
): Promise<ExecResult> {
  const id = crypto.randomUUID();
  const req = { id, command, cwd: opts.cwd, timeout: opts.timeout };

  fs.mkdirSync(PENDING_DIR, { recursive: true });
  fs.writeFileSync(path.join(PENDING_DIR, `${id}.json`), JSON.stringify(req));

  const doneFile = path.join(DONE_DIR, `${id}.json`);
  const start = Date.now();

  while (Date.now() - start < MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (fs.existsSync(doneFile)) {
      const result = JSON.parse(fs.readFileSync(doneFile, 'utf-8'));
      fs.unlinkSync(doneFile);
      return result;
    }
  }

  return { stdout: '', stderr: '', exitCode: 1, error: 'Host exec timed out' };
}

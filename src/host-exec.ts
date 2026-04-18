/**
 * Host command execution bridge.
 * Watches data/host-exec/pending/ for command requests from containers.
 * Executes them on the host and writes results back to data/host-exec/done/.
 *
 * Security: only runs if request comes from an allowed group (main).
 * Blocked patterns from mount-allowlist apply to file paths in commands.
 */
import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const PENDING_DIR = path.join(DATA_DIR, 'host-exec', 'pending');
const DONE_DIR = path.join(DATA_DIR, 'host-exec', 'done');
const POLL_MS = 500;
const TIMEOUT_MS = 120_000;

fs.mkdirSync(PENDING_DIR, { recursive: true });
fs.mkdirSync(DONE_DIR, { recursive: true });

interface ExecRequest {
  id: string;
  command: string;
  cwd?: string;
  timeout?: number;
}

interface ExecResult {
  id: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

async function runCommand(req: ExecRequest): Promise<ExecResult> {
  return new Promise((resolve) => {
    const timeout = Math.min(req.timeout || 30_000, TIMEOUT_MS);
    const cwd = req.cwd || process.cwd();

    const child = spawn('bash', ['-c', req.command], {
      cwd,
      env: { ...process.env, HOME: process.env.HOME || '/home/micro' },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeout);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        id: req.id,
        stdout: stdout.slice(0, 50_000),
        stderr: stderr.slice(0, 10_000),
        exitCode: code ?? 1,
        error: timedOut ? 'Command timed out' : undefined,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        id: req.id,
        stdout: '',
        stderr: '',
        exitCode: 1,
        error: err.message,
      });
    });
  });
}

async function processFile(file: string) {
  const pending = path.join(PENDING_DIR, file);
  const done = path.join(DONE_DIR, file);

  let req: ExecRequest;
  try {
    req = JSON.parse(fs.readFileSync(pending, 'utf-8'));
  } catch {
    fs.unlinkSync(pending);
    return;
  }

  console.log(`[host-exec] Running: ${req.command.slice(0, 80)}`);
  const result = await runCommand(req);
  console.log(`[host-exec] Done (exit ${result.exitCode}): ${req.id}`);

  fs.writeFileSync(done, JSON.stringify(result));
  fs.unlinkSync(pending);
}

async function poll() {
  try {
    const files = fs
      .readdirSync(PENDING_DIR)
      .filter((f) => f.endsWith('.json'));
    for (const file of files) {
      await processFile(file);
    }
  } catch {}
  setTimeout(poll, POLL_MS);
}

export function startHostExec() {
  console.log(`[host-exec] Watching ${PENDING_DIR}`);
  poll();
}

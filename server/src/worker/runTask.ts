// R-SEC-5 / R-PARSE-1: heavy work runs in a child process with RSS and wall-time limits,
// so a malformed demo can't take down the worker or the API.
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface TaskResult<T> {
  ok: boolean;
  result?: T;
  error?: string;
  log: string;
  peakRssMb: number;
  ms: number;
}

const here = import.meta.dirname;
const isTs = import.meta.filename.endsWith('.ts');
// Bundled: dist/task.js sits next to dist/worker.js. Dev: run the TS source through tsx.
const TASK_ENTRY = isTs ? path.join(here, 'task.ts') : path.join(here, 'task.js');

function rssMb(pid: number): number {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = /VmRSS:\s+(\d+) kB/.exec(status);
    return m ? Math.round(Number(m[1]) / 1024) : 0;
  } catch {
    return 0;
  }
}

export function runTask<T>(kind: string, args: Record<string, unknown>, limits: { memoryMb: number; timeoutMs: number }): Promise<TaskResult<T>> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = fork(TASK_ENTRY, [], {
      execArgv: [...(isTs ? ['--import', 'tsx'] : []), '--expose-gc', `--max-old-space-size=${Math.max(512, Math.floor(limits.memoryMb * 0.6))}`],
      env: { ...process.env, DA_PROC: `task:${kind}` },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const logLines: string[] = [];
    const keep = (d: Buffer) => {
      for (const line of d.toString().split('\n')) {
        if (!line) continue;
        logLines.push(line);
        if (logLines.length > 400) logLines.splice(0, logLines.length - 400);
        process.stdout.write(line + '\n');
      }
    };
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);

    let peak = 0;
    let killedFor: string | null = null;
    let result: { ok: boolean; result?: T; error?: string } | null = null;
    const watch = setInterval(() => {
      if (!child.pid) return;
      const r = rssMb(child.pid);
      peak = Math.max(peak, r);
      if (r > limits.memoryMb && !killedFor) {
        killedFor = `memory limit exceeded (${r} MB > ${limits.memoryMb} MB)`;
        child.kill('SIGKILL');
      }
    }, 250);
    const timer = setTimeout(() => {
      if (!killedFor) {
        killedFor = `time limit exceeded (${Math.round(limits.timeoutMs / 1000)} s)`;
        child.kill('SIGKILL');
      }
    }, limits.timeoutMs);

    child.on('message', (m) => {
      result = m as typeof result;
    });
    child.on('spawn', () => child.send({ kind, args }));
    child.on('exit', (code, signal) => {
      clearInterval(watch);
      clearTimeout(timer);
      const base = { log: logLines.join('\n'), peakRssMb: peak, ms: Date.now() - started };
      if (killedFor) return resolve({ ok: false, error: killedFor, ...base });
      if (result) return resolve({ ...result, ...base });
      resolve({ ok: false, error: `task exited without result (code ${code}, signal ${signal})`, ...base });
    });
  });
}

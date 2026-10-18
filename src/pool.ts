import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, extname } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { checkWorkers } from './common.ts';

export interface Result {
  id: number;
  file: string;
  pid: number;
  handled?: number;
  bytes?: number;
  sha256?: string;
  error?: { code: string; message: string };
}

interface Job { id: number; file: string; done(r: Result): void }
interface Slot { child: ChildProcess; exited: Promise<void>; job?: Job }

const CLI = fileURLToPath(new URL(`./cli${extname(import.meta.url)}`, import.meta.url));
const KILL_AFTER_MS = 3000;

// Workers are separate OS processes spawned with Node's permission model: they can read only `readDirs`.
export function createPool(size: number, readDirs: string[]) {
  checkWorkers(size);
  const queue: Job[] = [];
  const pending = new Set<Promise<Result>>();
  const slots: Slot[] = [];
  let closed = false;
  let stopping = false;
  let nextId = 0;

  const dispatch = () => {
    for (const slot of slots) {
      if (slot.job || !queue.length) continue;
      slot.job = queue.shift()!;
      slot.child.stdin!.write(JSON.stringify({ id: slot.job.id, file: slot.job.file }) + '\n');
    }
  };

  const start = (slot: Slot) => {
    const allow = [dirname(CLI), ...readDirs].map((d) => `--allow-fs-read=${d}`);
    const child = spawn(process.execPath, [...process.execArgv, '--permission', ...allow, CLI, 'worker'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    slot.child = child;
    child.stdin!.on('error', () => {}); // EPIPE if the worker died; the exit handler fails its job
    createInterface({ input: child.stdout! }).on('line', (line) => {
      const job = slot.job;
      slot.job = undefined;
      job?.done({ file: job.file, ...JSON.parse(line) });
      dispatch();
    });
    slot.exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        const job = slot.job;
        slot.job = undefined;
        job?.done({ id: job.id, file: job.file, pid: child.pid!, error: { code: 'EWORKER', message: `worker exited (${signal ?? code})` } });
        if (!stopping) { start(slot); dispatch(); }
        resolve();
      });
    });
  };

  for (let i = 0; i < size; i++) {
    const slot = {} as Slot;
    slots.push(slot);
    start(slot);
  }

  return {
    run(file: string): Promise<Result> {
      if (closed) return Promise.reject(new Error('pool is closed'));
      const p = new Promise<Result>((done) => queue.push({ id: nextId++, file, done }));
      pending.add(p);
      void p.finally(() => pending.delete(p));
      dispatch();
      return p;
    },
    // Drain queued and running jobs, then EOF each worker's stdin; SIGKILL any that ignore it.
    async close() {
      closed = true;
      await Promise.all(pending);
      stopping = true;
      for (const slot of slots) slot.child.stdin!.end();
      const timer = setTimeout(() => slots.forEach((s) => s.child.kill('SIGKILL')), KILL_AFTER_MS);
      await Promise.all(slots.map((s) => s.exited));
      clearTimeout(timer);
    },
  };
}

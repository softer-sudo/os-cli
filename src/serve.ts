import { watch } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { checkWorkers, fail, log } from './common.ts';
import { createPool } from './pool.ts';

const DEBOUNCE_MS = 100;

// The config decides which directory gets read, so only its owner (or root) may be able to write it.
async function loadConfig(path: string) {
  const fh = await open(path, 'r');
  try {
    const { mode, uid } = await fh.stat();
    if (mode & 0o022) throw fail('ECONFIG', `${path} is group/world-writable (mode ${(mode & 0o777).toString(8)})`);
    if (uid !== 0 && uid !== process.getuid?.()) throw fail('ECONFIG', `${path} is owned by uid ${uid}`);
    let cfg;
    try { cfg = JSON.parse(await fh.readFile('utf8')); } catch (e: any) { throw fail('ECONFIG', `${path}: ${e.message}`); }
    if (typeof cfg.watchDir !== 'string' || !cfg.watchDir) throw fail('ECONFIG', 'config.watchDir must be a path');
    const workers = cfg.workers ?? 2;
    checkWorkers(workers);
    return { watchDir: resolve(cfg.watchDir), workers };
  } finally {
    await fh.close();
  }
}

export async function serve(configPath: string) {
  if (process.getuid?.() === 0) throw fail('EPERM', 'refusing to run as root; use a dedicated unprivileged user');
  const { watchDir, workers } = await loadConfig(configPath);

  const watcher = watch(watchDir); // throws EACCES / ENOENT right here if we can't watch it
  const pool = createPool(workers, [watchDir]);
  const timers = new Map<string, NodeJS.Timeout>();

  watcher.on('change', (_event, name) => {
    if (typeof name !== 'string') return;
    clearTimeout(timers.get(name)); // editors fire several events per save
    timers.set(name, setTimeout(async () => {
      timers.delete(name);
      const r = await pool.run(join(watchDir, name));
      log(r.error ? 'error' : 'info', r.error ? 'job failed' : 'job done', r);
    }, DEBOUNCE_MS));
  });

  log('info', 'started', { watchDir, workers, uid: process.getuid?.(), pid: process.pid });
  const failure = await new Promise<Error | undefined>((stop) => {
    watcher.on('error', stop);
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => stop(undefined));
  });

  watcher.close();
  timers.forEach(clearTimeout);
  await pool.close();
  log('info', 'stopped');
  if (failure) throw failure;
}

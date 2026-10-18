import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { type ChildProcess, spawn } from 'node:child_process';
import { chmod, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { createPool } from '../src/pool.ts';

const CLI = new URL('../src/cli.ts', import.meta.url).pathname;
const unprivileged = process.platform !== 'win32' && process.getuid?.() !== 0;
const sandbox = () => mkdtemp(join(tmpdir(), 'os-cli-'));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function startService(config: object, mode = 0o600) {
  return sandbox().then(async (dir) => {
    const cfg = join(dir, 'config.json');
    await writeFile(cfg, JSON.stringify(config), { mode });
    await chmod(cfg, mode);
    const child = spawn(process.execPath, [CLI, 'serve', '--config', cfg], { stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout });
    const next = (match: (l: any) => boolean) => new Promise<any>((resolve) => lines.on('line', (l) => { const j = JSON.parse(l); if (match(j)) resolve(j); }));
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    return { child, next, exited };
  });
}

test('queue spreads jobs over worker processes and hashes correctly', async () => {
  const dir = await sandbox();
  const files = await Promise.all([1, 2, 3, 4].map(async (n) => { const f = join(dir, `${n}.txt`); await writeFile(f, `payload ${n}`); return f; }));
  const pool = createPool(2, [dir]);
  const results = await Promise.all(files.map((f) => pool.run(f)));
  await pool.close();
  assert.deepEqual(results.map((r) => r.sha256), [1, 2, 3, 4].map((n) => createHash('sha256').update(`payload ${n}`).digest('hex')));
  const pids = new Set(results.map((r) => r.pid));
  assert.equal(pids.size, 2);
  assert.ok(!pids.has(process.pid));
  assert.ok(results.every((r) => r.handled! >= 1)); // per-process counter: memory is not shared
  assert.ok([...pids].every((pid) => !alive(pid)), 'workers must be gone after close()');
});

test('EACCES is reported per job, not thrown', { skip: !unprivileged }, async () => {
  const dir = await sandbox();
  const f = join(dir, 'locked.txt');
  await writeFile(f, 'x', { mode: 0o000 });
  const pool = createPool(1, [dir]);
  const [r, ok] = [await pool.run(f), await pool.run(join(dir, 'missing.txt'))];
  await pool.close();
  assert.equal(r.error?.code, 'EACCES');
  assert.equal(ok.error?.code, 'ENOENT');
});

test('permission model and O_NOFOLLOW stop a worker reading outside its directory', async () => {
  const [inside, outside] = [await sandbox(), await sandbox()];
  await writeFile(join(outside, 'secret'), 's');
  await symlink(join(outside, 'secret'), join(inside, 'link'));
  const pool = createPool(1, [inside]);
  const direct = await pool.run(join(outside, 'secret'));
  const viaLink = await pool.run(join(inside, 'link'));
  await pool.close();
  assert.equal(direct.error?.code, 'ERR_ACCESS_DENIED');
  assert.equal(viaLink.error?.code, 'ELOOP');
});

test('serve reacts to a change, then shuts down cleanly on SIGTERM', async () => {
  const dir = await sandbox();
  const svc = await startService({ watchDir: dir, workers: 2 });
  await svc.next((l) => l.msg === 'started');
  const done = svc.next((l) => l.msg === 'job done');
  await writeFile(join(dir, 'new.txt'), 'hello');
  const job = await done;
  assert.equal(job.sha256, createHash('sha256').update('hello').digest('hex'));
  svc.child.kill('SIGTERM');
  assert.equal(await svc.exited, 0);
  assert.ok(!alive(job.pid), 'worker must not outlive the service');
});

test('serve exits 77 when it cannot access the watch directory', { skip: !unprivileged }, async () => {
  const dir = await sandbox();
  await chmod(dir, 0o000);
  const svc = await startService({ watchDir: dir });
  assert.equal(await svc.exited, 77);
  await chmod(dir, 0o700);
});

test('serve exits 78 on a world-writable config', { skip: !unprivileged }, async () => {
  const svc = await startService({ watchDir: tmpdir() }, 0o666);
  assert.equal(await svc.exited, 78);
});

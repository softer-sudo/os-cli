#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { exitCodeFor, fail, log } from './common.ts';
import { createPool } from './pool.ts';
import { serve } from './serve.ts';
import { runWorker } from './worker.ts';

const USAGE = `os-cli -- operating-system fundamentals, hands-on

Usage:
  os-cli queue [--workers <n>] <file...>   hash files on a pool of worker processes
  os-cli serve --config <file>             watch a directory and hash what changes (run as a service)

Exit codes: 0 ok, 1 error, 64 usage, 77 permission denied, 78 bad config
`;

async function queue(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { workers: { type: 'string', default: '2' } } });
  if (!positionals.length) throw fail('EUSAGE', USAGE);
  const files = positionals.map((f) => resolve(f));
  const pool = createPool(Number(values.workers), [...new Set(files.map((f) => dirname(f)))]);
  try {
    const results = await Promise.all(files.map((f) => pool.run(f)));
    for (const r of results) console.log(JSON.stringify(r));
    const failed = results.find((r) => r.error);
    if (failed) process.exitCode = exitCodeFor(failed.error!.code);
  } finally {
    await pool.close();
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'queue') return queue(args);
  if (cmd === 'worker') return runWorker();
  if (cmd === 'serve') {
    const { values } = parseArgs({ args, options: { config: { type: 'string' } } });
    if (!values.config) throw fail('EUSAGE', USAGE);
    return serve(values.config);
  }
  throw fail('EUSAGE', USAGE);
}

main().catch((e) => {
  if (e.code === 'EUSAGE') console.error(e.message);
  else log('error', e.message, { code: e.code });
  process.exitCode = exitCodeFor(e.code);
});

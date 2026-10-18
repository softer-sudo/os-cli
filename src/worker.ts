import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';

// Lives in this process's own address space; the parent can't read or change it, only the pipe crosses.
let handled = 0;

async function sha256(file: string) {
  // Ask only for read access, and never follow a symlink planted in a watched directory.
  const fh = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const hash = createHash('sha256');
    let bytes = 0;
    // shortcut: no lock, so a concurrent writer can tear this read; the writer's next change event re-hashes
    for await (const chunk of fh.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    await fh.close();
  }
}

// One JSON job per stdin line, one JSON result per stdout line; EOF on stdin means "parent is gone, exit".
export async function runWorker() {
  for await (const line of createInterface({ input: process.stdin })) {
    const { id, file } = JSON.parse(line);
    const reply = { id, pid: process.pid, handled: ++handled };
    try {
      console.log(JSON.stringify({ ...reply, ...(await sha256(file)) }));
    } catch (e: any) {
      console.log(JSON.stringify({ ...reply, error: { code: e.code ?? 'EUNKNOWN', message: e.message } }));
    }
  }
}

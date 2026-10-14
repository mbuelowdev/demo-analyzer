import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { Readable } from 'node:stream';

export type RawKind = 'bz2' | 'zst' | 'dem';

function run(cmd: string, args: string[], out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(out);
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.stdout.pipe(ws);
    // Without this listener a write error (e.g. ENOSPC) is an unhandled 'error' event and kills the process.
    ws.on('error', (err) => {
      child.kill('SIGKILL');
      reject(err);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      ws.close(() => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.trim().slice(0, 500)}`))));
    });
  });
}

/** R-DL-4: decompress a stored raw demo to a plain .dem for the parser. */
export async function decompressDemo(src: string, kind: RawKind, dst: string) {
  if (kind === 'dem') return fs.promises.copyFile(src, dst);
  await run(kind === 'bz2' ? 'bzip2' : 'zstd', ['-dc', src], dst);
}

/** Streams a stored raw demo as a plain .dem; the decompressor is killed when the stream is closed early. */
export function decompressStream(src: string, kind: RawKind): Readable {
  if (kind === 'dem') return fs.createReadStream(src);
  const child = spawn(kind === 'bz2' ? 'bzip2' : 'zstd', ['-dc', src], { stdio: ['ignore', 'pipe', 'ignore'] });
  const out = child.stdout;
  out.on('close', () => child.kill('SIGKILL'));
  child.on('error', (err) => out.destroy(err));
  child.on('exit', (code) => code && out.destroy(new Error(`decompress exited ${code}`)));
  return out;
}

/** R-RET-3: plain uploads are stored zstd-compressed. */
export async function compressZstd(src: string, dst: string) {
  await run('zstd', ['-q', '-c', '-T2', '-10', src], dst);
}

/** Reads the first bytes of a (possibly compressed) demo without decompressing the whole file. */
export function readDemoMagic(src: string, kind: RawKind, n = 8): Promise<Buffer> {
  if (kind === 'dem') {
    const fd = fs.openSync(src, 'r');
    try {
      const b = Buffer.alloc(n);
      const read = fs.readSync(fd, b, 0, n, 0);
      return Promise.resolve(b.subarray(0, read));
    } finally {
      fs.closeSync(fd);
    }
  }
  return new Promise((resolve) => {
    const child = spawn(kind === 'bz2' ? 'bzip2' : 'zstd', ['-dc', src], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      child.kill('SIGKILL');
      resolve(buf.subarray(0, n));
    };
    child.stdout.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= n) finish();
    });
    child.on('close', finish);
    child.on('error', finish);
  });
}

export const DEMO_MAGIC = Buffer.from('PBDEMS2\0', 'latin1');

export function isCs2DemoMagic(b: Buffer): boolean {
  return b.length >= 8 && b.subarray(0, 8).equals(DEMO_MAGIC);
}

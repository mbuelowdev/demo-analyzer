// Milestone 1 parsing spike: parse the fixture demos and report time, memory and Parquet size.
// Usage: npm run spike [-- <demo.dem.bz2> ...]   (each demo runs in its own process for clean peak-RSS numbers)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decompressDemo } from './lib/compress.ts';
import { parseDemo } from './parse/parseDemo.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const outRoot = path.join(root, 'data', 'spike');

async function child(file: string) {
  const id = path.basename(file).replace(/\.dem\.bz2$/, '');
  const tmp = path.join(outRoot, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const dem = path.join(tmp, `${id}.dem`);
  let t = performance.now();
  await decompressDemo(file, 'bz2', dem);
  const decompressMs = Math.round(performance.now() - t);
  const demSize = fs.statSync(dem).size;
  t = performance.now();
  const res = await parseDemo(dem, path.join(outRoot, id), {
    tmpDir: tmp,
    tickChunk: Number(process.env.TICK_CHUNK ?? 8192),
    onProgress: (m) => console.error(`[${Math.round(process.uptime())}s rss=${Math.round(process.memoryUsage().rss / 1e6)}MB max=${Math.round(process.resourceUsage().maxRSS / 1024)}MB] ${m}`),
  });
  const parseMs = Math.round(performance.now() - t);
  fs.rmSync(dem);
  const peakRssMb = Math.round(process.resourceUsage().maxRSS / 1024);
  console.log(
    JSON.stringify({ id: id.slice(-6), bz2Size: fs.statSync(file).size, demSize, decompressMs, parseMs, peakRssMb, ...res, players: res.players.length, header: { map_name: res.header.map_name, patch_version: res.header.patch_version } }),
  );
}

async function main() {
  const files = process.argv.slice(2);
  if (process.env.SPIKE_CHILD) return child(files[0]);
  const list = files.length ? files : fs.readdirSync(path.join(root, 'fixtures', 'demos')).filter((f) => f.endsWith('.dem.bz2')).map((f) => path.join(root, 'fixtures', 'demos', f));
  if (!list.length) {
    console.log('no fixture demos found, skipping');
    return;
  }
  console.error(`cpus=${os.cpus().length} ${os.cpus()[0]?.model}`);
  for (const f of list) {
    const r = spawnSync(process.execPath, [...process.execArgv, import.meta.filename, f], { env: { ...process.env, SPIKE_CHILD: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
    process.stdout.write(r.stdout);
    if (r.status !== 0) console.error(`failed: ${f} (exit ${r.status})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

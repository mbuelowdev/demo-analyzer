// Child-process entry for heavy tasks (see runTask.ts). Receives one {kind, args} message, replies once, exits.
import fs from 'node:fs';
import path from 'node:path';
import { decompressDemo, type RawKind } from '../lib/compress.ts';
import { parseDemo } from '../parse/parseDemo.ts';
import { analyseDemo } from '../analysis/analyse.ts';

interface ParseArgs {
  rawPath: string;
  outDir: string;
  tmpDir: string;
  inputHistory: boolean;
}

interface AnalyseArgs {
  dbPath: string;
  demoId: number;
  matchDir: string;
  tmpDir: string;
}

async function runParse(a: ParseArgs) {
  const kind: RawKind = a.rawPath.endsWith('.bz2') ? 'bz2' : a.rawPath.endsWith('.zst') ? 'zst' : 'dem';
  fs.mkdirSync(a.tmpDir, { recursive: true });
  const dem = path.join(a.tmpDir, `parse-${process.pid}.dem`);
  try {
    const t = performance.now();
    await decompressDemo(a.rawPath, kind, dem);
    console.log(JSON.stringify({ msg: 'decompressed', ms: Math.round(performance.now() - t), bytes: fs.statSync(dem).size }));
    const res = await parseDemo(dem, a.outDir, {
      tmpDir: a.tmpDir,
      inputHistory: a.inputHistory,
      onProgress: (m) => console.log(JSON.stringify({ msg: 'parse', step: m, rssMb: Math.round(process.memoryUsage().rss / 1e6) })),
    });
    return res;
  } finally {
    fs.rmSync(dem, { force: true });
  }
}

process.once('message', async (msg: { kind: string; args: unknown }) => {
  try {
    let result: unknown;
    if (msg.kind === 'parse') result = await runParse(msg.args as ParseArgs);
    else if (msg.kind === 'analyse') {
      const a = msg.args as AnalyseArgs;
      result = await analyseDemo(a);
    } else throw new Error(`unknown task ${msg.kind}`);
    process.send!({ ok: true, result }, () => process.exit(0));
  } catch (err) {
    const e = err as Error;
    console.error(e.stack ?? String(e));
    process.send!({ ok: false, error: e.message || String(e) }, () => process.exit(1));
  }
});

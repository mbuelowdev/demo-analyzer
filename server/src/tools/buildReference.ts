// Builds the built-in reference distributions (src/analysis/reference.json) used to score a match when the
// user's own baseline is still too small (R-SCORE-1). Only aggregate quantiles are written: no SteamIDs, names
// or per-player rows. Usage: npm run reference -- <parsed match dir> [...]   (dirs from `npm run spike`)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { analyseDemo } from '../analysis/analyse.ts';
import { INDICATORS } from '../analysis/indicators.ts';
import { REFERENCE_QUANTILES, type ReferenceFile } from '../analysis/reference.ts';
import { metricValues } from '../analysis/score.ts';
import { openDb } from '../db/index.ts';

const MIN_REFERENCE_VALUES = 5;
const root = path.resolve(import.meta.dirname, '..', '..', '..');

async function main() {
  let dirs = process.argv.slice(2);
  if (!dirs.length) {
    const spike = path.join(root, 'data', 'spike');
    dirs = fs.existsSync(spike) ? fs.readdirSync(spike).map((d) => path.join(spike, d)).filter((d) => fs.existsSync(path.join(d, 'ticks.parquet'))) : [];
  }
  if (!dirs.length) throw new Error('no parsed match dirs; run `npm run spike` first');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'da-ref-'));
  const dbPath = path.join(tmp, 'ref.sqlite');
  const db = openDb(dbPath);
  try {
    for (const [i, dir] of dirs.entries()) {
      db.prepare(`INSERT INTO demos (id, status, created_at, updated_at) VALUES (?, 'analysing', 0, 0)`).run(i + 1);
      await analyseDemo({ dbPath, demoId: i + 1, matchDir: dir, tmpDir: tmp });
      console.error(`analysed ${i + 1}/${dirs.length}`);
    }
    const rows = new Database(dbPath).prepare('SELECT indicator, samples, metrics_json FROM indicator_results').all() as { indicator: string; samples: number; metrics_json: string }[];
    const values = new Map<string, number[]>();
    for (const r of rows) {
      const ind = INDICATORS.find((x) => x.id === r.indicator);
      if (!ind) continue;
      for (const [key, v] of metricValues(ind.score.metric, !!ind.score.stratified, JSON.parse(r.metrics_json), ind.score.minSamples, r.samples)) {
        const k = `${ind.id}:${key}`;
        if (!values.has(k)) values.set(k, []);
        values.get(k)!.push(v);
      }
    }
    const out: ReferenceFile = { generatedAt: new Date().toISOString(), matches: dirs.length, quantiles: REFERENCE_QUANTILES, metrics: {} };
    for (const [k, vs] of [...values].sort()) {
      // Too few values say nothing about a distribution; those strata fall back to 'insufficient baseline'.
      if (vs.length < MIN_REFERENCE_VALUES) continue;
      vs.sort((a, b) => a - b);
      const q = REFERENCE_QUANTILES.map((p) => {
        const pos = (vs.length - 1) * p;
        const lo = Math.floor(pos);
        const hi = Math.ceil(pos);
        return Math.round((vs[lo] + (vs[hi] - vs[lo]) * (pos - lo)) * 10000) / 10000;
      });
      out.metrics[k] = { n: vs.length, values: q };
    }
    const file = path.join(import.meta.dirname, '..', 'analysis', 'reference.json');
    fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
    console.log(`wrote ${file}: ${Object.keys(out.metrics).length} metrics from ${dirs.length} matches`);
  } finally {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Parser + analysis on a real fixture demo (gitignored; skipped when absent, e.g. in CI). Slow: ~2 min.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { analyseDemo } from '../src/analysis/analyse.ts';
import { openDb } from '../src/db/index.ts';
import { decompressDemo } from '../src/lib/compress.ts';
import { parseDemo } from '../src/parse/parseDemo.ts';

const dir = path.resolve(import.meta.dirname, '../../fixtures/demos');
const demos = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.dem.bz2')).sort() : [];
// The smallest fixture keeps the run short.
const demo = demos.map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(a).size - fs.statSync(b).size)[0];

describe.skipIf(!demo)('fixture demo pipeline', () => {
  it('parses to Parquet and analyses into stats and indicators', { timeout: 15 * 60_000 }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'da-fixture-'));
    try {
      const dem = path.join(tmp, 'x.dem');
      await decompressDemo(demo!, 'bz2', dem);
      const out = path.join(tmp, 'match');
      const res = await parseDemo(dem, out, { tmpDir: tmp });
      expect(res.header.map_name).toMatch(/^de_|^cs_/);
      expect(res.players.length).toBe(10);
      expect(res.tickRows).toBeGreaterThan(500_000);
      expect(res.missingTickProps).toEqual([]);
      for (const f of ['ticks.parquet', 'grenades.parquet', 'players.parquet', 'round_snapshots.parquet', 'events/player_death.parquet', 'header.json']) {
        expect(fs.existsSync(path.join(out, f)), f).toBe(true);
      }
      fs.rmSync(dem);

      const dbPath = path.join(tmp, 'a.sqlite');
      openDb(dbPath).prepare(`INSERT INTO demos (id, status, created_at, updated_at) VALUES (1, 'analysing', 0, 0)`).run();
      const a = await analyseDemo({ dbPath, demoId: 1, matchDir: out, tmpDir: tmp });
      expect(a.players).toBe(10);
      expect(a.rounds).toBeGreaterThanOrEqual(13);
      expect(a.engagements).toBeGreaterThan(100);
      const db = new Database(dbPath);
      const players = (db.prepare('SELECT stats_json FROM demo_players').all() as { stats_json: string }[]).map((r) => JSON.parse(r.stats_json));
      const kills = players.reduce((s, p) => s + p.kills, 0);
      const deaths = players.reduce((s, p) => s + p.deaths, 0);
      expect(kills).toBeGreaterThan(50);
      expect(deaths).toBeGreaterThanOrEqual(kills - 5);
      const summary = JSON.parse((db.prepare('SELECT data_json FROM demo_summary').get() as { data_json: string }).data_json);
      expect(summary.scoreA + summary.scoreB).toBe(a.rounds);
      expect(Math.max(summary.scoreA, summary.scoreB)).toBeGreaterThanOrEqual(13);
      expect((db.prepare('SELECT COUNT(*) AS n FROM indicator_results').get() as { n: number }).n).toBe(10 * 9);
      db.close();
      expect(fs.existsSync(path.join(out, 'engagements.parquet'))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db/index.ts';
import { scoreUser } from '../src/analysis/score.ts';

let dir: string;
let db: DB;
afterEach(() => {
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function seed(matchesPerUser: number, outlier: string) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'da-score-'));
  db = openDb(path.join(dir, 'a.sqlite'));
  for (const u of [1, 2]) db.prepare('INSERT INTO users (id, discord_id, username, created_at) VALUES (?, ?, ?, 0)').run(u, `100000${u}`, `u${u}`);
  let demo = 0;
  for (const user of [1, 2]) {
    for (let m = 0; m < matchesPerUser; m++) {
      demo++;
      db.prepare(`INSERT INTO demos (id, status, created_at, updated_at) VALUES (?, 'analysed', 0, 0)`).run(demo);
      db.prepare(`INSERT INTO matches (user_id, demo_id, source, created_at, updated_at) VALUES (?, ?, 'upload', 0, 0)`).run(user, demo);
      for (let p = 0; p < 10; p++) {
        const sid = p === 0 && user === 1 ? outlier : `7656119796026${String(demo * 100 + p).padStart(4, '0')}`;
        const isOut = sid === outlier;
        const noise = ((demo * 7 + p * 13) % 10) / 10;
        const ind = (id: string, samples: number, metrics: Record<string, number>) =>
          db.prepare('INSERT INTO indicator_results (demo_id, steam_id, indicator, version, samples, metrics_json) VALUES (?, ?, ?, 1, ?, ?)').run(demo, sid, id, samples, JSON.stringify(metrics));
        ind('ttd', 20, { median_ms: isOut ? 60 : 250 + noise * 150 });
        ind('reaction', 20, { share_under_150ms: isOut ? 0.95 : 0.2 + noise * 0.3 });
        ind('preaim', 30, { share_under_2deg: isOut ? 0.9 : 0.2 + noise * 0.2 });
        ind('obstacles', 3, { obstacle_kill_share: 1 }); // below minSamples
      }
    }
  }
}

describe('suspicion score (R-SCORE)', () => {
  it('flags an outlier against the user’s own baseline, with a breakdown', () => {
    seed(3, '76561197960265999');
    scoreUser(db, 1);
    const rows = db.prepare('SELECT s.steam_id, s.score, s.breakdown_json FROM suspicion_scores s JOIN matches m ON m.id = s.match_id WHERE m.user_id = 1').all() as { steam_id: string; score: number | null; breakdown_json: string }[];
    const out = rows.filter((r) => r.steam_id === '76561197960265999');
    const others = rows.filter((r) => r.steam_id !== '76561197960265999');
    expect(out.every((r) => r.score! > 60)).toBe(true);
    expect(Math.max(...others.map((r) => r.score ?? 0))).toBeLessThan(out[0].score!);
    const bd = JSON.parse(out[0].breakdown_json) as { indicator: string; status: string; points: number }[];
    expect(bd.find((b) => b.indicator === 'ttd')!.status).toBe('ok');
    expect(bd.find((b) => b.indicator === 'obstacles')!.status).toBe('insufficient_samples');
    expect(bd.find((b) => b.indicator === 'flick')!.status).toBe('insufficient_samples');
    expect(db.prepare('SELECT max_suspicion FROM matches WHERE user_id = 1 AND id = 1').get()).toEqual({ max_suspicion: out[0].score });
    // User 2 was not scored by user 1's run (R-PRIV-3).
    expect(db.prepare('SELECT COUNT(*) AS n FROM suspicion_scores s JOIN matches m ON m.id = s.match_id WHERE m.user_id = 2').get()).toEqual({ n: 0 });
  });

  it('says "insufficient data" with too small a baseline (R-SCORE-3)', () => {
    seed(1, '76561197960265999'); // 10 player-matches < baselineMin 20
    scoreUser(db, 1);
    const scores = db.prepare('SELECT score FROM suspicion_scores').all() as { score: number | null }[];
    expect(scores.length).toBe(10);
    expect(scores.every((s) => s.score === null)).toBe(true);
  });
});

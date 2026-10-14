import fs from 'node:fs';
import type { MatchStatus } from '../../../shared/src/modes.ts';
import { now, type DB } from '../db/index.ts';
import type { DataPaths } from './paths.ts';

export interface DemoRow {
  id: number;
  replay_key: string | null;
  replay_url: string | null;
  sha256: string | null;
  raw_path: string | null;
  raw_size: number | null;
  raw_deleted_at: number | null;
  status: MatchStatus;
  error: string | null;
  attempts: number;
  parser_version: string | null;
  schema_version: number | null;
  analysis_version: string | null;
  map: string | null;
  max_tick: number | null;
  tick_rate: number | null;
  parsed_at: number | null;
}

export function getDemo(db: DB, id: number): DemoRow | undefined {
  return db.prepare('SELECT * FROM demos WHERE id = ?').get(id) as DemoRow | undefined;
}

export function setDemoStatus(db: DB, id: number, status: MatchStatus, fields: Record<string, unknown> = {}) {
  const keys = Object.keys(fields).filter((k) => /^[a-z_0-9]+$/.test(k));
  const sets = ['status = ?', 'updated_at = ?', ...keys.map((k) => `${k} = ?`)].join(', ');
  db.prepare(`UPDATE demos SET ${sets} WHERE id = ?`).run(status, now(), ...keys.map((k) => fields[k] as never), id);
}

export function hasParsedData(paths: DataPaths, demoId: number): boolean {
  return fs.existsSync(`${paths.matchDir(demoId)}/ticks.parquet`);
}

/**
 * Removes a demo's raw file, Parquet folder and DB rows once no user links to it any more (R-PRIV-2, R-SEC-7).
 */
export function deleteDemoIfOrphan(db: DB, paths: DataPaths, demoId: number): boolean {
  const left = db.prepare('SELECT COUNT(*) AS n FROM matches WHERE demo_id = ?').get(demoId) as { n: number };
  if (left.n > 0) return false;
  const demo = getDemo(db, demoId);
  if (!demo) return false;
  if (demo.raw_path) fs.rmSync(demo.raw_path, { force: true });
  fs.rmSync(paths.matchDir(demoId), { recursive: true, force: true });
  db.transaction(() => {
    db.prepare(`DELETE FROM jobs WHERE demo_id = ? AND status != 'running'`).run(demoId);
    db.prepare('DELETE FROM demos WHERE id = ?').run(demoId);
  })();
  return true;
}

export function deleteUserMatch(db: DB, paths: DataPaths, userId: number, matchId: number): boolean {
  const m = db.prepare('SELECT demo_id FROM matches WHERE id = ? AND user_id = ?').get(matchId, userId) as { demo_id: number } | undefined;
  if (!m) return false;
  db.prepare('DELETE FROM matches WHERE id = ? AND user_id = ?').run(matchId, userId);
  deleteDemoIfOrphan(db, paths, m.demo_id);
  return true;
}

/** R-SEC-7: matches, Parquet folders, raw demos (where no one else links them) and API keys. */
export function deleteAllUserData(db: DB, paths: DataPaths, userId: number) {
  const demos = db.prepare('SELECT DISTINCT demo_id FROM matches WHERE user_id = ?').all(userId) as { demo_id: number }[];
  db.transaction(() => {
    db.prepare('DELETE FROM matches WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM api_keys WHERE user_id = ?').run(userId);
    db.prepare(`DELETE FROM jobs WHERE user_id = ? AND status != 'running'`).run(userId);
  })();
  for (const d of demos) deleteDemoIfOrphan(db, paths, d.demo_id);
}

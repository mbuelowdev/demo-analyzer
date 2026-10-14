// R-DL-2 / R-PARSE-1: job queue in SQLite, polled by the worker. No Redis, no scheduler.
import { now, type DB } from '../db/index.ts';

export type JobType = 'download' | 'parse' | 'analyse' | 'score';

export interface Job {
  id: number;
  type: JobType;
  demo_id: number | null;
  user_id: number | null;
  payload: string | null;
  status: 'pending' | 'running' | 'done' | 'failed';
  attempts: number;
  max_attempts: number;
  run_after: number;
  error: string | null;
}

export function enqueue(
  db: DB,
  type: JobType,
  opts: { demoId?: number; userId?: number; payload?: unknown; maxAttempts?: number; runAfter?: number } = {},
): number {
  // One pending job per (type, demo, user) is enough.
  const existing = db
    .prepare(`SELECT id FROM jobs WHERE type = ? AND status IN ('pending','running') AND demo_id IS ? AND user_id IS ?`)
    .get(type, opts.demoId ?? null, opts.userId ?? null) as { id: number } | undefined;
  if (existing) return existing.id;
  const t = now();
  const r = db
    .prepare('INSERT INTO jobs (type, demo_id, user_id, payload, max_attempts, run_after, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(type, opts.demoId ?? null, opts.userId ?? null, opts.payload === undefined ? null : JSON.stringify(opts.payload), opts.maxAttempts ?? 1, opts.runAfter ?? t, t, t);
  return Number(r.lastInsertRowid);
}

export function claim(db: DB, type: JobType): Job | undefined {
  const t = now();
  return db
    .prepare(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = ?, updated_at = ?
       WHERE id = (SELECT id FROM jobs WHERE status = 'pending' AND type = ? AND run_after <= ? ORDER BY run_after, id LIMIT 1)
       RETURNING *`,
    )
    .get(t, t, type, t) as Job | undefined;
}

export function complete(db: DB, id: number) {
  db.prepare(`UPDATE jobs SET status = 'done', error = NULL, updated_at = ? WHERE id = ?`).run(now(), id);
}

/** Returns true if the job was rescheduled for another attempt. */
export function fail(db: DB, job: Job, error: string, backoffMs?: number): boolean {
  const t = now();
  if (backoffMs !== undefined && job.attempts < job.max_attempts) {
    db.prepare(`UPDATE jobs SET status = 'pending', error = ?, run_after = ?, updated_at = ? WHERE id = ?`).run(error, t + backoffMs, t, job.id);
    return true;
  }
  db.prepare(`UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`).run(error, t, job.id);
  return false;
}

/** Jobs left 'running' by a crashed worker go back to pending on startup. */
export function recoverStale(db: DB) {
  db.prepare(`UPDATE jobs SET status = 'pending', updated_at = ? WHERE status = 'running'`).run(now());
}

/** Old finished jobs are pruned opportunistically (on enqueue paths) to keep the table small. */
export function pruneFinished(db: DB, olderThanMs = 14 * 24 * 3600 * 1000) {
  db.prepare(`DELETE FROM jobs WHERE status IN ('done','failed') AND updated_at < ?`).run(now() - olderThanMs);
}

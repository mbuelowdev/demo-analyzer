import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../app.ts';
import { kvGet } from '../db/index.ts';

export const HEARTBEAT_KEY = 'worker_heartbeat';
export const HEARTBEAT_STALE_MS = 60_000;

// R-DEP-7: DB access + worker heartbeat.
export async function healthRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/healthz', async (_req, reply) => {
    let dbOk = false;
    let workerAgeMs: number | null = null;
    try {
      ctx.db.prepare('SELECT 1').get();
      dbOk = true;
      const hb = kvGet(ctx.db, HEARTBEAT_KEY);
      if (hb) workerAgeMs = Date.now() - hb.updated_at;
    } catch {
      dbOk = false;
    }
    const workerOk = workerAgeMs !== null && workerAgeMs < HEARTBEAT_STALE_MS;
    return reply.code(dbOk && workerOk ? 200 : 503).send({ ok: dbOk && workerOk, db: dbOk, worker: workerOk, workerHeartbeatAgeMs: workerAgeMs });
  });
}

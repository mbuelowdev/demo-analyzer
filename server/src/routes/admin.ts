import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { isVanityMap, MAP_NAME_RE } from '../../../shared/src/maps.ts';
import { isVpkHeader } from '../../../shared/src/vpk.ts';
import type { Ctx } from '../app.ts';
import { HttpError, requireAdmin } from '../lib/http.ts';
import { isFixedAdmin, revokeAccess } from '../auth/access.ts';
import { OWNER_DISCORD_ID } from '../config.ts';
import { now } from '../db/index.ts';
import { dirSize } from '../lib/paths.ts';
import { limitStream } from '../lib/streams.ts';
import { enqueue } from '../lib/jobs.ts';
import { kvSet } from '../db/index.ts';
import { defaultScoreConfig, loadScoreConfig, SCORE_CONFIG_KEY, type ScoreConfig } from '../analysis/score.ts';
import { INDICATORS } from '../analysis/indicators.ts';

const DISCORD_ID_RE = /^\d{5,25}$/;

export async function adminRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  // ---- whitelist (R-WL-1, R-WL-2) ----
  app.get('/api/admin/whitelist', async (req) => {
    requireAdmin(req);
    const rows = db
      .prepare(
        `SELECT w.discord_id AS discordId, w.note, w.is_admin AS isAdmin, w.created_at AS createdAt, w.added_by AS addedBy,
                u.username, u.last_login_at AS lastLoginAt
         FROM whitelist w LEFT JOIN users u ON u.discord_id = w.discord_id ORDER BY w.created_at`,
      )
      .all() as Record<string, unknown>[];
    const fixed = [OWNER_DISCORD_ID, ...ctx.policy.envAdmins].filter((id, i, a) => a.indexOf(id) === i);
    const fixedRows = fixed
      .filter((id) => !rows.some((r) => r.discordId === id))
      .map((id) => {
        const u = db.prepare('SELECT username, last_login_at AS lastLoginAt FROM users WHERE discord_id = ?').get(id) as Record<string, unknown> | undefined;
        return { discordId: id, note: id === OWNER_DISCORD_ID ? 'Owner' : 'ADMIN_DISCORD_IDS', isAdmin: 1, createdAt: null, addedBy: null, ...u };
      });
    return [...fixedRows, ...rows].map((r) => ({ ...r, isAdmin: !!r.isAdmin || isFixedAdmin(ctx.policy, String(r.discordId)), fixed: isFixedAdmin(ctx.policy, String(r.discordId)) }));
  });

  app.post<{ Body: { discordId: string; note?: string; isAdmin?: boolean } }>('/api/admin/whitelist', async (req) => {
    const admin = requireAdmin(req);
    const discordId = String(req.body?.discordId ?? '').trim();
    if (!DISCORD_ID_RE.test(discordId)) throw new HttpError(400, 'invalid Discord ID');
    const note = req.body?.note ? String(req.body.note).slice(0, 200) : null;
    db.prepare(
      `INSERT INTO whitelist (discord_id, note, is_admin, added_by, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(discord_id) DO UPDATE SET note = excluded.note, is_admin = excluded.is_admin`,
    ).run(discordId, note, req.body?.isAdmin ? 1 : 0, admin.discordId, now());
    return { ok: true };
  });

  app.patch<{ Params: { id: string }; Body: { note?: string | null; isAdmin?: boolean } }>('/api/admin/whitelist/:id', async (req) => {
    requireAdmin(req);
    const id = req.params.id;
    if (isFixedAdmin(ctx.policy, id)) throw new HttpError(400, 'owner / env admins are fixed');
    const row = db.prepare('SELECT 1 FROM whitelist WHERE discord_id = ?').get(id);
    if (!row) throw new HttpError(404, 'not on whitelist');
    if (req.body?.note !== undefined) db.prepare('UPDATE whitelist SET note = ? WHERE discord_id = ?').run(req.body.note ? String(req.body.note).slice(0, 200) : null, id);
    if (req.body?.isAdmin !== undefined) db.prepare('UPDATE whitelist SET is_admin = ? WHERE discord_id = ?').run(req.body.isAdmin ? 1 : 0, id);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/admin/whitelist/:id', async (req) => {
    requireAdmin(req);
    const id = req.params.id;
    // R-WL-2: fixed admins can't be removed (no lock-out).
    if (isFixedAdmin(ctx.policy, id)) throw new HttpError(400, 'owner / env admins cannot be removed');
    const r = db.prepare('DELETE FROM whitelist WHERE discord_id = ?').run(id);
    if (!r.changes) throw new HttpError(404, 'not on whitelist');
    revokeAccess(db, id);
    return { ok: true };
  });

  // ---- maps (R-MAP-1..5) ----
  app.get('/api/admin/maps', async (req) => {
    requireAdmin(req);
    return listMaps(ctx);
  });

  app.put<{ Params: { name: string } }>(
    '/api/admin/maps/:name/file',
    { bodyLimit: ctx.config.mapUploadLimitBytes },
    async (req) => {
      const admin = requireAdmin(req);
      const name = req.params.name;
      const map = db.prepare('SELECT name FROM maps WHERE name = ?').get(name);
      if (!map || !MAP_NAME_RE.test(name) || isVanityMap(name)) throw new HttpError(400, 'unknown map; pick one from the list');
      const tmp = `${ctx.paths.mapFile(name)}.part-${Date.now()}`;
      try {
        const body = req.body as Readable;
        // The magic is checked once the stream is written; aborting mid-stream would leave the request body unread.
        const limited = limitStream(ctx.config.mapUploadLimitBytes);
        await pipeline(body, limited, fs.createWriteStream(tmp));
        const size = fs.statSync(tmp).size;
        const fd = fs.openSync(tmp, 'r');
        const head = Buffer.alloc(4);
        fs.readSync(fd, head, 0, 4, 0);
        fs.closeSync(fd);
        if (!isVpkHeader(head)) throw new HttpError(400, 'not a VPK file (bad magic)');
        fs.renameSync(tmp, ctx.paths.mapFile(name));
        db.prepare('UPDATE maps SET file_size = ?, uploaded_at = ?, uploaded_by = ?, processed_at = NULL, process_error = NULL WHERE name = ?').run(size, now(), admin.username, name);
        return { ok: true, size };
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    },
  );

  app.delete<{ Params: { name: string } }>('/api/admin/maps/:name/file', async (req) => {
    requireAdmin(req);
    const name = req.params.name;
    if (!MAP_NAME_RE.test(name)) throw new HttpError(400, 'bad map name');
    fs.rmSync(ctx.paths.mapFile(name), { force: true });
    db.prepare('UPDATE maps SET file_size = NULL, uploaded_at = NULL, uploaded_by = NULL, processed_at = NULL, process_error = NULL WHERE name = ?').run(name);
    return { ok: true };
  });

  // ---- jobs + disk (R-NFR-3). No per-user data here (R-PRIV-1): admins manage, they don't browse. ----
  app.get('/api/admin/jobs', async (req) => {
    requireAdmin(req);
    const counts = db.prepare('SELECT type, status, COUNT(*) AS n FROM jobs GROUP BY type, status').all();
    const recent = db
      .prepare('SELECT id, type, status, attempts, max_attempts AS maxAttempts, substr(error, 1, 300) AS error, run_after AS runAfter, created_at AS createdAt, updated_at AS updatedAt FROM jobs ORDER BY id DESC LIMIT 100')
      .all();
    const demos = db.prepare('SELECT status, COUNT(*) AS n FROM demos GROUP BY status').all();
    return { counts, demos, recent };
  });

  // R-SCORE-2: weights / thresholds per indicator.
  app.get('/api/admin/score-config', async (req) => {
    requireAdmin(req);
    return { config: loadScoreConfig(db), defaults: defaultScoreConfig(), indicators: INDICATORS.map((i) => ({ id: i.id, name: i.name, metric: i.score.metric, suspicious: i.score.suspicious })) };
  });

  app.put<{ Body: Partial<ScoreConfig> }>('/api/admin/score-config', async (req) => {
    requireAdmin(req);
    const b = req.body ?? {};
    const def = defaultScoreConfig();
    const clean = (o: unknown, max: number): Record<string, number> =>
      Object.fromEntries(
        Object.entries((o as Record<string, unknown>) ?? {})
          .filter(([k, v]) => k in def.weights && typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max)
          .map(([k, v]) => [k, v as number]),
      );
    const cfg: ScoreConfig = {
      weights: { ...def.weights, ...clean(b.weights, 10) },
      minSamples: { ...def.minSamples, ...clean(b.minSamples, 100000) },
      baselineMin: typeof b.baselineMin === 'number' && b.baselineMin >= 2 ? Math.floor(b.baselineMin) : def.baselineMin,
      minIndicators: typeof b.minIndicators === 'number' && b.minIndicators >= 1 ? Math.floor(b.minIndicators) : def.minIndicators,
    };
    kvSet(db, SCORE_CONFIG_KEY, JSON.stringify(cfg));
    for (const u of db.prepare('SELECT id FROM users').all() as { id: number }[]) enqueue(db, 'score', { userId: u.id });
    return { ok: true, config: cfg };
  });

  app.get('/api/admin/disk', async (req) => {
    requireAdmin(req);
    return diskUsage(ctx);
  });
}

export function listMaps(ctx: Ctx) {
  return ctx.db
    .prepare(
      `SELECT name, display_name AS displayName, pools, auto_added AS autoAdded, file_size AS fileSize, uploaded_at AS uploadedAt,
              uploaded_by AS uploadedBy, processed_at AS processedAt, process_error AS processError
       FROM maps ORDER BY auto_added, rowid`,
    )
    .all()
    .filter((m) => !isVanityMap((m as { name: string }).name))
    .map((m) => {
      const r = m as Record<string, unknown>;
      return { ...r, status: r.processedAt ? 'processed' : r.fileSize ? 'uploaded' : 'no file' };
    });
}

export function diskUsage(ctx: Ctx) {
  const p = ctx.paths;
  let free: number | null = null;
  let total: number | null = null;
  try {
    const s = fs.statfsSync(p.root);
    free = s.bavail * s.bsize;
    total = s.blocks * s.bsize;
  } catch {
    /* not supported */
  }
  const dbSize = ['', '-wal', '-shm'].reduce((a, s) => a + (fs.existsSync(p.db + s) ? fs.statSync(p.db + s).size : 0), 0);
  return {
    raw: dirSize(p.raw),
    matches: dirSize(p.matches),
    maps: dirSize(p.maps),
    tmp: dirSize(p.tmp),
    db: dbSize,
    free,
    total,
    warnBelowBytes: ctx.config.diskWarnBytes,
    warning: free !== null && free < ctx.config.diskWarnBytes,
  };
}

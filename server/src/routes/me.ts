import type { FastifyInstance } from 'fastify';
import type { MeResponse } from '../../../shared/src/api.ts';
import { isSteamId64 } from '../../../shared/src/steam.ts';
import type { Ctx } from '../app.ts';
import { HttpError, requireUser } from '../lib/http.ts';
import { avatarUrl } from '../auth/discord.ts';
import { hashToken } from '../auth/tokens.ts';
import { newApiKey } from '../auth/session.ts';
import { now } from '../db/index.ts';
import { deleteAllUserData } from '../lib/demos.ts';
import { enqueue } from '../lib/jobs.ts';

export async function meRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/me', async (req): Promise<MeResponse> => {
    const u = requireUser(req);
    return {
      id: u.id,
      discordId: u.discordId,
      username: u.username,
      avatarUrl: avatarUrl(u.discordId, u.avatar),
      isAdmin: u.isAdmin,
      steamId: u.steamId,
      csrfToken: u.csrfToken,
    };
  });

  // R-USER-1
  app.put<{ Body: { steamId: string | null } }>('/api/me/steam-id', async (req) => {
    const u = requireUser(req);
    const steamId = req.body?.steamId ?? null;
    if (steamId !== null && !isSteamId64(steamId)) throw new HttpError(400, 'not a SteamID64');
    ctx.db.prepare('UPDATE users SET steam_id = ? WHERE id = ?').run(steamId, u.id);
    // "Me" changed: personal baselines/scores must be recomputed.
    enqueue(ctx.db, 'score', { userId: u.id });
    return { ok: true, steamId };
  });

  // R-SEC-7
  app.delete('/api/me/data', async (req) => {
    const u = requireUser(req);
    deleteAllUserData(ctx.db, ctx.paths, u.id);
    return { ok: true };
  });

  // R-EXT-3: per-user extension API keys.
  app.get('/api/keys', async (req) => {
    const u = requireUser(req);
    return ctx.db
      .prepare('SELECT id, name, prefix, created_at AS createdAt, last_used_at AS lastUsedAt, revoked_at AS revokedAt FROM api_keys WHERE user_id = ? ORDER BY id DESC')
      .all(u.id);
  });

  app.post<{ Body: { name?: string } }>('/api/keys', async (req) => {
    const u = requireUser(req);
    const name = String(req.body?.name ?? '').trim().slice(0, 60) || 'Extension';
    const key = newApiKey();
    const r = ctx.db
      .prepare('INSERT INTO api_keys (user_id, name, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(u.id, name, hashToken(ctx.config.sessionSecret, key), key.slice(0, 9), now());
    // The plain key is shown exactly once.
    return { id: Number(r.lastInsertRowid), name, key };
  });

  app.delete<{ Params: { id: string } }>('/api/keys/:id', async (req) => {
    const u = requireUser(req);
    const r = ctx.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(now(), Number(req.params.id), u.id);
    if (!r.changes) throw new HttpError(404, 'key not found');
    return { ok: true };
  });
}

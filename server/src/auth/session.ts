// R-AUTH-3: server-side sessions in SQLite behind an HttpOnly cookie, 30-day sliding expiry.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { now, type DB } from '../db/index.ts';
import { accessFor, type AccessPolicy } from './access.ts';
import { hashToken, randomToken, safeEqual } from './tokens.ts';

export const SESSION_COOKIE = 'da_session';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
/** Refresh expiry at most this often, so not every request writes. */
const SLIDE_EVERY_MS = 3600 * 1000;

export interface SessionUser {
  id: number;
  discordId: string;
  username: string;
  avatar: string | null;
  steamId: string | null;
  isAdmin: boolean;
  csrfToken: string;
  sessionId: string;
}

export interface SessionDeps {
  db: DB;
  secret: string;
  secureCookies: boolean;
  policy: AccessPolicy;
}

export function cookieOptions(secure: boolean, maxAgeMs: number) {
  return { path: '/', httpOnly: true, secure, sameSite: 'lax' as const, maxAge: Math.floor(maxAgeMs / 1000) };
}

export function createSession(deps: SessionDeps, reply: FastifyReply, userId: number) {
  const token = randomToken(32);
  const t = now();
  deps.db
    .prepare('INSERT INTO sessions (id, user_id, csrf_token, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(hashToken(deps.secret, token), userId, randomToken(24), t, t, t + SESSION_TTL_MS);
  reply.setCookie(SESSION_COOKIE, token, cookieOptions(deps.secureCookies, SESSION_TTL_MS));
}

export function destroySession(deps: SessionDeps, req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[SESSION_COOKIE];
  if (token) deps.db.prepare('DELETE FROM sessions WHERE id = ?').run(hashToken(deps.secret, token));
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

interface SessionRow {
  sid: string;
  csrf_token: string;
  last_seen_at: number;
  expires_at: number;
  id: number;
  discord_id: string;
  username: string;
  avatar: string | null;
  steam_id: string | null;
}

export function loadSession(deps: SessionDeps, req: FastifyRequest, reply: FastifyReply): SessionUser | null {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const sid = hashToken(deps.secret, token);
  const row = deps.db
    .prepare(
      `SELECT s.id AS sid, s.csrf_token, s.last_seen_at, s.expires_at, u.id, u.discord_id, u.username, u.avatar, u.steam_id
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    )
    .get(sid) as SessionRow | undefined;
  const t = now();
  if (!row || row.expires_at < t) {
    if (row) deps.db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return null;
  }
  // Belt and braces for R-AUTH-4: whitelist is re-checked on every request.
  const access = accessFor(deps.db, deps.policy, row.discord_id);
  if (!access.allowed) {
    deps.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return null;
  }
  if (t - row.last_seen_at > SLIDE_EVERY_MS) {
    deps.db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(t, t + SESSION_TTL_MS, sid);
    reply.setCookie(SESSION_COOKIE, token, cookieOptions(deps.secureCookies, SESSION_TTL_MS));
  }
  return {
    id: row.id,
    discordId: row.discord_id,
    username: row.username,
    avatar: row.avatar,
    steamId: row.steam_id,
    isAdmin: access.admin,
    csrfToken: row.csrf_token,
    sessionId: sid,
  };
}

/** R-SEC-6: cookie-authenticated state-changing requests must echo the per-session CSRF token. */
export function csrfOk(req: FastifyRequest, user: SessionUser): boolean {
  const h = req.headers['x-csrf-token'];
  return typeof h === 'string' && safeEqual(h, user.csrfToken);
}

export interface ApiKeyUser {
  userId: number;
  keyId: number;
}

/** R-EXT-3 / R-SEC-2: Bearer API key, scoped to ingest endpoints. */
export function loadApiKey(deps: SessionDeps, req: FastifyRequest): ApiKeyUser | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  const key = auth.slice(7).trim();
  if (!key.startsWith('da_') || key.length < 40) return null;
  const row = deps.db
    .prepare(
      `SELECT k.id, k.user_id, u.discord_id FROM api_keys k JOIN users u ON u.id = k.user_id
       WHERE k.key_hash = ? AND k.revoked_at IS NULL`,
    )
    .get(hashToken(deps.secret, key)) as { id: number; user_id: number; discord_id: string } | undefined;
  if (!row) return null;
  if (!accessFor(deps.db, deps.policy, row.discord_id).allowed) return null;
  deps.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), row.id);
  return { userId: row.user_id, keyId: row.id };
}

export function newApiKey(): string {
  return `da_${randomToken(32)}`;
}

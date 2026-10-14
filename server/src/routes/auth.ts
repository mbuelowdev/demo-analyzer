import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../app.ts';
import { accessFor } from '../auth/access.ts';
import { createSession, destroySession } from '../auth/session.ts';
import { randomToken, safeEqual } from '../auth/tokens.ts';
import { now } from '../db/index.ts';
import { log } from '../log.ts';

const STATE_COOKIE = 'da_oauth_state';

export async function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const limit = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  app.get('/auth/discord/login', limit, async (_req, reply) => {
    const state = randomToken(24);
    reply.setCookie(STATE_COOKIE, state, { path: '/auth/discord', httpOnly: true, secure: ctx.config.secureCookies, sameSite: 'lax', maxAge: 600 });
    return reply.redirect(ctx.discord.authorizeUrl(state));
  });

  // The exact path registered in the Discord app.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/auth/discord/callback', limit, async (req, reply) => {
    const { code, state, error } = req.query;
    const expected = req.cookies[STATE_COOKIE];
    reply.clearCookie(STATE_COOKIE, { path: '/auth/discord' });
    if (error) return reply.redirect('/login?error=cancelled');
    if (!code || !state || !expected || !safeEqual(state, expected)) return reply.redirect('/login?error=state');
    let du;
    try {
      du = await ctx.discord.exchange(code);
    } catch (err) {
      log.warn('discord login failed', { err });
      return reply.redirect('/login?error=discord');
    }
    // R-AUTH-2: not whitelisted → no session, no user row.
    if (!accessFor(ctx.db, ctx.policy, du.id).allowed) {
      log.info('login rejected (not whitelisted)', { discordId: du.id });
      return reply.redirect('/login?error=not_whitelisted');
    }
    const t = now();
    const username = du.global_name || du.username;
    ctx.db
      .prepare(
        `INSERT INTO users (discord_id, username, avatar, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(discord_id) DO UPDATE SET username = excluded.username, avatar = excluded.avatar, last_login_at = excluded.last_login_at`,
      )
      .run(du.id, username, du.avatar ?? null, t, t);
    const user = ctx.db.prepare('SELECT id FROM users WHERE discord_id = ?').get(du.id) as { id: number };
    createSession(ctx.session, reply, user.id);
    log.info('login', { userId: user.id });
    return reply.redirect('/');
  });

  app.post('/auth/logout', async (req, reply) => {
    destroySession(ctx.session, req, reply);
    return { ok: true };
  });
}

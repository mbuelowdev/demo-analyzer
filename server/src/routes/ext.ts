import type { FastifyInstance } from 'fastify';
import type { IngestRequest } from '../../../shared/src/api.ts';
import type { Ctx } from '../app.ts';
import { requireApiKey, requireUser } from '../lib/http.ts';
import { ingest } from '../lib/ingest.ts';

// Ingest endpoints for the extension (R-EXT-3: API key only, R-SEC-6: rate limited).
export async function extRoutes(app: FastifyInstance, ctx: Ctx) {
  const limit = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };

  app.get('/api/ext/ping', limit, async (req) => {
    const k = requireApiKey(req);
    const u = ctx.db.prepare('SELECT username FROM users WHERE id = ?').get(k.userId) as { username: string };
    return { ok: true, username: u.username };
  });

  app.post<{ Body: IngestRequest }>('/api/ext/matches', limit, async (req) => {
    const k = requireApiKey(req);
    return ingest(ctx.db, k.userId, req.body);
  });

  // Same ingest for manual URLs pasted into the web app (session + CSRF instead of an API key).
  app.post<{ Body: IngestRequest }>('/api/ingest', limit, async (req) => {
    const u = requireUser(req);
    return ingest(ctx.db, u.id, { ...req.body, source: 'manual' });
  });
}

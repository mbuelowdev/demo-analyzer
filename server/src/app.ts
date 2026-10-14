import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { Config } from './config.ts';
import type { DB } from './db/index.ts';
import { dataPaths, ensureDataDirs, type DataPaths } from './lib/paths.ts';
import { log } from './log.ts';
import type { AccessPolicy } from './auth/access.ts';
import { discordClient, type DiscordClient } from './auth/discord.ts';
import { csrfOk, loadApiKey, loadSession, type ApiKeyUser, type SessionDeps, type SessionUser } from './auth/session.ts';

export { HttpError, requireAdmin, requireApiKey, requireUser } from './lib/http.ts';
import { HttpError, requireUser } from './lib/http.ts';
import { authRoutes } from './routes/auth.ts';
import { meRoutes } from './routes/me.ts';
import { adminRoutes } from './routes/admin.ts';
import { healthRoutes } from './routes/health.ts';
import { extRoutes } from './routes/ext.ts';
import { uploadRoutes } from './routes/upload.ts';
import { matchRoutes } from './routes/matches.ts';

export interface Ctx {
  config: Config;
  db: DB;
  paths: DataPaths;
  discord: DiscordClient;
  policy: AccessPolicy;
  session: SessionDeps;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    apiKey: ApiKeyUser | null;
  }
}

export interface BuildOptions {
  config: Config;
  db: DB;
  discord?: DiscordClient;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function buildApp(opts: BuildOptions): Promise<FastifyInstance> {
  const { config, db } = opts;
  const paths = dataPaths(config.dataDir);
  ensureDataDirs(paths);
  const policy: AccessPolicy = { envAdmins: config.adminDiscordIds };
  const ctx: Ctx = {
    config,
    db,
    paths,
    policy,
    discord:
      opts.discord ??
      discordClient({
        clientId: config.discordClientId,
        clientSecret: config.discordClientSecret,
        redirectUri: `${config.publicUrl}/auth/discord/callback`,
      }),
    session: { db, secret: config.sessionSecret, secureCookies: config.secureCookies, policy },
  };

  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  // Large uploads stream straight to disk; routes read the raw request stream.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  app.decorateRequest('user', null);
  app.decorateRequest('apiKey', null);

  app.addHook('onRequest', async (req, reply) => {
    const url = req.url;
    if (url.startsWith('/api/ext/')) {
      // R-SEC-6: the extension origin is allowed for ingest only.
      const origin = req.headers.origin;
      if (origin?.startsWith('chrome-extension://')) {
        reply.header('access-control-allow-origin', origin);
        reply.header('access-control-allow-headers', 'authorization, content-type');
        reply.header('access-control-allow-methods', 'GET, POST');
        reply.header('vary', 'origin');
      }
      if (req.method === 'OPTIONS') return reply.code(204).send();
      req.apiKey = loadApiKey(ctx.session, req);
      return;
    }
    if (url.startsWith('/api/') || url.startsWith('/auth/')) {
      req.user = loadSession(ctx.session, req, reply);
      if (req.user && !SAFE_METHODS.has(req.method) && url.startsWith('/api/') && !csrfOk(req, req.user)) {
        return reply.code(403).send({ error: 'CSRF token missing or invalid' });
      }
    }
  });

  app.addHook('onResponse', async (req, reply) => {
    if (req.url === '/healthz') return;
    log.info('http', { method: req.method, url: req.url.split('?')[0], status: reply.statusCode, ms: Math.round(reply.elapsedTime), user: req.user?.id ?? req.apiKey?.userId });
  });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    const status = err.statusCode ?? 500;
    if (status >= 500) log.error('request failed', { url: req.url, err });
    return reply.code(status).send({ error: status >= 500 ? 'internal error' : err.message });
  });

  await healthRoutes(app, ctx);
  await authRoutes(app, ctx);
  await meRoutes(app, ctx);
  await adminRoutes(app, ctx);
  await extRoutes(app, ctx);
  await uploadRoutes(app, ctx);
  await matchRoutes(app, ctx);

  app.get('/api/extension.zip', async (req, reply) => {
    requireUser(req);
    if (!fs.existsSync(config.extensionZip)) throw new HttpError(404, 'extension build not available');
    reply.header('content-disposition', 'attachment; filename="demo-analyzer-extension.zip"');
    return reply.type('application/zip').send(fs.createReadStream(config.extensionZip));
  });

  // The SPA (R-UI): static assets plus index.html for client-side routes.
  if (fs.existsSync(path.join(config.webDistDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: config.webDistDir, wildcard: false, index: false });
    const indexHtml = fs.readFileSync(path.join(config.webDistDir, 'index.html'));
    const sendIndex = (_req: FastifyRequest, reply: FastifyReply) => reply.type('text/html').header('cache-control', 'no-cache').send(indexHtml);
    app.get('/', sendIndex);
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/api/') || req.url.startsWith('/auth/')) return reply.code(404).send({ error: 'not found' });
      const file = path.join(config.webDistDir, decodeURIComponent(req.url.split('?')[0]));
      if (file.startsWith(config.webDistDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return reply.sendFile(path.relative(config.webDistDir, file), { maxAge: '365d', immutable: true });
      }
      return sendIndex(req, reply);
    });
  }

  return app;
}

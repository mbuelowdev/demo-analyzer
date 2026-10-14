import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDb, type DB } from '../src/db/index.ts';
import type { DiscordClient } from '../src/auth/discord.ts';

export const OWNER = '1012247275940085862';

export interface TestApp {
  app: FastifyInstance;
  db: DB;
  dir: string;
  close: () => Promise<void>;
}

/** App with a temp data dir and a fake Discord: the OAuth `code` is the Discord user id. */
export async function makeApp(env: Record<string, string> = {}): Promise<TestApp> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'da-test-'));
  const config = loadConfig({ DATA_DIR: dir, SESSION_SECRET: 'test-secret-test-secret', PUBLIC_URL: 'http://localhost:3000', WEB_DIST_DIR: path.join(dir, 'noweb'), ...env });
  const db = openDb(path.join(dir, 'app.sqlite'));
  const discord: DiscordClient = {
    authorizeUrl: (state) => `https://discord.test/authorize?state=${state}`,
    exchange: async (code) => ({ id: code, username: `user${code.slice(-4)}`, avatar: null }),
  };
  const app = await buildApp({ config, db, discord });
  return {
    app,
    db,
    dir,
    close: async () => {
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface Client {
  cookie: string;
  csrf: string;
  req: (method: string, url: string, body?: unknown, headers?: Record<string, string>) => Promise<LightMyRequestResponse>;
}

export function cookieHeader(res: LightMyRequestResponse, name: string): string | null {
  const c = res.cookies.find((x) => x.name === name);
  return c ? `${name}=${c.value}` : null;
}

export async function login(app: FastifyInstance, discordId: string): Promise<{ res: LightMyRequestResponse; client: Client | null }> {
  const start = await app.inject({ method: 'GET', url: '/auth/discord/login' });
  const state = new URL(start.headers.location as string).searchParams.get('state')!;
  const res = await app.inject({ method: 'GET', url: `/auth/discord/callback?code=${discordId}&state=${state}`, headers: { cookie: cookieHeader(start, 'da_oauth_state')! } });
  const cookie = cookieHeader(res, 'da_session');
  if (!cookie) return { res, client: null };
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  const csrf = me.json().csrfToken as string;
  const client: Client = {
    cookie,
    csrf,
    req: (method, url, body, headers = {}) =>
      app.inject({ method: method as 'GET', url, headers: { cookie, 'x-csrf-token': csrf, ...headers }, ...(body !== undefined ? { payload: body as object } : {}) }),
  };
  return { res, client };
}

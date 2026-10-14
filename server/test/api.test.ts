import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { login, makeApp, OWNER, type TestApp } from './helpers.ts';

const URL_A = 'http://replay100.valve.net/730/003800000000000000001_0100000001.dem.bz2';
const URL_B = 'http://replay101.valve.net/730/003800000000000000002_0100000002.dem.bz2';

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

describe('auth & whitelist (R-AUTH, R-WL)', () => {
  it('rejects non-whitelisted users without creating a session', async () => {
    const { res, client } = await login(t.app, '555555555555');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login?error=not_whitelisted');
    expect(client).toBeNull();
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 });
  });

  it('logs in the hardcoded owner as admin with a secure-ish cookie', async () => {
    const { res, client } = await login(t.app, OWNER);
    expect(res.headers.location).toBe('/');
    const set = res.cookies.find((c) => c.name === 'da_session')!;
    expect(set.httpOnly).toBe(true);
    expect(set.sameSite).toBe('Lax');
    const me = await client!.req('GET', '/api/me');
    expect(me.json()).toMatchObject({ discordId: OWNER, isAdmin: true });
  });

  it('rejects a callback with a wrong state', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/auth/discord/callback?code=${OWNER}&state=forged` });
    expect(res.headers.location).toBe('/login?error=state');
  });

  it('requires a CSRF token on cookie-authenticated writes (R-SEC-6)', async () => {
    const { client } = await login(t.app, OWNER);
    const bad = await t.app.inject({ method: 'POST', url: '/api/keys', headers: { cookie: client!.cookie }, payload: { name: 'x' } });
    expect(bad.statusCode).toBe(403);
    const ok = await client!.req('POST', '/api/keys', { name: 'x' });
    expect(ok.statusCode).toBe(200);
  });

  it('admin adds a user; removal revokes sessions and API keys immediately (R-AUTH-4)', async () => {
    const { client: owner } = await login(t.app, OWNER);
    expect((await owner!.req('POST', '/api/admin/whitelist', { discordId: '222222222222', note: 'friend' })).statusCode).toBe(200);
    const { client: friend } = await login(t.app, '222222222222');
    expect(friend).not.toBeNull();
    const key = (await friend!.req('POST', '/api/keys', { name: 'ext' })).json().key as string;
    expect((await t.app.inject({ method: 'GET', url: '/api/ext/ping', headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(200);
    // Non-admins can't use admin routes.
    expect((await friend!.req('GET', '/api/admin/whitelist')).statusCode).toBe(403);

    expect((await owner!.req('DELETE', '/api/admin/whitelist/222222222222')).statusCode).toBe(200);
    expect((await friend!.req('GET', '/api/me')).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/api/ext/ping', headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(401);
  });

  it('the owner cannot be removed (no lock-out)', async () => {
    const { client } = await login(t.app, OWNER);
    expect((await client!.req('DELETE', `/api/admin/whitelist/${OWNER}`)).statusCode).toBe(400);
  });

  it('protects every data endpoint (R-SEC-1)', async () => {
    for (const url of ['/api/me', '/api/matches', '/api/keys', '/api/admin/whitelist', '/api/stats/me', '/api/extension.zip']) {
      expect((await t.app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
    expect((await t.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(503); // no worker heartbeat in tests
  });

  it('revoked API keys stop working (R-SEC-2)', async () => {
    const { client } = await login(t.app, OWNER);
    const k = (await client!.req('POST', '/api/keys', { name: 'a' })).json();
    expect(t.db.prepare('SELECT key_hash FROM api_keys').get()).not.toMatchObject({ key_hash: k.key });
    await client!.req('DELETE', `/api/keys/${k.id}`);
    expect((await t.app.inject({ method: 'POST', url: '/api/ext/matches', headers: { authorization: `Bearer ${k.key}` }, payload: { matches: [] } })).statusCode).toBe(401);
  });
});

describe('ingest & privacy (R-DL-1, R-EXT-2, R-PRIV)', () => {
  async function setup() {
    const { client: owner } = await login(t.app, OWNER);
    await owner!.req('POST', '/api/admin/whitelist', { discordId: '333333333333' });
    const { client: other } = await login(t.app, '333333333333');
    const keyOwner = (await owner!.req('POST', '/api/keys', { name: 'k' })).json().key as string;
    const keyOther = (await other!.req('POST', '/api/keys', { name: 'k' })).json().key as string;
    const ingest = (key: string, body: unknown) => t.app.inject({ method: 'POST', url: '/api/ext/matches', headers: { authorization: `Bearer ${key}` }, payload: body as object });
    return { owner: owner!, other: other!, keyOwner, keyOther, ingest };
  }

  it('dedupes per user and validates URLs', async () => {
    const { keyOwner, ingest } = await setup();
    const body = { source: 'gcpd', mode: 'premier', ownSteamId: '76561197960265729', matches: [{ replayUrl: URL_A, mapText: 'Premier Cache', dateText: '2026-10-12 20:00:41 GMT' }, { replayUrl: URL_B }, { replayUrl: 'http://evil.example/730/1_2.dem.bz2' }] };
    const first = (await ingest(keyOwner, body)).json();
    expect(first).toMatchObject({ new: 2, known: 0, failed: 1 });
    const second = (await ingest(keyOwner, body)).json();
    expect(second).toMatchObject({ new: 0, known: 2, failed: 1 });
    expect(t.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE type = 'download'`).get()).toEqual({ n: 2 });
    // R-USER-1: SteamID detected from the GCPD page.
    expect(t.db.prepare(`SELECT steam_id FROM users WHERE discord_id = ?`).get(OWNER)).toEqual({ steam_id: '76561197960265729' });
  });

  it('retries a known match whose download failed', async () => {
    const { keyOwner, ingest } = await setup();
    await ingest(keyOwner, { source: 'manual', matches: [{ replayUrl: URL_A }] });
    t.db.prepare(`UPDATE demos SET status = 'failed'`).run();
    t.db.prepare(`UPDATE jobs SET status = 'failed'`).run();
    const r = (await ingest(keyOwner, { source: 'manual', matches: [{ replayUrl: URL_A }] })).json();
    expect(r.items[0].result).toBe('retried');
    expect(t.db.prepare(`SELECT status FROM demos`).get()).toEqual({ status: 'queued' });
  });

  it('shares the physical demo but keeps matches private per user', async () => {
    const { owner, other, keyOwner, keyOther, ingest } = await setup();
    await ingest(keyOwner, { source: 'manual', matches: [{ replayUrl: URL_A }] });
    await ingest(keyOther, { source: 'manual', matches: [{ replayUrl: URL_A }] });
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM demos').get()).toEqual({ n: 1 });
    const ownerMatches = (await owner.req('GET', '/api/matches')).json();
    const otherMatches = (await other.req('GET', '/api/matches')).json();
    expect(ownerMatches).toHaveLength(1);
    expect(otherMatches).toHaveLength(1);
    expect(ownerMatches[0].id).not.toBe(otherMatches[0].id);
    // Neither can read or act on the other's match — not even the admin owner (R-PRIV-1).
    expect((await owner.req('GET', `/api/matches/${otherMatches[0].id}`)).statusCode).toBe(404);
    expect((await other.req('DELETE', `/api/matches/${ownerMatches[0].id}`)).statusCode).toBe(404);
    expect((await other.req('POST', `/api/matches/${ownerMatches[0].id}/retry`)).statusCode).toBe(404);
    // Deleting one user's link keeps the shared demo for the other.
    expect((await owner.req('DELETE', `/api/matches/${ownerMatches[0].id}`)).statusCode).toBe(200);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM demos').get()).toEqual({ n: 1 });
    expect((await other.req('DELETE', '/api/me/data')).statusCode).toBe(200);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM demos').get()).toEqual({ n: 0 });
  });

  it('players and stats endpoints only see the requesting user’s matches', async () => {
    const { owner, other, keyOwner, ingest } = await setup();
    await ingest(keyOwner, { source: 'manual', matches: [{ replayUrl: URL_A }] });
    const demoId = (t.db.prepare('SELECT id FROM demos').get() as { id: number }).id;
    t.db.prepare(`INSERT INTO demo_players (demo_id, steam_id, name, team, team_letter, stats_json) VALUES (?, '76561197960265730', 'p', 2, 'A', '{"kills":1}')`).run(demoId);
    expect((await owner.req('GET', '/api/players/76561197960265730')).statusCode).toBe(200);
    expect((await other.req('GET', '/api/players/76561197960265730')).statusCode).toBe(404);
  });
});

describe('uploads (R-UP)', () => {
  it('rejects files that are not CS2 demos', async () => {
    const { client } = await login(t.app, OWNER);
    const res = await client!.req('PUT', '/api/uploads?name=x.dem', Buffer.from('not a demo at all'), { 'content-type': 'application/octet-stream' });
    expect(res.statusCode).toBe(400);
  });

  it('accepts a .dem with a valid header, dedupes by hash and stores it compressed', async () => {
    const { client } = await login(t.app, OWNER);
    const fake = Buffer.concat([Buffer.from('PBDEMS2\0', 'latin1'), Buffer.alloc(1000, 7)]);
    const r1 = await client!.req('PUT', '/api/uploads?name=../../etc/passwd.dem', fake, { 'content-type': 'application/octet-stream' });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().result).toBe('new');
    const raw = (t.db.prepare('SELECT raw_path FROM demos').get() as { raw_path: string }).raw_path;
    expect(raw).toMatch(/raw\/\d+\.dem\.zst$/); // generated name, never the user's (R-SEC-4)
    const r2 = await client!.req('PUT', '/api/uploads?name=again.dem', fake, { 'content-type': 'application/octet-stream' });
    expect(r2.json().result).toBe('known');
    expect(t.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE type = 'parse'`).get()).toEqual({ n: 1 });
  });
});

describe('demo download', () => {
  it('streams the stored demo unpacked under a timestamp/map/score name, only to its owner', async () => {
    const { client } = await login(t.app, OWNER);
    const fake = Buffer.concat([Buffer.from('PBDEMS2\0', 'latin1'), Buffer.alloc(5000, 9)]);
    await client!.req('PUT', '/api/uploads?name=x.dem', fake, { 'content-type': 'application/octet-stream' });
    const matchId = (t.db.prepare('SELECT id FROM matches').get() as { id: number }).id;
    t.db.prepare(`UPDATE matches SET played_at = ?, map_text = 'de_mirage', score_text = '13 : 3'`).run(Date.UTC(2026, 0, 31, 14, 1, 59));
    const res = await client!.req('GET', `/api/matches/${matchId}/demo?tz=Europe/Berlin`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="demo_20260131_150159_de_mirage_13_3.dem"');
    expect(res.rawPayload.equals(fake)).toBe(true);
    expect((await client!.req('GET', `/api/matches/${matchId}/demo?tz=Not/AZone`)).headers['content-disposition']).toContain('demo_20260131_140159_');

    await t.app.inject({ method: 'POST', url: '/api/admin/whitelist', headers: { cookie: client!.cookie, 'x-csrf-token': client!.csrf }, payload: { discordId: '333333333333' } });
    const { client: other } = await login(t.app, '333333333333');
    expect((await other!.req('GET', `/api/matches/${matchId}/demo`)).statusCode).toBe(404);

    t.db.prepare('UPDATE demos SET raw_deleted_at = 1').run();
    expect((await client!.req('GET', `/api/matches/${matchId}/demo`)).statusCode).toBe(404);
  });
});

describe('admin maps (R-MAP)', () => {
  it('validates the VPK magic and stores the file', async () => {
    const { client } = await login(t.app, OWNER);
    const bad = await client!.req('PUT', '/api/admin/maps/de_dust2/file', Buffer.from('nope'), { 'content-type': 'application/octet-stream' });
    expect(bad.statusCode).toBe(400);
    const vpk = Buffer.alloc(64);
    vpk.writeUInt32LE(0x55aa1234, 0);
    const ok = await client!.req('PUT', '/api/admin/maps/de_dust2/file', vpk, { 'content-type': 'application/octet-stream' });
    expect(ok.statusCode).toBe(200);
    const maps = (await client!.req('GET', '/api/admin/maps')).json() as { name: string; status: string }[];
    expect(maps.find((m) => m.name === 'de_dust2')!.status).toBe('uploaded');
    expect(maps.some((m) => m.name.endsWith('_vanity'))).toBe(false);
    expect((await client!.req('PUT', '/api/admin/maps/not_a_map/file', vpk, { 'content-type': 'application/octet-stream' })).statusCode).toBe(400);
  });
});

// R-DL-1 / R-EXT-2: the extension sends everything it finds; dedupe and validation happen here.
import type { IngestItemResult, IngestRequest, IngestResponse, ScrapedMatch } from '../../../shared/src/api.ts';
import { MATCH_MODES, type MatchMode } from '../../../shared/src/modes.ts';
import { parseReplayUrl } from '../../../shared/src/replay.ts';
import { isSteamId64 } from '../../../shared/src/steam.ts';
import { now, type DB } from '../db/index.ts';
import { getDemo, setDemoStatus } from './demos.ts';
import { enqueue } from './jobs.ts';

export const DOWNLOAD_MAX_ATTEMPTS = 4;
const MAX_BATCH = 500;

/** "2026-10-12 20:00:41 GMT" → epoch ms. */
export function parseGcpdDate(s: string | undefined): number | null {
  if (!s) return null;
  const m = /(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s*GMT/.exec(s);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}Z`);
  return Number.isFinite(t) ? t : null;
}

function clip(s: unknown, n: number): string | undefined {
  return typeof s === 'string' ? s.trim().slice(0, n) : undefined;
}

/** Keeps only the fields we know, bounded in size. */
function sanitize(m: ScrapedMatch): ScrapedMatch {
  return {
    replayUrl: String(m.replayUrl ?? '').trim().slice(0, 300),
    mapText: clip(m.mapText, 100),
    dateText: clip(m.dateText, 60),
    durationText: clip(m.durationText, 30),
    waitTimeText: clip(m.waitTimeText, 30),
    rankedText: clip(m.rankedText, 30),
    scoreText: clip(m.scoreText, 30),
    players: Array.isArray(m.players)
      ? m.players.slice(0, 20).map((p) => ({
          name: clip(p.name, 100) ?? '',
          steamId: isSteamId64(p.steamId) ? p.steamId : null,
          profileUrl: clip(p.profileUrl, 200) ?? null,
          ping: clip(p.ping, 10),
          kills: clip(p.kills, 10),
          assists: clip(p.assists, 10),
          deaths: clip(p.deaths, 10),
          mvps: clip(p.mvps, 10),
          hsp: clip(p.hsp, 10),
          score: clip(p.score, 10),
          team: p.team === 1 ? 1 : 0,
        }))
      : undefined,
  };
}

export function ingest(db: DB, userId: number, body: IngestRequest): IngestResponse {
  const items: IngestItemResult[] = [];
  const mode: MatchMode = MATCH_MODES.includes(body?.mode as MatchMode) ? (body.mode as MatchMode) : 'unknown';
  const source = body?.source === 'gcpd' ? 'gcpd' : 'manual';
  const matches = Array.isArray(body?.matches) ? body.matches.slice(0, MAX_BATCH) : [];

  if (isSteamId64(body?.ownSteamId)) {
    // R-USER-1: detected from the GCPD page; only fills an empty value, never overrides a manual one.
    db.prepare('UPDATE users SET steam_id = ? WHERE id = ? AND steam_id IS NULL').run(body.ownSteamId, userId);
  }

  const t = now();
  for (const raw of matches) {
    const m = sanitize(raw ?? ({} as ScrapedMatch));
    const ref = parseReplayUrl(m.replayUrl);
    if (!ref) {
      items.push({ replayUrl: m.replayUrl, result: 'failed', error: 'not a Valve CS2 replay URL' });
      continue;
    }
    const result = db.transaction((): IngestItemResult => {
      let demo = db.prepare('SELECT id FROM demos WHERE replay_key = ?').get(ref.key) as { id: number } | undefined;
      let created = false;
      if (!demo) {
        const r = db
          .prepare(`INSERT INTO demos (replay_key, replay_url, status, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?)`)
          .run(ref.key, ref.url, t, t);
        demo = { id: Number(r.lastInsertRowid) };
        enqueue(db, 'download', { demoId: demo.id, maxAttempts: DOWNLOAD_MAX_ATTEMPTS });
        created = true;
      }
      const hasScrape = !!(m.mapText || m.players?.length);
      const link = db.prepare('SELECT id, scraped_json FROM matches WHERE user_id = ? AND demo_id = ?').get(userId, demo.id) as
        | { id: number; scraped_json: string | null }
        | undefined;
      if (!link) {
        db.prepare(
          `INSERT INTO matches (user_id, demo_id, source, mode, replay_key, scraped_json, played_at, map_text, score_text, duration_text, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(userId, demo.id, source, mode, ref.key, hasScrape ? JSON.stringify(m) : null, parseGcpdDate(m.dateText), m.mapText ?? null, m.scoreText ?? null, m.durationText ?? null, t, t);
      } else if (hasScrape) {
        // Better metadata (e.g. a GCPD scrape after a manual URL) replaces what we had.
        db.prepare(
          `UPDATE matches SET scraped_json = ?, played_at = COALESCE(?, played_at), map_text = COALESCE(?, map_text), score_text = COALESCE(?, score_text),
             duration_text = COALESCE(?, duration_text), mode = CASE WHEN ? != 'unknown' THEN ? ELSE mode END, updated_at = ? WHERE id = ?`,
        ).run(JSON.stringify(m), parseGcpdDate(m.dateText), m.mapText ?? null, m.scoreText ?? null, m.durationText ?? null, mode, mode, t, link.id);
      }
      // R-DL-1: a known match whose download failed is retried.
      const d = getDemo(db, demo.id)!;
      if (!created && d.status === 'failed') {
        retryDemo(db, d.id);
        return { replayUrl: ref.url, result: 'retried' };
      }
      return { replayUrl: ref.url, result: link ? 'known' : 'new' };
    })();
    items.push(result);
  }

  return {
    new: items.filter((i) => i.result === 'new' || i.result === 'retried').length,
    known: items.filter((i) => i.result === 'known').length,
    failed: items.filter((i) => i.result === 'failed').length,
    items,
  };
}

/** Re-queues a demo from the earliest step still possible: parse if the raw file exists, else download. */
export function retryDemo(db: DB, demoId: number): 'parse' | 'download' | null {
  const d = getDemo(db, demoId);
  if (!d) return null;
  if (d.raw_path && !d.raw_deleted_at) {
    setDemoStatus(db, demoId, 'queued', { error: null });
    enqueue(db, 'parse', { demoId });
    return 'parse';
  }
  if (d.replay_url) {
    setDemoStatus(db, demoId, 'queued', { error: null, attempts: 0 });
    enqueue(db, 'download', { demoId, maxAttempts: DOWNLOAD_MAX_ATTEMPTS });
    return 'download';
  }
  return null;
}

// Match list/detail, re-processing, player view and personal trends. Every query joins through the
// requesting user's matches rows (R-PRIV-1, R-SEC-1).
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { MatchListItem, MatchScoreboard } from '../../../shared/src/api.ts';
import { MATCH_MODES } from '../../../shared/src/modes.ts';
import { isSteamId64 } from '../../../shared/src/steam.ts';
import type { Ctx } from '../app.ts';
import { INDICATORS, median } from '../analysis/indicators.ts';
import type { MatchSummary, PlayerStats } from '../analysis/stats.ts';
import { deleteUserMatch, getDemo, hasParsedData, setDemoStatus } from '../lib/demos.ts';
import { now } from '../db/index.ts';
import { decompressStream } from '../lib/compress.ts';
import { HttpError, requireUser } from '../lib/http.ts';
import { retryDemo } from '../lib/ingest.ts';
import { enqueue } from '../lib/jobs.ts';

// Stored score breakdowns keep the indicator name from scoring time; show the current one.
const parseBreakdown = (json: string) =>
  (JSON.parse(json) as { indicator: string; name: string }[]).map((c) => ({ ...c, name: INDICATORS.find((i) => i.id === c.indicator)?.name ?? c.name }));

interface ListRow {
  id: number;
  demo_id: number;
  status: MatchListItem['status'];
  mode: MatchListItem['mode'];
  map: string | null;
  played_at: number | null;
  score_text: string | null;
  duration_text: string | null;
  duration_s: number | null;
  max_suspicion: number | null;
  error: string | null;
  created_at: number;
  has_raw: number;
  keep_raw: number;
  summary_json: string | null;
  own_json: string | null;
  own_team: string | null;
}

const LIST_SQL = `
  SELECT m.id, m.demo_id, d.status, m.mode, COALESCE(d.map, m.map_text) AS map, COALESCE(m.played_at, d.parsed_at, m.created_at) AS played_at,
         m.score_text, m.duration_text, d.duration_s, m.max_suspicion, d.error, m.created_at,
         (d.raw_path IS NOT NULL AND d.raw_deleted_at IS NULL) AS has_raw, m.keep_raw,
         s.data_json AS summary_json, dp.stats_json AS own_json, dp.team_letter AS own_team
  FROM matches m
  JOIN demos d ON d.id = m.demo_id
  LEFT JOIN demo_summary s ON s.demo_id = m.demo_id
  LEFT JOIN users u ON u.id = m.user_id
  LEFT JOIN demo_players dp ON dp.demo_id = m.demo_id AND dp.steam_id = u.steam_id
  WHERE m.user_id = ?`;

function toListItem(r: ListRow): MatchListItem {
  const summary = r.summary_json ? (JSON.parse(r.summary_json) as { scoreA: number; scoreB: number }) : null;
  const own = r.own_json ? (JSON.parse(r.own_json) as { kills: number; deaths: number }) : null;
  let scoreOwn: number | null = null;
  let scoreOpp: number | null = null;
  if (summary) {
    const mine = r.own_team === 'B' ? summary.scoreB : summary.scoreA;
    const theirs = r.own_team === 'B' ? summary.scoreA : summary.scoreB;
    scoreOwn = r.own_team ? mine : null;
    scoreOpp = r.own_team ? theirs : null;
  }
  return {
    id: r.id,
    status: r.status,
    mode: r.mode,
    map: r.map,
    playedAt: r.played_at ? new Date(r.played_at).toISOString() : null,
    scoreOwn,
    scoreOpp,
    scoreText: summary ? (r.own_team ? `${scoreOwn} : ${scoreOpp}` : `${summary.scoreA} : ${summary.scoreB}`) : r.score_text,
    durationText: r.duration_text ?? (r.duration_s ? `${Math.floor(r.duration_s / 60)}:${String(Math.round(r.duration_s % 60)).padStart(2, '0')}` : null),
    ownKills: own?.kills ?? null,
    ownDeaths: own?.deaths ?? null,
    maxSuspicion: r.max_suspicion,
    error: r.error,
    createdAt: new Date(r.created_at).toISOString(),
    hasRaw: !!r.has_raw,
    keepRaw: !!r.keep_raw,
  };
}

/** `demo_20260131_150159_de_mirage_13_3.dem`: local time of `tz` (UTC if invalid), map, score (own team first when known). */
export function demoFileName(item: Pick<MatchListItem, 'playedAt' | 'map' | 'scoreText'>, tz?: string): string {
  let stamp = 'unknown';
  if (item.playedAt) {
    let zone = 'UTC';
    try {
      if (tz) zone = new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
    } catch {
      /* invalid zone: keep UTC */
    }
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(new Date(item.playedAt))
        .map((p) => [p.type, p.value]),
    );
    stamp = `${parts.year}${parts.month}${parts.day}_${parts.hour}${parts.minute}${parts.second}`;
  }
  const map = item.map && /^[a-z0-9_]+$/.test(item.map) ? item.map : 'unknown';
  const score = item.scoreText?.match(/(\d+)\D+(\d+)/);
  return `demo_${stamp}_${map}${score ? `_${score[1]}_${score[2]}` : ''}.dem`;
}

function filters(q: { mode?: string; map?: string; from?: string; to?: string }) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.mode && (MATCH_MODES as readonly string[]).includes(q.mode)) {
    where.push('m.mode = ?');
    args.push(q.mode);
  }
  if (q.map && /^[a-z0-9_]+$/.test(q.map)) {
    where.push('COALESCE(d.map, m.map_text) = ?');
    args.push(q.map);
  }
  const from = q.from ? Date.parse(q.from) : NaN;
  const to = q.to ? Date.parse(q.to) : NaN;
  if (Number.isFinite(from)) {
    where.push('COALESCE(m.played_at, d.parsed_at, m.created_at) >= ?');
    args.push(from);
  }
  if (Number.isFinite(to)) {
    where.push('COALESCE(m.played_at, d.parsed_at, m.created_at) < ?');
    args.push(to + 24 * 3600 * 1000);
  }
  return { sql: where.length ? ` AND ${where.join(' AND ')}` : '', args };
}

export async function matchRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  const ownMatch = (userId: number, id: string) => {
    const m = db.prepare('SELECT * FROM matches WHERE id = ? AND user_id = ?').get(Number(id), userId) as Record<string, unknown> | undefined;
    if (!m) throw new HttpError(404, 'match not found');
    return m as { id: number; demo_id: number; source: string; mode: string; upload_name: string | null; scraped_json: string | null; replay_key: string | null };
  };

  app.get<{ Querystring: { mode?: string; map?: string; from?: string; to?: string } }>('/api/matches', async (req) => {
    const u = requireUser(req);
    const f = filters(req.query);
    const rows = db.prepare(`${LIST_SQL}${f.sql} ORDER BY COALESCE(m.played_at, d.parsed_at, m.created_at) DESC LIMIT 2000`).all(u.id, ...f.args) as ListRow[];
    return rows.map(toListItem);
  });

  app.get('/api/matches/maps', async (req) => {
    const u = requireUser(req);
    return (db.prepare('SELECT DISTINCT COALESCE(d.map, m.map_text) AS map FROM matches m JOIN demos d ON d.id = m.demo_id WHERE m.user_id = ? AND COALESCE(d.map, m.map_text) IS NOT NULL ORDER BY 1').all(u.id) as { map: string }[]).map((r) => r.map);
  });

  // R-UI-3: live job status via polling.
  app.get('/api/matches/active', async (req) => {
    const u = requireUser(req);
    const rows = db
      .prepare(`SELECT m.id, d.status, d.error FROM matches m JOIN demos d ON d.id = m.demo_id WHERE m.user_id = ? AND d.status IN ('queued','downloading','parsing','analysing')`)
      .all(u.id) as { id: number; status: string; error: string | null }[];
    const counts = db.prepare('SELECT d.status, COUNT(*) AS n FROM matches m JOIN demos d ON d.id = m.demo_id WHERE m.user_id = ? GROUP BY d.status').all(u.id);
    return { active: rows, counts };
  });

  app.get<{ Params: { id: string } }>('/api/matches/:id', async (req) => {
    const u = requireUser(req);
    const m = ownMatch(u.id, req.params.id);
    const d = getDemo(db, m.demo_id)!;
    const demo = db.prepare('SELECT * FROM demos WHERE id = ?').get(m.demo_id) as Record<string, unknown>;
    const item = toListItem((db.prepare(`${LIST_SQL} AND m.id = ?`).get(u.id, m.id) as ListRow));
    const summary = db.prepare('SELECT data_json FROM demo_summary WHERE demo_id = ?').get(m.demo_id) as { data_json: string } | undefined;
    const players = (db.prepare('SELECT stats_json FROM demo_players WHERE demo_id = ?').all(m.demo_id) as { stats_json: string }[]).map((r) => JSON.parse(r.stats_json));
    const rounds = (db.prepare('SELECT data_json FROM demo_rounds WHERE demo_id = ? ORDER BY round').all(m.demo_id) as { data_json: string }[]).map((r) => JSON.parse(r.data_json));
    const indicatorResults = (
      db.prepare('SELECT steam_id, indicator, version, samples, metrics_json, flags_json FROM indicator_results WHERE demo_id = ?').all(m.demo_id) as {
        steam_id: string;
        indicator: string;
        version: number;
        samples: number;
        metrics_json: string;
        flags_json: string | null;
      }[]
    ).map((r) => ({ steamId: r.steam_id, indicator: r.indicator, version: r.version, samples: r.samples, metrics: JSON.parse(r.metrics_json), flags: r.flags_json ? JSON.parse(r.flags_json) : [] }));
    const scores = (
      db.prepare('SELECT steam_id, score, samples, breakdown_json, computed_at FROM suspicion_scores WHERE match_id = ?').all(m.id) as {
        steam_id: string;
        score: number | null;
        samples: number;
        breakdown_json: string;
        computed_at: number;
      }[]
    ).map((r) => ({ steamId: r.steam_id, score: r.score, samples: r.samples, breakdown: parseBreakdown(r.breakdown_json), computedAt: r.computed_at }));
    return {
      match: {
        ...item,
        source: m.source,
        uploadName: m.upload_name,
        replayKey: m.replay_key,
        scraped: m.scraped_json ? JSON.parse(m.scraped_json) : null,
        serverName: demo.server_name ?? null,
        build: demo.build ?? null,
        parserVersion: d.parser_version,
        schemaVersion: d.schema_version,
        analysisVersion: d.analysis_version,
        parseMs: demo.parse_ms ?? null,
        dataSize: demo.data_size ?? null,
        hasParsedData: hasParsedData(ctx.paths, m.demo_id),
        hasLog: !!demo.log,
      },
      ownSteamId: u.steamId,
      summary: summary ? JSON.parse(summary.data_json) : null,
      players,
      rounds,
      indicators: INDICATORS.map((i) => ({ id: i.id, version: i.version, name: i.name, description: i.description, display: i.display ?? i.score.metric, displaySecondary: i.displaySecondary ?? null, score: i.score })),
      indicatorResults,
      scores,
    };
  });

  // Simplified per-team scoreboard for the expandable row in the match list (no rounds or indicator payloads).
  app.get<{ Params: { id: string } }>('/api/matches/:id/scoreboard', async (req): Promise<MatchScoreboard> => {
    const u = requireUser(req);
    const m = ownMatch(u.id, req.params.id);
    const summary = db.prepare('SELECT data_json FROM demo_summary WHERE demo_id = ?').get(m.demo_id) as { data_json: string } | undefined;
    const sum = summary ? (JSON.parse(summary.data_json) as MatchSummary) : null;
    const scores = new Map(
      (db.prepare('SELECT steam_id, score FROM suspicion_scores WHERE match_id = ?').all(m.id) as { steam_id: string; score: number | null }[]).map((r) => [r.steam_id, r.score]),
    );
    const players = (db.prepare('SELECT stats_json FROM demo_players WHERE demo_id = ?').all(m.demo_id) as { stats_json: string }[])
      .map((r) => JSON.parse(r.stats_json) as PlayerStats)
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
      .map((p) => ({
        steamId: p.steamId,
        name: p.name,
        team: p.team,
        kills: p.kills,
        assists: p.assists,
        deaths: p.deaths,
        kd: p.kd,
        adr: p.adr,
        suspicion: scores.get(p.steamId) ?? null,
        scored: scores.has(p.steamId),
      }));
    return { scoreA: sum?.scoreA ?? null, scoreB: sum?.scoreB ?? null, players };
  });

  app.get<{ Params: { id: string } }>('/api/matches/:id/log', async (req) => {
    const u = requireUser(req);
    const m = ownMatch(u.id, req.params.id);
    const r = db.prepare('SELECT error, log FROM demos WHERE id = ?').get(m.demo_id) as { error: string | null; log: string | null };
    return r;
  });

  // R-RET: the stored raw demo, decompressed, while it is still retained. Served from our disk only.
  app.get<{ Params: { id: string }; Querystring: { tz?: string } }>('/api/matches/:id/demo', async (req, reply) => {
    const u = requireUser(req);
    const m = ownMatch(u.id, req.params.id);
    const d = getDemo(db, m.demo_id)!;
    if (!d.raw_path || d.raw_deleted_at || !fs.existsSync(d.raw_path)) throw new HttpError(404, 'raw demo no longer available');
    const item = toListItem(db.prepare(`${LIST_SQL} AND m.id = ?`).get(u.id, m.id) as ListRow);
    const kind = d.raw_path.endsWith('.bz2') ? 'bz2' : d.raw_path.endsWith('.zst') ? 'zst' : 'dem';
    reply.header('content-disposition', `attachment; filename="${demoFileName(item, req.query.tz)}"`);
    return reply.type('application/octet-stream').send(decompressStream(d.raw_path, kind));
  });

  // R-RET-4: keep the raw demo forever (or hand it back to retention).
  app.post<{ Params: { id: string }; Body: { keep?: unknown } }>('/api/matches/:id/keep', async (req) => {
    const u = requireUser(req);
    const m = ownMatch(u.id, req.params.id);
    const keep = req.body?.keep === true;
    const d = getDemo(db, m.demo_id)!;
    if (keep && (!d.raw_path || d.raw_deleted_at)) throw new HttpError(409, 'raw demo no longer available');
    db.prepare('UPDATE matches SET keep_raw = ?, updated_at = ? WHERE id = ?').run(keep ? 1 : 0, now(), m.id);
    return { ok: true, keep };
  });

  // R-PARSE-5 / R-DL-1: retry from the earliest possible step.
  app.post<{ Params: { id: string } }>('/api/matches/:id/retry', async (req) => {
    const u = requireUser(req);
    const m = ownMatch(u.id, req.params.id);
    const step = retryDemo(db, m.demo_id);
    if (!step) throw new HttpError(409, 'nothing to retry from: no raw demo and no replay URL');
    return { ok: true, step };
  });

  // R-RET-2: re-parse while the raw file exists.
  app.post<{ Params: { id: string } }>('/api/matches/:id/reparse', async (req) => {
    const u = requireUser(req);
    const m = ownMatch(u.id, req.params.id);
    const d = getDemo(db, m.demo_id)!;
    if (!d.raw_path || d.raw_deleted_at) throw new HttpError(409, 'raw demo no longer available; only re-analysis is possible');
    if (['downloading', 'parsing', 'analysing'].includes(d.status)) throw new HttpError(409, `match is busy (${d.status})`);
    setDemoStatus(db, d.id, 'queued', { error: null });
    enqueue(db, 'parse', { demoId: d.id });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/matches/:id/reanalyse', async (req) => {
    const u = requireUser(req);
    const m = ownMatch(u.id, req.params.id);
    const d = getDemo(db, m.demo_id)!;
    if (!hasParsedData(ctx.paths, d.id)) throw new HttpError(409, 'no parsed data yet');
    if (['downloading', 'parsing', 'analysing'].includes(d.status)) throw new HttpError(409, `match is busy (${d.status})`);
    setDemoStatus(db, d.id, 'analysing', { error: null });
    enqueue(db, 'analyse', { demoId: d.id });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/matches/:id', async (req) => {
    const u = requireUser(req);
    if (!deleteUserMatch(db, ctx.paths, u.id, Number(req.params.id))) throw new HttpError(404, 'match not found');
    enqueue(db, 'score', { userId: u.id });
    return { ok: true };
  });

  // R-SCORE-5: one SteamID across the user's matches.
  app.get<{ Params: { steamId: string } }>('/api/players/:steamId', async (req) => {
    const u = requireUser(req);
    const sid = req.params.steamId;
    if (!isSteamId64(sid)) throw new HttpError(400, 'not a SteamID64');
    const rows = db
      .prepare(
        `SELECT m.id AS match_id, COALESCE(m.played_at, d.parsed_at, m.created_at) AS played_at, d.map, m.mode, dp.name, dp.team_letter, dp.stats_json,
                ss.score, ss.breakdown_json, s.data_json AS summary_json
         FROM matches m JOIN demos d ON d.id = m.demo_id
         JOIN demo_players dp ON dp.demo_id = m.demo_id AND dp.steam_id = ?
         LEFT JOIN suspicion_scores ss ON ss.match_id = m.id AND ss.steam_id = ?
         LEFT JOIN demo_summary s ON s.demo_id = m.demo_id
         WHERE m.user_id = ? ORDER BY played_at`,
      )
      .all(sid, sid, u.id) as {
      match_id: number;
      played_at: number;
      map: string | null;
      mode: string;
      name: string;
      team_letter: string;
      stats_json: string;
      score: number | null;
      breakdown_json: string | null;
      summary_json: string | null;
    }[];
    if (!rows.length) throw new HttpError(404, 'player not found in your matches');
    const ind = db
      .prepare(
        `SELECT m.id AS match_id, i.indicator, i.samples, i.metrics_json FROM matches m JOIN indicator_results i ON i.demo_id = m.demo_id AND i.steam_id = ?
         WHERE m.user_id = ?`,
      )
      .all(sid, u.id) as { match_id: number; indicator: string; samples: number; metrics_json: string }[];
    const matches = rows.map((r) => {
      const st = JSON.parse(r.stats_json);
      const sum = r.summary_json ? JSON.parse(r.summary_json) : null;
      return {
        matchId: r.match_id,
        playedAt: new Date(r.played_at).toISOString(),
        map: r.map,
        mode: r.mode,
        name: r.name,
        won: sum ? (sum.winner === r.team_letter ? true : sum.winner === 'draw' ? null : false) : null,
        kills: st.kills,
        deaths: st.deaths,
        assists: st.assists,
        adr: st.adr,
        hsPercent: st.hsPercent,
        kast: st.kast,
        rating: st.rating,
        score: r.score,
        breakdown: r.breakdown_json ? parseBreakdown(r.breakdown_json) : null,
      };
    });
    // Aggregated score: sample-weighted mean of the per-match scores that have enough data.
    const scored = rows.filter((r) => r.score !== null);
    const weights = scored.map((r) => ind.filter((i) => i.match_id === r.match_id).reduce((s, i) => s + i.samples, 0) || 1);
    const aggScore = scored.length ? Math.round((scored.reduce((s, r, i) => s + r.score! * weights[i], 0) / weights.reduce((a, b) => a + b, 0)) * 10) / 10 : null;
    const trends = INDICATORS.map((def) => ({
      indicator: def.id,
      name: def.name,
      metric: def.score.metric,
      points: matches
        .map((mm) => {
          const r = ind.find((i) => i.match_id === mm.matchId && i.indicator === def.id);
          if (!r) return null;
          const metrics = JSON.parse(r.metrics_json) as Record<string, number | null>;
          const v = def.score.stratified ? (metrics[`${def.score.metric}_overall`] ?? null) : (metrics[def.score.metric] ?? null);
          return { matchId: mm.matchId, playedAt: mm.playedAt, value: v, samples: r.samples };
        })
        .filter(Boolean),
    }));
    // Counter-strafing: median of the per-match shares across this player's matches.
    const cs = ind.filter((i) => i.indicator === 'counterstrafe').map((i) => JSON.parse(i.metrics_json) as Record<string, number | null>);
    const csMedian = (k: string) => median(cs.map((m) => m[k]).filter((x): x is number => typeof x === 'number'));
    const counterStrafing = { accurateShare: csMedian('accurate_share'), counterstrafeShare: csMedian('counterstrafe_share'), stopToShotMs: csMedian('median_stop_to_shot_ms'), matches: cs.filter((m) => m.accurate_share !== null).length };
    const names = [...new Set(rows.map((r) => r.name))];
    const sum = (k: 'kills' | 'deaths' | 'assists') => matches.reduce((s, m) => s + (m[k] ?? 0), 0);
    const avg = (k: 'adr' | 'rating' | 'kast' | 'hsPercent') => {
      const v = matches.map((m) => m[k]).filter((x): x is number => typeof x === 'number');
      return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null;
    };
    return {
      steamId: sid,
      names,
      isMe: u.steamId === sid,
      matches,
      totals: { matches: matches.length, kills: sum('kills'), deaths: sum('deaths'), assists: sum('assists'), adr: avg('adr'), rating: avg('rating'), kast: avg('kast'), hsPercent: avg('hsPercent') },
      aggregatedScore: aggScore,
      scoredMatches: scored.length,
      counterStrafing,
      trends,
    };
  });

  // R-TREND: the user's own SteamID over time, filterable by map, mode, date range.
  app.get<{ Querystring: { mode?: string; map?: string; from?: string; to?: string } }>('/api/stats/me', async (req) => {
    const u = requireUser(req);
    if (!u.steamId) return { steamId: null, points: [] };
    const f = filters(req.query);
    const rows = db
      .prepare(
        `SELECT m.id AS match_id, COALESCE(m.played_at, d.parsed_at, m.created_at) AS played_at, COALESCE(d.map, m.map_text) AS map, m.mode, dp.team_letter, dp.stats_json, s.data_json AS summary_json
         FROM matches m JOIN demos d ON d.id = m.demo_id
         JOIN demo_players dp ON dp.demo_id = m.demo_id AND dp.steam_id = ?
         LEFT JOIN demo_summary s ON s.demo_id = m.demo_id
         WHERE m.user_id = ?${f.sql} ORDER BY played_at`,
      )
      .all(u.steamId, u.id, ...f.args) as { match_id: number; played_at: number; map: string; mode: string; team_letter: string; stats_json: string; summary_json: string | null }[];
    return {
      steamId: u.steamId,
      points: rows.map((r) => {
        const st = JSON.parse(r.stats_json);
        const sum = r.summary_json ? JSON.parse(r.summary_json) : null;
        return {
          matchId: r.match_id,
          playedAt: new Date(r.played_at).toISOString(),
          map: r.map,
          mode: r.mode,
          won: sum ? (sum.winner === r.team_letter ? true : sum.winner === 'draw' ? null : false) : null,
          kills: st.kills,
          deaths: st.deaths,
          assists: st.assists,
          kd: st.kd,
          adr: st.adr,
          hsPercent: st.hsPercent,
          kast: st.kast,
          rating: st.rating,
          utilityDamagePerRound: st.utility?.utilityDamagePerRound ?? null,
          enemiesFlashed: st.utility?.enemiesFlashed ?? null,
          openingKills: st.openingKills,
          openingDeaths: st.openingDeaths,
          clutchesWon: st.clutches?.won ?? 0,
        };
      }),
    };
  });
}

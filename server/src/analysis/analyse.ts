// Runs stats + engagement extraction + indicators for one parsed match and stores the results
// (SQLite for listing/UI, Parquet for research: R-CD-5). Runs in a task child process.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { isSteamId64 } from '../../../shared/src/steam.ts';
import { withDuck } from '../lib/duck.ts';
import { writeJsonRows, type ParseResult } from '../parse/parseDemo.ts';
import { extractEngagements } from './engagements.ts';
import { INDICATOR_VERSION_KEY, INDICATORS, type IndicatorContext } from './indicators.ts';
import { at, loadEvent, loadInventories, loadTicks, MatchFiles, queryRows } from './load.ts';
import { buildRounds } from './rounds.ts';
import { computeStats, inventoryTicks } from './stats.ts';
import { SpottedMaskVisibility } from './visibility.ts';

/** Bump STATS_VERSION when stats logic changes; indicator versions are part of the key (R-CD-4). */
export const STATS_VERSION = 1;
export const ANALYSIS_VERSION = `stats@${STATS_VERSION};${INDICATOR_VERSION_KEY}`;

export interface AnalyseArgs {
  dbPath: string;
  demoId: number;
  matchDir: string;
  tmpDir: string;
}

export async function analyseDemo(args: AnalyseArgs) {
  const t0 = performance.now();
  const step = (msg: string) => console.log(JSON.stringify({ msg: 'analyse', step: msg, ms: Math.round(performance.now() - t0), rssMb: Math.round(process.memoryUsage().rss / 1e6) }));
  const header = JSON.parse(fs.readFileSync(path.join(args.matchDir, 'header.json'), 'utf8')) as ParseResult;
  const files = new MatchFiles(args.matchDir);

  return withDuck(
    async (con) => {
      const ev = async (name: string) => loadEvent(con, files, name);
      const [deaths, hurts, fires, blinds, flashDet, smokeDet, smokeExpired, heDet, infernoStart, decoyStart, freezeEnd, officiallyEnded, prestart, buytimeEnded, winPanel, bulletDamage, bombExploded, bombDefused] =
        await Promise.all(
          [
            'player_death', 'player_hurt', 'weapon_fire', 'player_blind', 'flashbang_detonate', 'smokegrenade_detonate', 'smokegrenade_expired',
            'hegrenade_detonate', 'inferno_startburn', 'decoy_started', 'round_freeze_end', 'round_officially_ended', 'round_prestart',
            'buytime_ended', 'cs_win_panel_match', 'bullet_damage', 'bomb_exploded', 'bomb_defused',
          ].map(ev),
        );
      const snapshots = files.has('round_snapshots.parquet') ? await queryRows(con, `SELECT * FROM read_parquet(${files.path('round_snapshots.parquet')})`) : [];
      step('events loaded');

      const players = header.players.filter((p) => isSteamId64(p.steamid) && (p.team_number === 2 || p.team_number === 3));
      const td = await loadTicks(con, files, players.map((p) => p.steamid), header.maxTick);
      step('ticks loaded');
      const teamOfAt = (sid: string, tick: number): 2 | 3 | null => {
        const p = td.index.get(sid);
        if (p === undefined || tick > td.maxTick) return null;
        const v = td.f.team_num[at(td, p, tick)];
        return v === 2 || v === 3 ? v : null;
      };
      const rounds = buildRounds({
        freezeEnd, officiallyEnded, prestart, buytimeEnded, winPanel, snapshots, bombExploded, bombDefused, deaths, teamOfAt,
        maxTick: header.maxTick, tickRate: header.tickRate,
      });
      const inventories = await loadInventories(con, files, inventoryTicks(rounds, deaths));

      const stats = computeStats({ td, rounds, players, deaths, hurts, fires, blinds, flashDet, smokeDet, heDet, infernoStart, decoyStart, snapshots, inventories, map: header.header.map_name ?? null });
      step('stats');

      const vis = new SpottedMaskVisibility(td);
      const engagements = extractEngagements({ td, rounds, vis, fires, hurts, deaths, smokes: smokeDet, smokeExpired });
      step(`engagements: ${engagements.length}`);

      const ictx: IndicatorContext = { td, rounds, vis, engagements, fires, hurts, deaths, bulletDamage, players: stats.players.map((p) => p.steamId) };
      const indicatorResults = INDICATORS.map((ind) => {
        const t = performance.now();
        const res = ind.compute(ictx);
        step(`indicator ${ind.id} ${Math.round(performance.now() - t)} ms`);
        return { ind, res };
      });

      // ---- Parquet for research (R-CD-5) ----
      const engRows = engagements.map(({ errors: _e, attackerIdx: _a, victimIdx: _v, ...rest }) => ({ ...rest, ttd_ms: rest.firstDamageTick !== null ? ((rest.firstDamageTick - rest.startTick) * 1000) / 64 : null }));
      await writeJsonRows(con, engRows, path.join(args.matchDir, 'engagements.parquet'), args.tmpDir);
      const engTicks: { engagement_id: number; tick: number; aim_error_deg: number | null }[] = [];
      for (const e of engagements) e.errors.forEach((err, i) => engTicks.push({ engagement_id: e.id, tick: e.startTick + i, aim_error_deg: Number.isFinite(err) ? Math.round(err * 1000) / 1000 : null }));
      await writeJsonRows(con, engTicks, path.join(args.matchDir, 'engagement_ticks.parquet'), args.tmpDir);
      const indRows = indicatorResults.flatMap(({ ind, res }) =>
        [...res].flatMap(([sid, r]) => Object.entries(r.metrics).map(([metric, value]) => ({ indicator: ind.id, version: ind.version, steamid: sid, samples: r.samples, metric, value }))),
      );
      await writeJsonRows(con, indRows, path.join(args.matchDir, 'indicators.parquet'), args.tmpDir);
      step('parquet written');

      // ---- SQLite ----
      const db = new Database(args.dbPath);
      db.pragma('busy_timeout = 10000');
      try {
        db.transaction(() => {
          for (const t of ['demo_players', 'demo_rounds', 'demo_summary', 'indicator_results']) db.prepare(`DELETE FROM ${t} WHERE demo_id = ?`).run(args.demoId);
          const insP = db.prepare('INSERT INTO demo_players (demo_id, steam_id, name, team, team_letter, crosshair_code, rank, stats_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
          for (const p of stats.players) insP.run(args.demoId, p.steamId, p.name, p.startSide, p.team, p.crosshairCode, p.rank, JSON.stringify(p));
          const insR = db.prepare('INSERT INTO demo_rounds (demo_id, round, data_json) VALUES (?, ?, ?)');
          for (const r of stats.rounds) insR.run(args.demoId, r.round, JSON.stringify(r));
          db.prepare('INSERT INTO demo_summary (demo_id, data_json) VALUES (?, ?)').run(args.demoId, JSON.stringify({ ...stats.summary, engagements: engagements.length, visibility: vis.id }));
          const insI = db.prepare('INSERT INTO indicator_results (demo_id, steam_id, indicator, version, samples, metrics_json, flags_json) VALUES (?, ?, ?, ?, ?, ?, ?)');
          for (const { ind, res } of indicatorResults) {
            for (const [sid, r] of res) insI.run(args.demoId, sid, ind.id, ind.version, r.samples, JSON.stringify(r.metrics), r.flags?.length ? JSON.stringify(r.flags) : null);
          }
        })();
      } finally {
        db.close();
      }
      step('done');
      return { players: stats.players.length, rounds: rounds.length, engagements: engagements.length };
    },
    { memoryLimit: '512MB', threads: 2, tempDir: args.tmpDir },
  );
}

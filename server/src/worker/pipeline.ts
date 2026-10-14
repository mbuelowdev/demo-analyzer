import fs from 'node:fs';
import { MAP_NAME_RE } from '../../../shared/src/maps.ts';
import { now } from '../db/index.ts';
import { getDemo, hasParsedData, setDemoStatus } from '../lib/demos.ts';
import { complete, enqueue, fail, type Job } from '../lib/jobs.ts';
import { log } from '../log.ts';
import type { ParseResult } from '../parse/parseDemo.ts';
import { ANALYSIS_VERSION } from '../analysis/analyse.ts';
import type { WorkerCtx } from './main.ts';
import { runTask } from './runTask.ts';

const LOG_LIMIT = 20_000;

export async function runParse(ctx: WorkerCtx, job: Job) {
  const demo = job.demo_id ? getDemo(ctx.db, job.demo_id) : undefined;
  if (!demo) return complete(ctx.db, job.id);
  if (!demo.raw_path || demo.raw_deleted_at || !fs.existsSync(demo.raw_path)) {
    if (demo.replay_url && demo.status !== 'expired') {
      enqueue(ctx.db, 'download', { demoId: demo.id, maxAttempts: 4 });
      return complete(ctx.db, job.id);
    }
    setDemoStatus(ctx.db, demo.id, 'failed', { error: 'raw demo no longer available' });
    return fail(ctx.db, job, 'raw demo missing');
  }
  setDemoStatus(ctx.db, demo.id, 'parsing', { error: null });
  const outDir = ctx.paths.matchDir(demo.id);
  const r = await runTask<ParseResult>(
    'parse',
    { rawPath: demo.raw_path, outDir, tmpDir: ctx.paths.tmp, inputHistory: ctx.config.parseInputHistory },
    { memoryMb: ctx.config.parseMemoryLimitMb, timeoutMs: ctx.config.parseTimeoutMs },
  );
  if (!getDemo(ctx.db, demo.id)) {
    // Deleted by its last owner while parsing.
    fs.rmSync(outDir, { recursive: true, force: true });
    return complete(ctx.db, job.id);
  }
  if (!r.ok || !r.result) {
    // R-PARSE-5: the error and log are stored on the match; the user can retry.
    setDemoStatus(ctx.db, demo.id, 'failed', { error: `parse failed: ${r.error}`, log: r.log.slice(-LOG_LIMIT) });
    fail(ctx.db, job, r.error ?? 'parse failed');
    log.warn('parse failed', { demoId: demo.id, error: r.error });
    return;
  }
  const res = r.result;
  const map = res.header.map_name ?? null;
  ctx.db.transaction(() => {
    setDemoStatus(ctx.db, demo.id, 'analysing', {
      parser_version: res.parserVersion,
      schema_version: res.schemaVersion,
      map,
      server_name: res.header.server_name ?? null,
      build: res.header.patch_version ?? null,
      tick_rate: res.tickRate,
      duration_s: res.durationS,
      max_tick: res.maxTick,
      header_json: JSON.stringify(res.header),
      parse_ms: r.ms,
      parse_peak_rss_mb: r.peakRssMb,
      data_size: res.sizes.total ?? null,
      parsed_at: now(),
      error: null,
      log: r.log.slice(-LOG_LIMIT),
    });
    // R-MAP-1: maps seen in demos are added automatically.
    if (map && MAP_NAME_RE.test(map)) {
      ctx.db.prepare('INSERT OR IGNORE INTO maps (name, display_name, pools, auto_added) VALUES (?, ?, ?, 1)').run(map, map, 'seen in demo');
    }
    enqueue(ctx.db, 'analyse', { demoId: demo.id });
    complete(ctx.db, job.id);
  })();
  log.info('parsed', { demoId: demo.id, ms: r.ms, peakRssMb: r.peakRssMb, bytes: res.sizes.total });
}

export async function runAnalyse(ctx: WorkerCtx, job: Job) {
  const demo = job.demo_id ? getDemo(ctx.db, job.demo_id) : undefined;
  if (!demo) return complete(ctx.db, job.id);
  if (!hasParsedData(ctx.paths, demo.id)) {
    setDemoStatus(ctx.db, demo.id, 'failed', { error: 'no parsed data to analyse' });
    return fail(ctx.db, job, 'no parsed data');
  }
  setDemoStatus(ctx.db, demo.id, 'analysing');
  const r = await runTask<{ players: number }>(
    'analyse',
    { dbPath: ctx.paths.db, demoId: demo.id, matchDir: ctx.paths.matchDir(demo.id), tmpDir: ctx.paths.tmp },
    { memoryMb: ctx.config.parseMemoryLimitMb, timeoutMs: ctx.config.parseTimeoutMs },
  );
  if (!getDemo(ctx.db, demo.id)) return complete(ctx.db, job.id);
  if (!r.ok) {
    setDemoStatus(ctx.db, demo.id, 'failed', { error: `analysis failed: ${r.error}`, log: r.log.slice(-LOG_LIMIT) });
    fail(ctx.db, job, r.error ?? 'analysis failed');
    log.warn('analysis failed', { demoId: demo.id, error: r.error });
    return;
  }
  ctx.db.transaction(() => {
    setDemoStatus(ctx.db, demo.id, 'analysed', { analysis_version: ANALYSIS_VERSION, analysed_at: now(), error: null });
    const users = ctx.db.prepare('SELECT DISTINCT user_id FROM matches WHERE demo_id = ?').all(demo.id) as { user_id: number }[];
    for (const u of users) enqueue(ctx.db, 'score', { userId: u.user_id });
    complete(ctx.db, job.id);
  })();
  log.info('analysed', { demoId: demo.id, ms: r.ms });
}

/** R-CD-4: an indicator/stat version bump re-analyses every match whose Parquet data exists. */
export function queueOutdatedAnalyses(ctx: WorkerCtx) {
  const rows = ctx.db
    .prepare(`SELECT id FROM demos WHERE status = 'analysed' AND (analysis_version IS NULL OR analysis_version != ?)`)
    .all(ANALYSIS_VERSION) as { id: number }[];
  for (const r of rows) if (hasParsedData(ctx.paths, r.id)) enqueue(ctx.db, 'analyse', { demoId: r.id });
  if (rows.length) log.info('queued re-analysis after version change', { count: rows.length, version: ANALYSIS_VERSION });
}

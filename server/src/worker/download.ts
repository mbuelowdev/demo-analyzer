import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { REPLAY_URL_RE } from '../../../shared/src/replay.ts';
import { now } from '../db/index.ts';
import { isCs2DemoMagic, readDemoMagic } from '../lib/compress.ts';
import { getDemo, setDemoStatus } from '../lib/demos.ts';
import { complete, enqueue, fail, type Job } from '../lib/jobs.ts';
import { limitStream } from '../lib/streams.ts';
import { log } from '../log.ts';
import type { WorkerCtx } from './main.ts';

class PermanentError extends Error {}

/**
 * R-RET-1: raw demos older than DEMO_RETENTION_DAYS are deleted only when a new download starts.
 * Only finished demos lose their raw file; queued/parsing ones keep it, and so do demos any user keeps (R-RET-4).
 */
export function retentionCleanup(ctx: WorkerCtx) {
  const cutoff = now() - ctx.config.demoRetentionDays * 24 * 3600 * 1000;
  const old = ctx.db
    .prepare(
      `SELECT id, raw_path FROM demos WHERE raw_path IS NOT NULL AND raw_deleted_at IS NULL AND raw_downloaded_at < ?
       AND status IN ('analysed', 'failed', 'expired')
       AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.demo_id = demos.id AND m.keep_raw = 1)`,
    )
    .all(cutoff) as { id: number; raw_path: string }[];
  for (const d of old) {
    fs.rmSync(d.raw_path, { force: true });
    ctx.db.prepare('UPDATE demos SET raw_deleted_at = ? WHERE id = ?').run(now(), d.id);
  }
  if (old.length) log.info('retention cleanup', { deleted: old.length });
}

/** 30 s, 2 min, 8 min … */
export const backoffMs = (attempt: number) => 30_000 * 4 ** Math.max(0, attempt - 1);

export async function runDownload(ctx: WorkerCtx, job: Job) {
  const demo = job.demo_id ? getDemo(ctx.db, job.demo_id) : undefined;
  if (!demo) return complete(ctx.db, job.id);
  const url = demo.replay_url ?? '';
  try {
    // R-SEC-3: SSRF guard. Only Valve replay URLs, no redirects, size-limited.
    if (!REPLAY_URL_RE.test(url)) throw new PermanentError('refusing to download a non-replay URL');
    retentionCleanup(ctx);
    setDemoStatus(ctx.db, demo.id, 'downloading', { attempts: job.attempts });

    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60 * 60 * 1000) });
    if (res.status === 404 || res.status === 410) {
      // R-DL-3: expired replays keep their scraped metadata.
      setDemoStatus(ctx.db, demo.id, 'expired', { error: `replay no longer available (HTTP ${res.status})` });
      return complete(ctx.db, job.id);
    }
    if (res.status >= 300 && res.status < 400) throw new PermanentError(`unexpected redirect (HTTP ${res.status})`);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > ctx.config.replayDownloadLimitBytes) throw new PermanentError(`replay too large (${len} bytes)`);

    // R-DL-4: streamed to disk, never buffered.
    const final = ctx.paths.rawFile(demo.id, 'bz2');
    const part = `${final}.part`;
    try {
      await pipeline(Readable.fromWeb(res.body as never), limitStream(ctx.config.replayDownloadLimitBytes), fs.createWriteStream(part));
      const head = Buffer.alloc(3);
      const fd = fs.openSync(part, 'r');
      fs.readSync(fd, head, 0, 3, 0);
      fs.closeSync(fd);
      if (head.toString('latin1') !== 'BZh') throw new PermanentError('download is not a bzip2 file');
      if (!isCs2DemoMagic(await readDemoMagic(part, 'bz2'))) throw new PermanentError('download is not a CS2 demo');
      fs.renameSync(part, final);
    } finally {
      fs.rmSync(part, { force: true });
    }
    const size = fs.statSync(final).size;
    ctx.db.transaction(() => {
      setDemoStatus(ctx.db, demo.id, 'queued', { raw_path: final, raw_size: size, raw_downloaded_at: now(), raw_deleted_at: null, error: null });
      enqueue(ctx.db, 'parse', { demoId: demo.id });
      complete(ctx.db, job.id);
    })();
    log.info('downloaded', { demoId: demo.id, bytes: size });
  } catch (err) {
    const msg = (err as Error).message || String(err);
    const retry = !(err instanceof PermanentError);
    const rescheduled = fail(ctx.db, job, msg, retry ? backoffMs(job.attempts) : undefined);
    setDemoStatus(ctx.db, demo.id, rescheduled ? 'queued' : 'failed', { error: rescheduled ? `download attempt ${job.attempts} failed: ${msg} (retrying)` : `download failed: ${msg}` });
    log.warn('download failed', { demoId: demo.id, attempt: job.attempts, rescheduled, error: msg });
  }
}

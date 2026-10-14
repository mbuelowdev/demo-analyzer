import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../app.ts';
import { now } from '../db/index.ts';
import { compressZstd, isCs2DemoMagic, readDemoMagic, type RawKind } from '../lib/compress.ts';
import { HttpError, requireUser } from '../lib/http.ts';
import { enqueue } from '../lib/jobs.ts';
import { limitStream } from '../lib/streams.ts';

/** Sniffs the container from magic bytes; the user's file name is only a display label (R-SEC-4). */
export function sniffKind(head: Buffer): RawKind | null {
  if (head.length >= 3 && head.subarray(0, 3).toString('latin1') === 'BZh') return 'bz2';
  if (head.length >= 4 && head.readUInt32LE(0) === 0xfd2fb528) return 'zst';
  if (head.length >= 7 && head.subarray(0, 7).toString('latin1') === 'PBDEMS2') return 'dem';
  return null;
}

// R-UP-1 / R-UP-2: raw-body streaming upload (XHR gives the browser a progress bar).
export async function uploadRoutes(app: FastifyInstance, ctx: Ctx) {
  app.put<{ Querystring: { name?: string } }>('/api/uploads', { bodyLimit: ctx.config.uploadLimitBytes }, async (req) => {
    const user = requireUser(req);
    const displayName = String(req.query.name ?? 'upload').slice(0, 200);
    const tmp = path.join(ctx.paths.tmp, `upload-${crypto.randomUUID()}`);
    const hash = crypto.createHash('sha256');
    let head = Buffer.alloc(0);
    try {
      const limited = limitStream(ctx.config.uploadLimitBytes, (chunk) => {
        hash.update(chunk);
        if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16)]);
      });
      await pipeline(req.body as Readable, limited, fs.createWriteStream(tmp));
      const kind = sniffKind(head);
      if (!kind) throw new HttpError(400, 'unsupported file: expected .dem, .dem.bz2 or .dem.zst');
      if (!isCs2DemoMagic(await readDemoMagic(tmp, kind))) throw new HttpError(400, 'not a CS2 demo (missing PBDEMS2 header)');
      const sha256 = hash.digest('hex');
      const t = now();

      const existing = ctx.db.prepare('SELECT id FROM demos WHERE sha256 = ?').get(sha256) as { id: number } | undefined;
      if (existing) {
        const link = ctx.db.prepare('SELECT id FROM matches WHERE user_id = ? AND demo_id = ?').get(user.id, existing.id) as { id: number } | undefined;
        if (link) return { result: 'known', matchId: link.id };
        const r = ctx.db
          .prepare(`INSERT INTO matches (user_id, demo_id, source, upload_name, created_at, updated_at) VALUES (?, ?, 'upload', ?, ?, ?)`)
          .run(user.id, existing.id, displayName, t, t);
        enqueue(ctx.db, 'score', { userId: user.id });
        return { result: 'new', matchId: Number(r.lastInsertRowid) };
      }

      const demoId = Number(
        ctx.db.prepare(`INSERT INTO demos (sha256, status, created_at, updated_at) VALUES (?, 'queued', ?, ?)`).run(sha256, t, t).lastInsertRowid,
      );
      // R-RET-3: keep raw demos compressed.
      const storedKind = kind === 'dem' ? 'zst' : kind;
      const rawPath = ctx.paths.rawFile(demoId, storedKind);
      if (kind === 'dem') await compressZstd(tmp, rawPath);
      else fs.renameSync(tmp, rawPath);
      const size = fs.statSync(rawPath).size;
      const matchId = ctx.db.transaction(() => {
        ctx.db.prepare('UPDATE demos SET raw_path = ?, raw_size = ?, raw_downloaded_at = ? WHERE id = ?').run(rawPath, size, t, demoId);
        const r = ctx.db
          .prepare(`INSERT INTO matches (user_id, demo_id, source, upload_name, created_at, updated_at) VALUES (?, ?, 'upload', ?, ?, ?)`)
          .run(user.id, demoId, displayName, t, t);
        enqueue(ctx.db, 'parse', { demoId });
        return Number(r.lastInsertRowid);
      })();
      return { result: 'new', matchId };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
}

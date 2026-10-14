import { Transform } from 'node:stream';
import { HttpError } from './http.ts';

/** Passes data through, failing once more than `max` bytes have flowed; `onChunk` can inspect/throw. */
export function limitStream(max: number, onChunk?: (chunk: Buffer, total: number) => void): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > max) return cb(new HttpError(413, `file larger than ${max} bytes`));
      try {
        onChunk?.(chunk, total);
      } catch (e) {
        return cb(e as Error);
      }
      cb(null, chunk);
    },
  });
}

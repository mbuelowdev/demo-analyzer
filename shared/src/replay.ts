// R-SEC-3 / R-DL-1: the only URLs the worker may fetch, and the match identity derived from them.
export const REPLAY_URL_RE = /^https?:\/\/replay(\d+)\.valve\.net\/730\/(\d+)_(\d+)\.dem\.bz2$/;

export interface ReplayRef {
  url: string;
  matchId: string;
  outcomeId: string;
  /** `<matchId>_<outcomeId>`, the per-user dedupe key. */
  key: string;
}

export function parseReplayUrl(input: string): ReplayRef | null {
  const url = input.trim();
  const m = REPLAY_URL_RE.exec(url);
  if (!m) return null;
  return { url, matchId: m[2], outcomeId: m[3], key: `${m[2]}_${m[3]}` };
}

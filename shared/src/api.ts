import type { MatchMode, MatchStatus } from './modes.ts';

// ---- Extension ingest (R-EXT, R-DL-1) ----

export interface ScrapedPlayer {
  name: string;
  /** SteamID64 derived from data-miniprofile, or null if not found. */
  steamId: string | null;
  profileUrl: string | null;
  /** Scoreboard cells as shown (ping, K, A, D, ★, HSP, score). Raw strings; the API normalises. */
  ping?: string;
  kills?: string;
  assists?: string;
  deaths?: string;
  mvps?: string;
  hsp?: string;
  score?: string;
  /** 0 = first team listed, 1 = second team listed. */
  team: 0 | 1;
}

export interface ScrapedMatch {
  replayUrl: string;
  /** e.g. "Premier Cache" */
  mapText?: string;
  /** e.g. "2026-10-12 20:00:41 GMT" */
  dateText?: string;
  durationText?: string;
  waitTimeText?: string;
  rankedText?: string;
  /** e.g. "13 : 7" (first listed team : second listed team) */
  scoreText?: string;
  players?: ScrapedPlayer[];
}

export interface IngestRequest {
  source: 'gcpd' | 'manual';
  mode?: MatchMode;
  /** The logged-in Steam user's SteamID64, if the page exposes it (R-USER-1). */
  ownSteamId?: string | null;
  matches: ScrapedMatch[];
}

export interface IngestItemResult {
  replayUrl: string;
  result: 'new' | 'known' | 'retried' | 'failed';
  error?: string;
}

export interface IngestResponse {
  new: number;
  known: number;
  failed: number;
  items: IngestItemResult[];
}

// ---- Web app ----

export interface MeResponse {
  id: number;
  discordId: string;
  username: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  steamId: string | null;
  csrfToken: string;
}

export interface MatchListItem {
  id: number;
  status: MatchStatus;
  mode: MatchMode;
  map: string | null;
  playedAt: string | null;
  scoreOwn: number | null;
  scoreOpp: number | null;
  scoreText: string | null;
  durationText: string | null;
  ownKills: number | null;
  ownDeaths: number | null;
  maxSuspicion: number | null;
  error: string | null;
  createdAt: string;
  hasRaw: boolean;
  /** R-RET-4: this user keeps the raw demo; retention cleanup skips it. */
  keepRaw: boolean;
}

export interface ScoreboardPlayer {
  steamId: string;
  name: string;
  team: 'A' | 'B';
  kills: number;
  assists: number;
  deaths: number;
  kd: number | null;
  adr: number | null;
  /** Suspicion score 0–100; null with `scored` = insufficient data, without = not scored yet. */
  suspicion: number | null;
  scored: boolean;
}

/** GET /api/matches/:id/scoreboard: the simplified scoreboard for the expandable match-list row. */
export interface MatchScoreboard {
  scoreA: number | null;
  scoreB: number | null;
  /** Sorted by rating, best first; empty until the demo is analysed. */
  players: ScoreboardPlayer[];
}

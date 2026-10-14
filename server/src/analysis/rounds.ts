// Round boundaries for MM GOTV demos, which have no round_end event (see docs/SPIKE.md).
import type { Row } from './load.ts';

export interface Round {
  round: number;
  /** Exclusive lower bound: events with start < tick <= end belong to this round. */
  start: number;
  freezeEnd: number;
  buyEnd: number;
  end: number;
  /** 2 = T, 3 = CT, null if unknown. */
  winnerSide: 2 | 3 | null;
  winReason: number | null;
  /** team_rounds_total per side after this round. */
  scoreT: number | null;
  scoreCT: number | null;
}

export const WIN_REASONS: Record<number, string> = {
  1: 'Bomb exploded',
  4: 'Terrorists escaped',
  7: 'Bomb defused',
  8: 'CTs eliminated Ts',
  9: 'Ts eliminated CTs',
  10: 'Draw',
  11: 'Hostages rescued',
  12: 'Time ran out',
  13: 'Hostages not rescued',
  17: 'Ts surrendered',
  18: 'CTs surrendered',
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function buildRounds(ev: {
  freezeEnd: Row[];
  officiallyEnded: Row[];
  prestart: Row[];
  buytimeEnded: Row[];
  winPanel: Row[];
  snapshots: Row[];
  /** Fallback winner inference when no game-rules snapshot covers a round. */
  bombExploded?: Row[];
  bombDefused?: Row[];
  deaths?: Row[];
  teamOfAt?: (steamId: string, tick: number) => 2 | 3 | null;
  maxTick: number;
  tickRate: number;
}): Round[] {
  const live = (r: Row) => r.is_warmup_period !== true;
  // Latest freeze-end per round number (a restart repeats it).
  const freezeByRound = new Map<number, number>();
  for (const e of ev.freezeEnd.filter(live)) {
    const r = (num(e.total_rounds_played) ?? 0) + 1;
    freezeByRound.set(r, Math.max(freezeByRound.get(r) ?? 0, e.tick as number));
  }
  const endByRound = new Map<number, number>();
  for (const e of ev.officiallyEnded) {
    const r = num(e.total_rounds_played);
    if (r === null || r < 1) continue;
    const t = e.tick as number;
    if (!endByRound.has(r) || t < endByRound.get(r)!) endByRound.set(r, t);
  }
  const lastSnapshotRound = Math.max(0, ...ev.snapshots.map((s) => num(s.total_rounds_played) ?? 0));
  const winPanelTick = ev.winPanel.length ? (ev.winPanel[0].tick as number) : null;
  const winPanelRounds = ev.winPanel.length ? (num(ev.winPanel[0].total_rounds_played) ?? 0) : 0;
  const total = Math.max(lastSnapshotRound, winPanelRounds, ...endByRound.keys(), 0);
  if (total === 0) {
    // Unknown structure (e.g. unusual modes): one pseudo-round spanning the demo so stats still work.
    return [{ round: 1, start: 0, freezeEnd: 0, buyEnd: 0, end: ev.maxTick, winnerSide: null, winReason: null, scoreT: null, scoreCT: null }];
  }

  const rounds: Round[] = [];
  let prevEnd = 0;
  for (let r = 1; r <= total; r++) {
    const end = endByRound.get(r) ?? (r === total ? (winPanelTick ?? ev.maxTick) : ev.maxTick);
    const freezeEnd = freezeByRound.get(r) ?? prevEnd;
    let start = prevEnd;
    if (r === 1) {
      const pre = ev.prestart.filter((e) => (e.tick as number) <= freezeEnd).map((e) => e.tick as number);
      start = pre.length ? Math.max(...pre) - 1 : Math.max(0, freezeEnd - 20 * ev.tickRate);
    }
    const buyEnds = ev.buytimeEnded.map((e) => e.tick as number).filter((t) => t > freezeEnd && t <= end);
    const buyEnd = buyEnds.length ? Math.min(...buyEnds) : Math.min(end, freezeEnd + 20 * ev.tickRate);
    // Game-rules snapshot just before the end (sampled at end - 1 by the parser; last round at maxTick - 64).
    const snap = ev.snapshots.filter((s) => num(s.total_rounds_played) === r && (s.tick as number) <= end);
    const lastTick = snap.length ? Math.max(...snap.map((s) => s.tick as number)) : null;
    const atEnd = snap.filter((s) => s.tick === lastTick);
    const ws = num(atEnd[0]?.round_win_status);
    const t = atEnd.find((s) => s.team_num === 2);
    const ct = atEnd.find((s) => s.team_num === 3);
    rounds.push({
      round: r,
      start,
      freezeEnd,
      buyEnd,
      end,
      winnerSide: ws === 2 || ws === 3 ? ws : null,
      winReason: num(atEnd[0]?.round_win_reason),
      scoreT: num(t?.team_rounds_total),
      scoreCT: num(ct?.team_rounds_total),
    });
    prevEnd = end;
  }
  // Fill winners from score deltas where the status was missing, then from round events.
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    if (r.winnerSide !== null) continue;
    const prev = rounds[i - 1];
    const pt = prev?.scoreT ?? 0;
    const pc = prev?.scoreCT ?? 0;
    if (r.scoreT !== null && r.scoreT > pt) r.winnerSide = 2;
    else if (r.scoreCT !== null && r.scoreCT > pc) r.winnerSide = 3;
    else inferWinner(r, ev);
  }
  return rounds;
}

/** Round number for a tick, or null outside live rounds. */
export function roundOf(rounds: Round[], tick: number): Round | null {
  let lo = 0;
  let hi = rounds.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = rounds[mid];
    if (tick <= r.start) hi = mid - 1;
    else if (tick > r.end) lo = mid + 1;
    else return r;
  }
  return null;
}

/** Bomb exploded → T, defused → CT, otherwise the side that lost all players loses; else time ran out (CT). */
function inferWinner(r: Round, ev: Parameters<typeof buildRounds>[0]) {
  const inR = (rows: Row[] | undefined) => (rows ?? []).filter((e) => (e.tick as number) > r.start && (e.tick as number) <= r.end);
  if (inR(ev.bombExploded).length) {
    r.winnerSide = 2;
    r.winReason = 1;
    return;
  }
  if (inR(ev.bombDefused).length) {
    r.winnerSide = 3;
    r.winReason = 7;
    return;
  }
  if (!ev.deaths || !ev.teamOfAt) return;
  const alive = new Map<2 | 3, Set<string>>([[2, new Set()], [3, new Set()]]);
  const deadSides = new Map<2 | 3, Set<string>>([[2, new Set()], [3, new Set()]]);
  for (const d of inR(ev.deaths)) {
    const sid = String(d.user_steamid);
    const side = ev.teamOfAt(sid, d.tick as number);
    if (side) deadSides.get(side)!.add(sid);
  }
  const at = Math.max(r.freezeEnd, r.start + 1);
  for (const s of ev.snapshots.length ? new Set(ev.snapshots.map((x) => String(x.steamid))) : []) {
    const side = ev.teamOfAt(s, at);
    if (side) alive.get(side)!.add(s);
  }
  const tDead = alive.get(2)!.size > 0 && [...alive.get(2)!].every((s) => deadSides.get(2)!.has(s));
  const ctDead = alive.get(3)!.size > 0 && [...alive.get(3)!].every((s) => deadSides.get(3)!.has(s));
  if (tDead && !ctDead) {
    r.winnerSide = 3;
    r.winReason = 8;
  } else if (ctDead && !tDead) {
    r.winnerSide = 2;
    r.winReason = 9;
  } else if (!tDead && !ctDead) {
    r.winnerSide = 3;
    r.winReason = 12;
  }
}

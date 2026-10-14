// R-CD-1: engagement dataset. An engagement is a window from the tick the victim becomes visible to the
// attacker until a kill, a loss of visibility, or a timeout.
import { aimError, distanceBand, dist, eyePos, headPos, pointSegmentDistance, speed2d, TICK_RATE, weaponClass, type Vec3 } from './geometry.ts';
import { at, type Row, type TickData } from './load.ts';
import { roundOf, type Round } from './rounds.ts';
import type { VisibilityModel } from './visibility.ts';

export const ENGAGEMENT_TIMEOUT_TICKS = 3 * TICK_RATE;
/** Short visibility flickers (spotted mask updates aren't per tick) are merged. */
const GAP_MERGE_TICKS = 6;
/** Ignore visibility that starts within this many ticks after an earlier window ended (same peek). */
const REENGAGE_COOLDOWN_TICKS = TICK_RATE / 2;
const SMOKE_RADIUS = 144;
const SMOKE_LIFETIME_TICKS = 22 * TICK_RATE;

export interface Engagement {
  id: number;
  round: number;
  attacker: string;
  victim: string;
  attackerIdx: number;
  victimIdx: number;
  startTick: number;
  endTick: number;
  firstShotTick: number | null;
  firstDamageTick: number | null;
  killTick: number | null;
  outcome: 'kill' | 'damage' | 'miss' | 'no_shot';
  weapon: string | null;
  weaponClass: string;
  distance: number;
  distanceBand: string;
  attackerSpeed: number;
  attackerFlashed: boolean;
  smoked: boolean;
  /** Angular distance crosshair → victim head at start (degrees). */
  startError: number | null;
  /** Same, with recoil (2 × aim punch) applied. */
  startErrorRecoil: number | null;
  /** Per-tick angular error from start to end (degrees, NaN where unknown). */
  errors: Float32Array;
}

export interface EngagementInput {
  td: TickData;
  rounds: Round[];
  vis: VisibilityModel;
  fires: Row[];
  hurts: Row[];
  deaths: Row[];
  smokes: Row[];
  smokeExpired: Row[];
}

export function extractEngagements(input: EngagementInput): Engagement[] {
  const { td, rounds, vis } = input;
  const n = td.steamIds.length;
  const byKey = (rows: Row[], a: string, b?: string) => {
    const m = new Map<string, number[]>();
    for (const r of rows) {
      const k = b ? `${r[a]}>${r[b]}` : String(r[a]);
      let arr = m.get(k);
      if (!arr) m.set(k, (arr = []));
      arr.push(r.tick as number);
    }
    for (const arr of m.values()) arr.sort((x, y) => x - y);
    return m;
  };
  const shots = byKey(input.fires.filter((f) => !/knife|grenade|flashbang|molotov|incgrenade|decoy|c4|taser/.test(String(f.weapon))), 'user_steamid');
  const damage = byKey(input.hurts, 'attacker_steamid', 'user_steamid');
  const kills = byKey(input.deaths, 'attacker_steamid', 'user_steamid');
  const smokes = activeSmokes(input.smokes, input.smokeExpired);
  const firstAtOrAfter = (arr: number[] | undefined, from: number, to: number) => {
    if (!arr) return null;
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < from) lo = mid + 1;
      else hi = mid;
    }
    return lo < arr.length && arr[lo] <= to ? arr[lo] : null;
  };

  const out: Engagement[] = [];
  for (const r of rounds) {
    const from = Math.max(r.freezeEnd, r.start + 1);
    const to = Math.min(r.end, td.maxTick);
    for (let a = 0; a < n; a++) {
      for (let v = 0; v < n; v++) {
        if (a === v) continue;
        let t = from;
        let lastEnd = -Infinity;
        while (t <= to) {
          if (!pairLive(td, a, v, t) || !vis.visible(a, v, t)) {
            t++;
            continue;
          }
          // Visibility window with gap merging.
          const start = t;
          let last = t;
          let k = t + 1;
          while (k <= to && k - last <= GAP_MERGE_TICKS && pairLive(td, a, v, k)) {
            if (vis.visible(a, v, k)) last = k;
            k++;
          }
          t = k;
          if (start - lastEnd < REENGAGE_COOLDOWN_TICKS) {
            lastEnd = last;
            continue;
          }
          lastEnd = last;
          const aId = td.steamIds[a];
          const vId = td.steamIds[v];
          const timeoutEnd = start + ENGAGEMENT_TIMEOUT_TICKS;
          const killTick = firstAtOrAfter(kills.get(`${aId}>${vId}`), start, Math.min(timeoutEnd, last + GAP_MERGE_TICKS));
          const end = Math.min(killTick ?? Infinity, last, timeoutEnd);
          const firstShot = firstAtOrAfter(shots.get(aId), start, end);
          const firstDamage = firstAtOrAfter(damage.get(`${aId}>${vId}`), start, end);
          const eyeA = eyePos(td, a, start);
          const headV = headPos(td, v, start);
          if (!eyeA || !headV) continue;
          const errors = new Float32Array(end - start + 1);
          for (let x = start; x <= end; x++) errors[x - start] = aimError(td, a, v, x) ?? NaN;
          const wi = td.weapon[at(td, a, start)];
          const weapon = wi >= 0 ? td.weaponNames[wi] : null;
          const d = dist(eyeA, headV);
          out.push({
            id: out.length,
            round: roundOf(rounds, start)?.round ?? r.round,
            attacker: aId,
            victim: vId,
            attackerIdx: a,
            victimIdx: v,
            startTick: start,
            endTick: end,
            firstShotTick: firstShot,
            firstDamageTick: firstDamage,
            killTick,
            outcome: killTick !== null ? 'kill' : firstDamage !== null ? 'damage' : firstShot !== null ? 'miss' : 'no_shot',
            weapon,
            weaponClass: weaponClass(weapon),
            distance: Math.round(d),
            distanceBand: distanceBand(d),
            attackerSpeed: Math.round(speed2d(td, a, start)),
            attackerFlashed: (td.f.flash_duration[at(td, a, start)] || 0) > 0.5,
            smoked: smokes.some((s) => s.from <= start && start <= s.to && pointSegmentDistance(s.pos, eyeA, headV) < SMOKE_RADIUS),
            startError: errors[0],
            startErrorRecoil: aimError(td, a, v, start, { recoil: true }),
            errors,
          });
        }
      }
    }
  }
  return out;
}

/** Both players present, alive, and on opposing teams. */
export function pairLive(td: TickData, a: number, v: number, t: number): boolean {
  const ia = at(td, a, t);
  const iv = at(td, v, t);
  if (!td.present[ia] || !td.present[iv] || !td.flags.is_alive[ia] || !td.flags.is_alive[iv]) return false;
  const ta = td.f.team_num[ia];
  const tv = td.f.team_num[iv];
  return (ta === 2 || ta === 3) && (tv === 2 || tv === 3) && ta !== tv;
}

function activeSmokes(det: Row[], expired: Row[]): { pos: Vec3; from: number; to: number }[] {
  return det.map((d) => {
    const from = d.tick as number;
    const exp = expired.find((e) => e.entityid === d.entityid && (e.tick as number) > from);
    return { pos: { x: Number(d.x ?? d.user_X), y: Number(d.y ?? d.user_Y), z: Number(d.z ?? d.user_Z) }, from, to: exp ? (exp.tick as number) : from + SMOKE_LIFETIME_TICKS };
  });
}

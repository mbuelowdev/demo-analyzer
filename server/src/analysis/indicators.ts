// R-CD-4: indicator plugin API + the initial indicators (spec table "Initial indicators").
// Every indicator works on GOTV data only (positions, view angles, events, spotted mask); none reads usercmd data.
import type { Engagement } from './engagements.ts';
import { pairLive } from './engagements.ts';
import { aimError, angleBetween, anglesTo, distanceBand, eyePos, headPos, hitboxRadiusDeg, MS_PER_TICK, RECOIL_SCALE, TICK_RATE, viewAngles, weaponClass, wrap180 } from './geometry.ts';
import { at, type Row, type TickData } from './load.ts';
import { roundOf, type Round } from './rounds.ts';
import type { VisibilityModel } from './visibility.ts';

export interface FlaggedMoment {
  tick: number;
  round: number | null;
  note: string;
  value?: number;
  victim?: string;
}

export interface PlayerIndicatorResult {
  samples: number;
  /** Plain metrics, plus stratified ones as `<metric>|<stratum>` with sample counts in `<metric>|<stratum>#n`. */
  metrics: Record<string, number | null>;
  flags?: FlaggedMoment[];
}

export interface IndicatorContext {
  td: TickData;
  rounds: Round[];
  vis: VisibilityModel;
  engagements: Engagement[];
  fires: Row[];
  hurts: Row[];
  deaths: Row[];
  bulletDamage: Row[];
  players: string[];
}

export interface IndicatorScoreSpec {
  /** Metric used for the suspicion score. */
  metric: string;
  /** Use `<metric>|<stratum>` keys and compare each stratum to its own baseline (R-SCORE-1). */
  stratified?: boolean;
  suspicious: 'low' | 'high';
  /** Minimum samples per player-match before the indicator counts (R-SCORE-3). */
  minSamples: number;
  defaultWeight: number;
}

export interface Indicator {
  id: string;
  version: number;
  name: string;
  description: string;
  inputs: string[];
  score: IndicatorScoreSpec;
  compute(ctx: IndicatorContext): Map<string, PlayerIndicatorResult>;
}

// ---- small stats helpers ----
export function quantile(xs: number[], q: number): number | null {
  const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}
export const median = (xs: number[]) => quantile(xs, 0.5);
export function mean(xs: number[]): number | null {
  const a = xs.filter((x) => Number.isFinite(x));
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
}
export function sd(xs: number[]): number | null {
  const a = xs.filter((x) => Number.isFinite(x));
  if (a.length < 2) return null;
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
const share = (xs: number[], pred: (x: number) => boolean) => (xs.length ? xs.filter(pred).length / xs.length : null);
const r3 = (x: number | null) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);

function perPlayer(ctx: IndicatorContext, fn: (sid: string, idx: number) => PlayerIndicatorResult): Map<string, PlayerIndicatorResult> {
  const out = new Map<string, PlayerIndicatorResult>();
  ctx.players.forEach((sid) => out.set(sid, fn(sid, ctx.td.index.get(sid)!)));
  return out;
}

function topFlags(flags: FlaggedMoment[], by: (f: FlaggedMoment) => number, n = 10): FlaggedMoment[] {
  return flags.sort((a, b) => by(a) - by(b)).slice(0, n);
}

/** Engagements usable for timing indicators: a gun, not flashed, not through smoke. */
const cleanEngagement = (e: Engagement) => e.weaponClass !== 'other' && !e.attackerFlashed && !e.smoked;

// ---- Time to damage ----
const ttd: Indicator = {
  id: 'ttd',
  version: 1,
  name: 'Time to damage',
  description: 'ms from the victim becoming visible (spotted mask) to the attacker’s first damage on them.',
  inputs: ['engagements'],
  score: { metric: 'median_ms', suspicious: 'low', minSamples: 8, defaultWeight: 1.5 },
  compute(ctx) {
    return perPlayer(ctx, (sid) => {
      const es = ctx.engagements.filter((e) => e.attacker === sid && e.firstDamageTick !== null && cleanEngagement(e));
      const ms = es.map((e) => (e.firstDamageTick! - e.startTick) * MS_PER_TICK);
      const flags = es
        .filter((e) => (e.firstDamageTick! - e.startTick) * MS_PER_TICK < 120)
        .map((e) => ({ tick: e.startTick, round: e.round, victim: e.victim, value: (e.firstDamageTick! - e.startTick) * MS_PER_TICK, note: `damage ${Math.round((e.firstDamageTick! - e.startTick) * MS_PER_TICK)} ms after visible` }));
      const m = median(ms);
      const s = sd(ms);
      return {
        samples: ms.length,
        metrics: { median_ms: r3(m), mean_ms: r3(mean(ms)), sd_ms: r3(s), p10_ms: r3(quantile(ms, 0.1)), cv: r3(m && s !== null ? s / m : null), share_under_200ms: r3(share(ms, (x) => x < 200)) },
        flags: topFlags(flags, (f) => f.value ?? 0),
      };
    });
  },
};

// ---- Reaction time ----
/** First tick where the crosshair clearly starts moving toward the target (error shrinking ≥ 30°/s for 2 ticks). */
function firstAimMove(e: Engagement): number | null {
  const err = e.errors;
  for (let i = 2; i < err.length; i++) {
    const d1 = (err[i - 2] - err[i - 1]) * TICK_RATE;
    const d2 = (err[i - 1] - err[i]) * TICK_RATE;
    if (d1 >= 30 && d2 >= 30) return e.startTick + i - 2;
  }
  return null;
}

const reaction: Indicator = {
  id: 'reaction',
  version: 1,
  name: 'Reaction time',
  description: 'ms from visible to the first aim movement toward the target or the first shot, whichever comes first. Engagements already on target (< 3°) are excluded.',
  inputs: ['engagements', 'ticks'],
  score: { metric: 'share_under_150ms', suspicious: 'high', minSamples: 8, defaultWeight: 1.5 },
  compute(ctx) {
    return perPlayer(ctx, (sid) => {
      const es = ctx.engagements.filter((e) => e.attacker === sid && cleanEngagement(e) && (e.startError ?? 0) >= 3);
      const ms: number[] = [];
      const flags: FlaggedMoment[] = [];
      for (const e of es) {
        const move = firstAimMove(e);
        const t = Math.min(move ?? Infinity, e.firstShotTick ?? Infinity);
        if (!Number.isFinite(t)) continue;
        const v = (t - e.startTick) * MS_PER_TICK;
        ms.push(v);
        if (v < 100) flags.push({ tick: e.startTick, round: e.round, victim: e.victim, value: v, note: `reacted in ${Math.round(v)} ms from ${Math.round(e.startError ?? 0)}° off` });
      }
      return {
        samples: ms.length,
        metrics: { median_ms: r3(median(ms)), sd_ms: r3(sd(ms)), share_under_150ms: r3(share(ms, (x) => x < 150)) },
        flags: topFlags(flags, (f) => f.value ?? 0),
      };
    });
  },
};

// ---- Pre-aim / crosshair placement ----
const preaim: Indicator = {
  id: 'preaim',
  version: 1,
  name: 'Pre-aim / crosshair placement',
  description: 'Angle between the crosshair and the victim’s head at the moment the victim becomes visible.',
  inputs: ['engagements'],
  score: { metric: 'share_under_2deg', suspicious: 'high', minSamples: 10, defaultWeight: 1.2 },
  compute(ctx) {
    return perPlayer(ctx, (sid) => {
      const es = ctx.engagements.filter((e) => e.attacker === sid && e.weaponClass !== 'other' && e.startError !== null && Number.isFinite(e.startError));
      const errs = es.map((e) => e.startError!);
      const flags = es
        .filter((e) => e.startError! < 1.5 && e.distance > 400)
        .map((e) => ({ tick: e.startTick, round: e.round, victim: e.victim, value: e.startError!, note: `crosshair ${e.startError!.toFixed(1)}° from head on first sight at ${e.distance} u` }));
      return {
        samples: errs.length,
        metrics: { median_deg: r3(median(errs)), share_under_2deg: r3(share(errs, (x) => x < 2)), share_under_5deg: r3(share(errs, (x) => x < 5)) },
        flags: topFlags(flags, (f) => f.value ?? 0),
      };
    });
  },
};

// ---- Wall tracking ----
const WALL_CONE_DEG = 4;
const WALL_MAX_DIST = 2500;
/** Ticks around real visibility that don't count (pre-aiming a known angle is normal). */
const WALL_GUARD_BEFORE = TICK_RATE;
const WALL_GUARD_AFTER = 2 * TICK_RATE;

const wallTracking: Indicator = {
  id: 'wall_tracking',
  version: 2,
  name: 'Wall tracking',
  description: `Share of time the crosshair stays within ${WALL_CONE_DEG}° of an enemy that is not visible (not in the spotted mask, ±1–2 s guard around visibility), and how closely it follows that enemy’s movement.`,
  inputs: ['ticks', 'visibility'],
  score: { metric: 'occluded_on_target_share', suspicious: 'high', minSamples: 640, defaultWeight: 1.5 },
  compute(ctx) {
    const { td, vis } = ctx;
    const n = td.steamIds.length;
    return perPlayer(ctx, (_sid, a) => {
      let considered = 0;
      let onTarget = 0;
      let followTicks = 0;
      let followMatch = 0;
      const flags: FlaggedMoment[] = [];
      for (const r of ctx.rounds) {
        const from = Math.max(r.freezeEnd, r.start + 1);
        const to = Math.min(r.end, td.maxTick);
        for (let v = 0; v < n; v++) {
          if (v === a) continue;
          let lastVisible = -Infinity;
          // Next tick at which v becomes visible to a (Infinity = none found up to scannedTo).
          let nextVisible = Infinity;
          let scannedTo = from - 1;
          let streak = 0;
          let streakStart = 0;
          for (let t = from; t <= to; t++) {
            if (!pairLive(td, a, v, t)) {
              streak = 0;
              continue;
            }
            if (vis.visible(a, v, t)) {
              lastVisible = t;
              nextVisible = Infinity;
              scannedTo = t;
              streak = 0;
              continue;
            }
            if (nextVisible === Infinity && scannedTo < Math.min(to, t + WALL_GUARD_BEFORE)) {
              for (let k = Math.max(scannedTo + 1, t + 1); k <= Math.min(to, t + WALL_GUARD_BEFORE); k++) {
                scannedTo = k;
                if (vis.visible(a, v, k)) {
                  nextVisible = k;
                  break;
                }
              }
            }
            if (t - lastVisible <= WALL_GUARD_AFTER || nextVisible - t <= WALL_GUARD_BEFORE) {
              streak = 0;
              continue;
            }
            const eye = eyePos(td, a, t);
            const head = headPos(td, v, t);
            const view = viewAngles(td, a, t);
            if (!eye || !head || !view) continue;
            const dx = head.x - eye.x;
            const dy = head.y - eye.y;
            if (Math.hypot(dx, dy) > WALL_MAX_DIST) continue;
            considered++;
            const want = anglesTo(eye, head);
            const err = angleBetween(view.pitch, view.yaw, want.pitch, want.yaw);
            if (err < WALL_CONE_DEG) {
              onTarget++;
              if (streak === 0) streakStart = t;
              streak++;
              // Following: when the target's bearing moves, does the view move with it?
              const prevEye = eyePos(td, a, t - 1);
              const prevHead = headPos(td, v, t - 1);
              const prevView = viewAngles(td, a, t - 1);
              if (prevEye && prevHead && prevView) {
                const prevWant = anglesTo(prevEye, prevHead);
                const bearingMove = wrap180(want.yaw - prevWant.yaw);
                const viewMove = wrap180(view.yaw - prevView.yaw);
                if (Math.abs(bearingMove) > 0.05) {
                  followTicks++;
                  if (Math.sign(bearingMove) === Math.sign(viewMove) && Math.abs(viewMove - bearingMove) < Math.abs(bearingMove)) followMatch++;
                }
              }
              if (streak === TICK_RATE) flags.push({ tick: streakStart, round: r.round, victim: td.steamIds[v], value: streak, note: `crosshair on hidden enemy for ≥1 s` });
            } else streak = 0;
          }
        }
      }
      return {
        samples: considered,
        metrics: {
          occluded_on_target_share: r3(considered ? onTarget / considered : null),
          follow_ratio: r3(followTicks >= 32 ? followMatch / followTicks : null),
          occluded_on_target_ticks: onTarget,
        },
        flags: flags.slice(0, 10),
      };
    });
  },
};

// ---- Flick precision ----
// GOTV view angles plateau for 2–3 ticks, so speeds are measured over 2-tick windows.
const FLICK_MIN_SPEED = 250; // °/s
const FLICK_MIN_ANGLE = 12;
const FLICK_VIS_SLACK = TICK_RATE / 2;

function speedOver(td: TickData, a: number, t0: number, t1: number): number {
  const p = viewAngles(td, a, t0);
  const q = viewAngles(td, a, t1);
  return p && q ? (angleBetween(p.pitch, p.yaw, q.pitch, q.yaw) * TICK_RATE) / (t1 - t0) : 0;
}

const flick: Indicator = {
  id: 'flick',
  version: 2,
  name: 'Flick precision',
  description: `View-angle changes over ${FLICK_MIN_ANGLE}° at > ${FLICK_MIN_SPEED}°/s that stop within 8° of an enemy (visible within ±0.5 s): how often they land on the head (< 1.5°) with less than 1° of correction afterwards.`,
  inputs: ['ticks', 'visibility'],
  score: { metric: 'snap_to_head_rate', suspicious: 'high', minSamples: 6, defaultWeight: 1.2 },
  compute(ctx) {
    const { td, vis } = ctx;
    const n = td.steamIds.length;
    const visibleNear = (a: number, v: number, t: number) => {
      for (let k = Math.max(0, t - FLICK_VIS_SLACK); k <= Math.min(td.maxTick, t + FLICK_VIS_SLACK); k += 2) if (vis.visible(a, v, k)) return true;
      return false;
    };
    return perPlayer(ctx, (_sid, a) => {
      let flicks = 0;
      let snaps = 0;
      const corrections: number[] = [];
      const flags: FlaggedMoment[] = [];
      for (const r of ctx.rounds) {
        const from = Math.max(r.freezeEnd, r.start + 1) + 2;
        const to = Math.min(r.end, td.maxTick) - 10;
        let t = from;
        while (t < to) {
          if (!td.flags.is_alive[at(td, a, t)] || speedOver(td, a, t - 2, t) < FLICK_MIN_SPEED) {
            t++;
            continue;
          }
          const start = t - 2;
          let end = t;
          while (end + 2 < to && speedOver(td, a, end, end + 2) >= FLICK_MIN_SPEED / 4) end += 2;
          const v0 = viewAngles(td, a, start);
          const vEnd = viewAngles(td, a, end);
          const total = v0 && vEnd ? angleBetween(v0.pitch, v0.yaw, vEnd.pitch, vEnd.yaw) : 0;
          if (total >= FLICK_MIN_ANGLE && end - start <= 0.4 * TICK_RATE) {
            let best: { v: number; err: number } | null = null;
            for (let v = 0; v < n; v++) {
              if (v === a || !pairLive(td, a, v, end) || !visibleNear(a, v, end)) continue;
              const err = aimError(td, a, v, end);
              if (err !== null && (!best || err < best.err)) best = { v, err };
            }
            if (best && best.err < 8) {
              flicks++;
              const after = viewAngles(td, a, Math.min(to, end + 8));
              const correction = after && vEnd ? angleBetween(vEnd.pitch, vEnd.yaw, after.pitch, after.yaw) : 0;
              corrections.push(correction);
              if (best.err < 1.5 && correction < 1) {
                snaps++;
                flags.push({ tick: start, round: r.round, victim: td.steamIds[best.v], value: best.err, note: `${Math.round(total)}° flick ended ${best.err.toFixed(2)}° from head, ${correction.toFixed(2)}° correction` });
              }
            }
          }
          t = end + 1;
        }
      }
      return {
        samples: flicks,
        metrics: { snap_to_head_rate: r3(flicks ? snaps / flicks : null), median_correction_deg: r3(median(corrections)), flicks },
        flags: topFlags(flags, (f) => f.value ?? 0),
      };
    });
  },
};

// ---- Aim accuracy ----
const HEAD_GROUPS = new Set(['head']);

const accuracy: Indicator = {
  id: 'accuracy',
  version: 1,
  name: 'Aim accuracy',
  description: 'First-bullet accuracy per engagement, HS% of hits by weapon class and distance band, and spray accuracy (hits per shot from the 4th bullet on).',
  inputs: ['engagements', 'events'],
  score: { metric: 'hs_rate', stratified: true, suspicious: 'high', minSamples: 10, defaultWeight: 1.2 },
  compute(ctx) {
    return perPlayer(ctx, (sid) => {
      const metrics: Record<string, number | null> = {};
      // First bullet: did the first shot of the engagement damage the victim within 2 ticks?
      const es = ctx.engagements.filter((e) => e.attacker === sid && e.firstShotTick !== null && e.weaponClass !== 'other');
      const firstHits = es.filter((e) => e.firstDamageTick !== null && e.firstDamageTick - e.firstShotTick! <= 2).length;
      metrics.first_bullet_hit_rate = r3(es.length ? firstHits / es.length : null);
      // HS% of hits per stratum.
      const strata = new Map<string, { hits: number; hs: number }>();
      let totalHits = 0;
      let totalHs = 0;
      for (const h of ctx.hurts) {
        if (h.attacker_steamid !== sid || h.user_steamid === sid) continue;
        if (h.attacker_team_num !== undefined && h.attacker_team_num === h.user_team_num) continue;
        const cls = weaponClass(String(h.weapon ?? ''));
        if (cls === 'other') continue;
        const ax = Number(h.attacker_X);
        const vx = Number(h.user_X);
        if (!Number.isFinite(ax) || !Number.isFinite(vx)) continue;
        const d = Math.hypot(vx - ax, Number(h.user_Y) - Number(h.attacker_Y), Number(h.user_Z) - Number(h.attacker_Z));
        const key = `${cls}:${distanceBand(d)}`;
        const s = strata.get(key) ?? { hits: 0, hs: 0 };
        s.hits++;
        totalHits++;
        if (HEAD_GROUPS.has(String(h.hitgroup))) {
          s.hs++;
          totalHs++;
        }
        strata.set(key, s);
      }
      for (const [k, s] of strata) {
        metrics[`hs_rate|${k}`] = r3(s.hs / s.hits);
        metrics[`hs_rate|${k}#n`] = s.hits;
      }
      metrics.hs_rate_overall = r3(totalHits ? totalHs / totalHits : null);
      // Spray accuracy: shots with recoil index ≥ 3 (4th bullet on) vs hits recorded with the same index.
      let sprayShots = 0;
      let sprayHits = 0;
      for (const b of ctx.bulletDamage) {
        if (b.attacker_steamid === sid && Number(b.recoil_index) >= 3) sprayHits++;
      }
      const idx = ctx.td.index.get(sid)!;
      for (const f of ctx.fires) {
        if (f.user_steamid !== sid) continue;
        const cls = weaponClass(String(f.weapon ?? ''));
        if (cls !== 'rifle' && cls !== 'smg' && cls !== 'heavy') continue;
        const t = f.tick as number;
        if (t > ctx.td.maxTick) continue;
        const shotsFired = ctx.td.f.shots_fired[at(ctx.td, idx, t)];
        if (shotsFired >= 4) sprayShots++;
      }
      metrics.spray_accuracy = r3(sprayShots >= 20 ? Math.min(1, sprayHits / sprayShots) : null);
      metrics.spray_shots = sprayShots;
      return { samples: totalHits, metrics };
    });
  },
};

// ---- Recoil compensation ----
// The aim punch in current demos only changes on each shot (step function, see SPIKE.md), so compensation is
// measured shot to shot: bullet k leaves along eye(t_k) + 2 × punch(t_k − 1).
const recoil: Indicator = {
  id: 'recoil',
  version: 2,
  name: 'Recoil compensation',
  description: 'During sprays (≥ 5 shots, rifles/SMGs) at a visible enemy, the shot-to-shot drift of the bullet direction (eye angles + 2 × aim punch, minus target movement) divided by the drift the recoil alone would cause. 0 = perfect compensation; humans land around 1 because tracking and over-correction add drift.',
  inputs: ['ticks', 'events'],
  score: { metric: 'median_residual_ratio', suspicious: 'low', minSamples: 5, defaultWeight: 1 },
  compute(ctx) {
    const { td } = ctx;
    return perPlayer(ctx, (sid, a) => {
      const ratios: number[] = [];
      const flags: FlaggedMoment[] = [];
      const fires = ctx.fires
        .filter((f) => f.user_steamid === sid && ['rifle', 'smg'].includes(weaponClass(String(f.weapon ?? ''))))
        .map((f) => f.tick as number)
        .filter((t) => t > 0 && t <= td.maxTick);
      let i = 0;
      while (i < fires.length) {
        let j = i;
        while (j + 1 < fires.length && fires[j + 1] - fires[j] <= 10) j++;
        if (j - i + 1 >= 5) {
          const shots = fires.slice(i + 1, j + 1); // from the 2nd shot on, punch is non-zero
          // Engaged target: the visible enemy nearest to the bullet direction at the 2nd shot.
          let target: number | null = null;
          let bestErr = 10;
          for (let v = 0; v < td.steamIds.length; v++) {
            if (v === a || !pairLive(td, a, v, shots[0]) || !ctx.vis.visible(a, v, shots[0])) continue;
            const err = aimError(td, a, v, shots[0], { recoil: true });
            if (err !== null && err < bestErr) {
              bestErr = err;
              target = v;
            }
          }
          if (target === null) {
            // Spraying at nothing (smoke, wallbang guesses) says nothing about compensation.
            i = j + 1;
            continue;
          }
          const bullet = (t: number) => {
            const eye = viewAngles(td, a, t);
            const pp = td.f.aim_punch_pitch[at(td, a, t - 1)];
            const py = td.f.aim_punch_yaw[at(td, a, t - 1)];
            if (!eye || Number.isNaN(pp)) return null;
            return { pitch: eye.pitch + RECOIL_SCALE * pp, yaw: eye.yaw + RECOIL_SCALE * (py || 0), pp, py: py || 0 };
          };
          let residual = 0;
          let recoilMove = 0;
          for (let k = 1; k < shots.length; k++) {
            const b0 = bullet(shots[k - 1]);
            const b1 = bullet(shots[k]);
            if (!b0 || !b1) continue;
            let dp = b1.pitch - b0.pitch;
            let dy = wrap180(b1.yaw - b0.yaw);
            {
              const e0 = eyePos(td, a, shots[k - 1]);
              const e1 = eyePos(td, a, shots[k]);
              const h0 = headPos(td, target, shots[k - 1]);
              const h1 = headPos(td, target, shots[k]);
              if (e0 && e1 && h0 && h1) {
                const w0 = anglesTo(e0, h0);
                const w1 = anglesTo(e1, h1);
                dp -= w1.pitch - w0.pitch;
                dy -= wrap180(w1.yaw - w0.yaw);
              }
            }
            residual += Math.hypot(dp, dy);
            recoilMove += RECOIL_SCALE * Math.hypot(b1.pp - b0.pp, b1.py - b0.py);
          }
          if (recoilMove > 2) {
            const ratio = residual / recoilMove;
            ratios.push(ratio);
            if (ratio < 0.1) flags.push({ tick: fires[i], round: roundOf(ctx.rounds, fires[i])?.round ?? null, value: ratio, note: `spray of ${j - i + 1} shots with residual ratio ${ratio.toFixed(2)}` });
          }
        }
        i = j + 1;
      }
      return { samples: ratios.length, metrics: { median_residual_ratio: r3(median(ratios)), p10_residual_ratio: r3(quantile(ratios, 0.1)) }, flags: topFlags(flags, (f) => f.value ?? 0) };
    });
  },
};

// ---- Triggerbot pattern ----
const triggerbot: Indicator = {
  id: 'triggerbot',
  version: 1,
  name: 'Triggerbot pattern',
  description: 'Delay from the crosshair entering the victim’s hitbox (head or torso, angular size from distance) to the shot, in engagements where the crosshair started outside it.',
  inputs: ['engagements', 'ticks'],
  score: { metric: 'share_within_1tick', suspicious: 'high', minSamples: 8, defaultWeight: 1 },
  compute(ctx) {
    const { td } = ctx;
    return perPlayer(ctx, (sid) => {
      const delays: number[] = [];
      const flags: FlaggedMoment[] = [];
      for (const e of ctx.engagements) {
        if (e.attacker !== sid || e.firstShotTick === null || e.weaponClass === 'other') continue;
        let entered: number | null = null;
        let wasOutside = false;
        for (let t = e.startTick; t <= e.firstShotTick; t++) {
          const errHead = aimError(td, e.attackerIdx, e.victimIdx, t, { recoil: true });
          const errBody = aimError(td, e.attackerIdx, e.victimIdx, t, { recoil: true, target: 'body' });
          const eye = eyePos(td, e.attackerIdx, t);
          const head = headPos(td, e.victimIdx, t);
          if (errHead === null || errBody === null || !eye || !head) continue;
          const d = Math.hypot(head.x - eye.x, head.y - eye.y, head.z - eye.z);
          const inside = errHead < hitboxRadiusDeg(d, 'head') || errBody < hitboxRadiusDeg(d, 'body');
          if (!inside) {
            wasOutside = true;
            entered = null;
          } else if (wasOutside && entered === null) entered = t;
        }
        if (entered === null) continue;
        const delay = (e.firstShotTick - entered) * MS_PER_TICK;
        if (delay > 500) continue;
        delays.push(delay);
        if (delay <= MS_PER_TICK) flags.push({ tick: entered, round: e.round, victim: e.victim, value: delay, note: `shot ${Math.round(delay)} ms after crosshair entered hitbox` });
      }
      return {
        samples: delays.length,
        metrics: { median_ms: r3(median(delays)), sd_ms: r3(sd(delays)), share_within_1tick: r3(share(delays, (x) => x <= MS_PER_TICK + 0.01)) },
        flags: flags.slice(0, 10),
      };
    });
  },
};

// ---- Through-obstacle kills ----
const obstacles: Indicator = {
  id: 'obstacles',
  version: 1,
  name: 'Through-obstacle kills',
  description: 'Share of kills through smoke (thrusmoke), through walls (penetrated) or while flashed (attackerblind).',
  inputs: ['events'],
  score: { metric: 'obstacle_kill_share', suspicious: 'high', minSamples: 8, defaultWeight: 0.8 },
  compute(ctx) {
    return perPlayer(ctx, (sid) => {
      const kills = ctx.deaths.filter((d) => d.attacker_steamid === sid && d.user_steamid !== sid && d.attacker_team_num !== d.user_team_num);
      const smoke = kills.filter((d) => d.thrusmoke === true).length;
      const wall = kills.filter((d) => Number(d.penetrated ?? 0) > 0).length;
      const blind = kills.filter((d) => d.attackerblind === true).length;
      const any = kills.filter((d) => d.thrusmoke === true || Number(d.penetrated ?? 0) > 0 || d.attackerblind === true);
      const n = kills.length;
      return {
        samples: n,
        metrics: {
          obstacle_kill_share: r3(n ? any.length / n : null),
          smoke_kill_share: r3(n ? smoke / n : null),
          wallbang_kill_share: r3(n ? wall / n : null),
          blind_kill_share: r3(n ? blind / n : null),
        },
        flags: any.slice(0, 10).map((d) => ({
          tick: d.tick as number,
          round: roundOf(ctx.rounds, d.tick as number)?.round ?? null,
          victim: String(d.user_steamid),
          note: [d.thrusmoke ? 'through smoke' : '', Number(d.penetrated ?? 0) > 0 ? 'wallbang' : '', d.attackerblind ? 'while flashed' : ''].filter(Boolean).join(', ') + ` kill (${d.weapon})`,
        })),
      };
    });
  },
};

export const INDICATORS: Indicator[] = [ttd, reaction, preaim, accuracy, wallTracking, flick, recoil, triggerbot, obstacles];

export const INDICATOR_VERSION_KEY = INDICATORS.map((i) => `${i.id}@${i.version}`).join(',');

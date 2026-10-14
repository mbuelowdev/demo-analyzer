// R-CD-4: indicator plugin API + the initial indicators (spec table "Initial indicators").
// Every indicator works on GOTV data only (positions, view angles, events, spotted mask); none reads usercmd data.
import type { Engagement } from './engagements.ts';
import { pairLive } from './engagements.ts';
import { aimError, angleBetween, anglesTo, bodyPos, dist, distanceBand, eyePos, headPos, hitboxRadiusDeg, isGun, MS_PER_TICK, rad, RECOIL_SCALE, TICK_RATE, viewAngles, weaponClass, wrap180 } from './geometry.ts';
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
  /** Metric shown in the match table; defaults to `score.metric`. */
  display?: string;
  /** Second metric shown after the display metric as `display/secondary`. */
  displaySecondary?: string;
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
/**
 * First tick where the attacker's own view clearly starts turning toward the target: at least 30°/s of
 * movement toward it on 2 consecutive ticks. Each step is measured against the target direction of the
 * previous tick (held fixed), so the victim or the attacker walking doesn't count as aim movement.
 */
function firstAimMove(td: TickData, e: Engagement): number | null {
  const a = e.attackerIdx;
  let run = 0;
  for (let t = e.startTick + 1; t <= e.endTick; t++) {
    const eye = eyePos(td, a, t - 1);
    const head = headPos(td, e.victimIdx, t - 1);
    const v0 = viewAngles(td, a, t - 1);
    const v1 = viewAngles(td, a, t);
    if (!eye || !head || !v0 || !v1) {
      run = 0;
      continue;
    }
    const want = anglesTo(eye, head);
    const toward = (angleBetween(v0.pitch, v0.yaw, want.pitch, want.yaw) - angleBetween(v1.pitch, v1.yaw, want.pitch, want.yaw)) * TICK_RATE;
    run = toward >= 30 ? run + 1 : 0;
    if (run === 2) return t - 2;
  }
  return null;
}

const reaction: Indicator = {
  id: 'reaction',
  version: 2,
  name: 'Reaction time',
  description: 'ms from visible to the first movement of the attacker’s own view toward the target (victim and attacker movement ignored) or the first shot, whichever comes first. Engagements already on target (< 3°) are excluded.',
  inputs: ['engagements', 'ticks'],
  display: 'median_ms',
  score: { metric: 'share_under_150ms', suspicious: 'high', minSamples: 8, defaultWeight: 1.5 },
  compute(ctx) {
    return perPlayer(ctx, (sid) => {
      const es = ctx.engagements.filter((e) => e.attacker === sid && cleanEngagement(e) && (e.startError ?? 0) >= 3);
      const ms: number[] = [];
      const flags: FlaggedMoment[] = [];
      for (const e of es) {
        const move = firstAimMove(ctx.td, e);
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

// ---- Pre-aim ----
const preaim: Indicator = {
  id: 'preaim',
  version: 2,
  name: 'Pre-aim',
  description: 'Angle between the crosshair and the center of the victim’s body at the moment the victim becomes visible.',
  inputs: ['engagements'],
  display: 'median_deg',
  score: { metric: 'share_under_2deg', suspicious: 'high', minSamples: 10, defaultWeight: 1.2 },
  compute(ctx) {
    return perPlayer(ctx, (sid) => {
      const es = ctx.engagements
        .filter((e) => e.attacker === sid && e.weaponClass !== 'other')
        .map((e) => ({ e, err: aimError(ctx.td, e.attackerIdx, e.victimIdx, e.startTick, { target: 'body' }) }))
        .filter((x): x is { e: Engagement; err: number } => x.err !== null && Number.isFinite(x.err));
      const errs = es.map((x) => x.err);
      const flags = es
        .filter(({ e, err }) => err < 1.5 && e.distance > 400)
        .map(({ e, err }) => ({ tick: e.startTick, round: e.round, victim: e.victim, value: err, note: `crosshair ${err.toFixed(1)}° from body center on first sight at ${e.distance} u` }));
      return {
        samples: errs.length,
        metrics: { median_deg: r3(median(errs)), share_under_2deg: r3(share(errs, (x) => x < 2)), share_under_5deg: r3(share(errs, (x) => x < 5)) },
        flags: topFlags(flags, (f) => f.value ?? 0),
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
  // Few flicks per match land near an enemy; low minimum and weight so single matches still count it.
  score: { metric: 'snap_to_head_rate', suspicious: 'high', minSamples: 3, defaultWeight: 0.8 },
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
  display: 'hs_rate_overall',
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
  // ~3 qualifying engagements per player per match; low minimum and weight so single matches still count it.
  score: { metric: 'share_within_1tick', suspicious: 'high', minSamples: 3, defaultWeight: 0.6 },
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

// ---- Counter-strafing ----
// Standing accuracy needs a horizontal speed below 34% of the active weapon's max speed (the scoped max speed
// while scoped). Releasing the keys only lets friction (sv_friction 5.2, sv_stopspeed 80) slow the player;
// pressing the opposite key adds acceleration on top. Measured on the fixture demos, per-tick deceleration
// clusters at 1× the friction model (keys released) and 2–3× (counter-strafe), so a stop counts as a
// counter-strafe when it beats friction by 1.6× on 2+ ticks.
// Timing: an auto-stop cheat holds the shot until the player is accurate, so it fires on the tick the speed
// drops under the threshold; humans fire some reaction time later, with spread.

/** CS2 max movement speed per weapon, [unscoped, scoped]. */
const WEAPON_MAX_SPEED: Record<string, [number, number?]> = {
  glock: [240], usp_silencer: [240], hkp2000: [240], p250: [240], fiveseven: [240], tec9: [240], cz75a: [240], elite: [240], deagle: [230], revolver: [220],
  ak47: [215], m4a1: [225], m4a1_silencer: [225], famas: [220], galilar: [215], aug: [220, 150], sg556: [210, 150],
  awp: [200, 100], ssg08: [230], scar20: [215, 120], g3sg1: [215, 120],
  mac10: [240], mp9: [240], mp7: [220], mp5sd: [235], ump45: [230], p90: [230], bizon: [240],
  nova: [220], xm1014: [215], mag7: [225], sawedoff: [210], negev: [150], m249: [195],
};
export function weaponMaxSpeed(weapon: string, scoped: boolean): number | null {
  const s = WEAPON_MAX_SPEED[weapon.toLowerCase().replace(/^weapon_/, '')];
  return s ? (scoped ? (s[1] ?? s[0]) : s[0]) : null;
}

const ACCURATE_FRACTION = 0.34;
const FRICTION = 5.2;
const STOP_SPEED = 80;
const CS_FRICTION_FACTOR = 1.6;
const CS_MIN_TICKS = 2;
const CS_WINDOW = TICK_RATE / 4;
/** A shot counts as a new attempt after this long without firing (later bullets of a spray aren't attempts). */
const ATTEMPT_GAP = TICK_RATE / 2;
/** How far back a stop (speed crossing under the threshold) is looked for before an accurate shot. */
const STOP_LOOKBACK = TICK_RATE / 2;

const counterstrafe: Indicator = {
  id: 'counterstrafe',
  version: 2,
  name: 'Counter-strafing',
  description: `Per shot attempt (first gun shot after ${ATTEMPT_GAP * MS_PER_TICK} ms without firing): accurate_share = on the ground and below ${ACCURATE_FRACTION * 100}% of the weapon's max speed (scoped speed while scoped), so at full accuracy; counterstrafe_share = of those accurate shots, how many came from a counter-strafe in the last ${CS_WINDOW * MS_PER_TICK} ms (deceleration over ${CS_FRICTION_FACTOR}× what friction alone allows on ${CS_MIN_TICKS}+ ticks, or a velocity reversal). Shown as accurate/counter-strafed. Timing: for accurate shots that follow a stop (speed above the threshold within ${STOP_LOOKBACK * MS_PER_TICK} ms), ms from the speed dropping under the threshold to the shot; auto-stop fires on that tick.`,
  inputs: ['ticks', 'events'],
  display: 'accurate_share',
  displaySecondary: 'counterstrafe_share',
  // Not validated against known cheaters yet: shown, but no weight in the suspicion score until it is.
  score: { metric: 'share_stop_within_1tick', suspicious: 'high', minSamples: 8, defaultWeight: 0 },
  compute(ctx) {
    const { td } = ctx;
    const speed = (i: number) => Math.hypot(td.f.vel_x[i], td.f.vel_y[i]);
    const grounded = (i: number) => td.present[i] === 1 && !td.flags.is_airborne[i];
    const counterStrafed = (a: number, shot: number) => {
      let ticks = 0;
      for (let t = Math.max(1, shot - CS_WINDOW + 1); t <= shot; t++) {
        const i0 = at(td, a, t - 1);
        const i1 = at(td, a, t);
        if (!grounded(i0) || !grounded(i1)) continue;
        const prev = speed(i0);
        const cur = speed(i1);
        if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev < 20) continue;
        const friction = Math.min(prev, (Math.max(prev, STOP_SPEED) * FRICTION) / TICK_RATE);
        const reversed = td.f.vel_x[i0] * td.f.vel_x[i1] + td.f.vel_y[i0] * td.f.vel_y[i1] < 0;
        if (reversed || prev - cur > CS_FRICTION_FACTOR * friction) ticks++;
      }
      return ticks >= CS_MIN_TICKS;
    };
    /** Ticks from the speed dropping under `limit` to the shot, or null if the player wasn't moving faster recently. */
    const stopDelay = (a: number, shot: number, limit: number) => {
      for (let t = shot - 1; t >= Math.max(0, shot - STOP_LOOKBACK); t--) {
        const i = at(td, a, t);
        if (!grounded(i)) return null;
        if (speed(i) >= limit) return shot - (t + 1);
      }
      return null;
    };
    return perPlayer(ctx, (sid, a) => {
      let attempts = 0;
      let accurate = 0;
      let countered = 0;
      const delays: number[] = [];
      const flags: FlaggedMoment[] = [];
      let lastShot = -Infinity;
      for (const f of ctx.fires) {
        if (f.user_steamid !== sid) continue;
        const t = f.tick as number;
        const prev = lastShot;
        lastShot = t;
        if (t - prev < ATTEMPT_GAP || t < 1 || t > td.maxTick) continue;
        const r = roundOf(ctx.rounds, t);
        if (!r || t < r.freezeEnd) continue;
        const i = at(td, a, t);
        const max = weaponMaxSpeed(String(f.weapon ?? ''), td.flags.is_scoped[i] === 1);
        const v = speed(i);
        if (max === null || !Number.isFinite(v)) continue;
        const limit = ACCURATE_FRACTION * max;
        attempts++;
        if (!grounded(i) || v >= limit) continue;
        accurate++;
        const cs = counterStrafed(a, t);
        if (cs) countered++;
        const d = stopDelay(a, t, limit);
        if (d === null) continue;
        delays.push(d * MS_PER_TICK);
        if (cs && d === 0) flags.push({ tick: t, round: r.round, value: 0, note: `counter-strafed and fired on the tick the speed dropped under ${Math.round(limit)} u/s (${String(f.weapon).replace(/^weapon_/, '')})` });
      }
      return {
        samples: attempts,
        metrics: {
          accurate_share: r3(attempts ? accurate / attempts : null),
          counterstrafe_share: r3(accurate ? countered / accurate : null),
          shot_attempts: attempts,
          median_stop_to_shot_ms: r3(median(delays)),
          sd_stop_to_shot_ms: r3(sd(delays)),
          share_stop_within_1tick: r3(delays.length >= 8 ? share(delays, (x) => x <= MS_PER_TICK + 0.01) : null),
          stops: delays.length,
        },
        flags: flags.slice(0, 10),
      };
    });
  },
};

// ---- Aim lock on hidden enemies ----
// An aimbot locked onto an enemy behind a (often wallbangable) wall keeps the crosshair on the *same spot* of
// the victim's body (head, chest centre) while the line of sight moves because either player moves. A human
// holding an angle, pre-aiming a common spot or following footsteps lands somewhere on the body at best, and
// the spot drifts (left side, right side, head, feet) as soon as anyone moves. So a lock is: victim not in the
// spotted mask, crosshair on the body, its spot on the victim stable within LOCK_TOL_UNITS, while the line of
// sight sweeps more than LOCK_MIN_SWEEP_UNITS across the victim, for LOCK_MIN_TICKS or longer.
// The spot is measured in world units on the victim (angular offset × distance), so the tolerance means the
// same at every distance. GOTV view angles plateau for 2–3 ticks, so offsets are averaged over LOCK_SMOOTH ticks.
export const LOCK_MIN_TICKS = TICK_RATE;
/** Allowed distance of the (smoothed) crosshair spot from the lock's running mean spot, in world units. */
export const LOCK_TOL_UNITS = 5;
/** The line of sight must sweep at least this far across the victim (world units at the victim) during a lock. */
export const LOCK_MIN_SWEEP_UNITS = 32;
const LOCK_SMOOTH = 5;
/** Ignore the first ticks after the victim was last visible: the spotted mask lags and humans keep tracking briefly. */
const LOCK_VIS_GUARD = TICK_RATE / 4;
const LOCK_MAX_DIST = 3000;
const LOCK_HALF_WIDTH = 16;
/** Head top above, feet below the body centre (bodyPos = eye − 24). */
const LOCK_TOP = 32;

export interface AimLock {
  attacker: number;
  victim: number;
  start: number;
  end: number;
  /** Mean spot on the victim relative to the body centre: lateral (right +) and vertical (up +), world units. */
  u: number;
  w: number;
  /** Max deviation of the smoothed spot from the mean spot, world units. */
  drift: number;
  /** How far the line of sight swept across the victim, world units. */
  sweep: number;
  distance: number;
}

interface LockSample {
  t: number;
  u: number;
  w: number;
  d: number;
  pitch: number;
  yaw: number;
}

/** Crosshair spot on the victim relative to its body centre, or null when it isn't on the body. */
function lockSample(td: TickData, a: number, v: number, t: number): LockSample | null {
  const eye = eyePos(td, a, t);
  const body = bodyPos(td, v, t);
  const view = viewAngles(td, a, t);
  if (!eye || !body || !view) return null;
  const d = dist(eye, body);
  if (d > LOCK_MAX_DIST || d < 1) return null;
  const want = anglesTo(eye, body);
  const u = d * rad(wrap180(view.yaw - want.yaw)) * Math.cos(rad(want.pitch));
  const w = d * rad(want.pitch - view.pitch);
  const bottom = -(body.z - td.f.z[at(td, v, t)]);
  if (Math.abs(u) > LOCK_HALF_WIDTH || w > LOCK_TOP || w < bottom - 4) return null;
  return { t, u, w, d, pitch: want.pitch, yaw: want.yaw };
}

/** Splits one run of consecutive on-body hidden ticks into stable locks of at least LOCK_MIN_TICKS. */
function locksInRun(run: LockSample[], a: number, v: number, out: AimLock[]) {
  if (run.length < LOCK_MIN_TICKS) return;
  const h = LOCK_SMOOTH >> 1;
  const su: number[] = [];
  const sw: number[] = [];
  for (let i = 0; i < run.length; i++) {
    let u = 0;
    let w = 0;
    let n = 0;
    for (let k = Math.max(0, i - h); k <= Math.min(run.length - 1, i + h); k++, n++) {
      u += run[k].u;
      w += run[k].w;
    }
    su.push(u / n);
    sw.push(w / n);
  }
  let i = 0;
  while (i < run.length) {
    let mu = su[i];
    let mw = sw[i];
    let j = i + 1;
    while (j < run.length && Math.hypot(su[j] - mu, sw[j] - mw) <= LOCK_TOL_UNITS) {
      const n = j - i + 1;
      mu += (su[j] - mu) / n;
      mw += (sw[j] - mw) / n;
      j++;
    }
    if (j - i >= LOCK_MIN_TICKS) {
      // Sweep of the line of sight, in 4-tick steps (steps of single ticks would add up GOTV jitter).
      let sweep = 0;
      for (let k = i; k < j - 1; k += 4) {
        const q = Math.min(j - 1, k + 4);
        sweep += rad(angleBetween(run[k].pitch, run[k].yaw, run[q].pitch, run[q].yaw)) * run[q].d;
      }
      if (sweep >= LOCK_MIN_SWEEP_UNITS) {
        let drift = 0;
        let dSum = 0;
        for (let k = i; k < j; k++) {
          drift = Math.max(drift, Math.hypot(su[k] - mu, sw[k] - mw));
          dSum += run[k].d;
        }
        out.push({ attacker: a, victim: v, start: run[i].t, end: run[j - 1].t, u: mu, w: mw, drift, sweep, distance: dSum / (j - i) });
      }
    }
    i = j;
  }
}

/** All aim locks of attacker `a` on hidden enemies during live round time. */
export function findAimLocks(ctx: Pick<IndicatorContext, 'td' | 'rounds' | 'vis'>, a: number): AimLock[] {
  const { td, vis } = ctx;
  const out: AimLock[] = [];
  for (const r of ctx.rounds) {
    const from = Math.max(r.freezeEnd, r.start + 1);
    const to = Math.min(r.end, td.maxTick);
    for (let v = 0; v < td.steamIds.length; v++) {
      if (v === a) continue;
      let lastVisible = -Infinity;
      let run: LockSample[] = [];
      for (let t = from; t <= to; t++) {
        let s: LockSample | null = null;
        if (pairLive(td, a, v, t)) {
          if (vis.visible(a, v, t)) lastVisible = t;
          else if (t - lastVisible > LOCK_VIS_GUARD && isGun(td.weaponNames[td.weapon[at(td, a, t)]])) s = lockSample(td, a, v, t);
        }
        if (s) run.push(s);
        else if (run.length) {
          locksInRun(run, a, v, out);
          run = [];
        }
      }
      locksInRun(run, a, v, out);
    }
  }
  return out;
}

function lockSpot(l: AimLock): string {
  if (l.w > 18) return 'head';
  if (l.w > -8) return Math.abs(l.u) < 5 ? 'chest centre' : 'chest';
  return l.w > -24 ? 'stomach' : 'legs';
}

const aimLock: Indicator = {
  id: 'aim_lock',
  version: 1,
  name: 'Aim lock (hidden)',
  description: `Moments the crosshair stays locked on one spot of an enemy that is not visible (not in the spotted mask, ${LOCK_VIS_GUARD * MS_PER_TICK} ms after last sight): on the body, the spot on the victim drifting less than ${LOCK_TOL_UNITS} units while the line of sight sweeps over ${LOCK_MIN_SWEEP_UNITS} units across the victim because either player moves, for ${LOCK_MIN_TICKS * MS_PER_TICK} ms or longer. Holding an angle or pre-aiming doesn't keep the same spot once anyone moves. Shown as locks/longest lock.`,
  inputs: ['ticks', 'visibility'],
  display: 'locks',
  displaySecondary: 'longest_lock_ms',
  score: { metric: 'longest_lock_ms', suspicious: 'high', minSamples: 8, defaultWeight: 1 },
  compute(ctx) {
    const { td } = ctx;
    return perPlayer(ctx, (_sid, a) => {
      const locks = findAimLocks(ctx, a);
      const ms = locks.map((l) => (l.end - l.start + 1) * MS_PER_TICK);
      // Samples: rounds the player was alive in after freeze time, so a match where they barely played doesn't count.
      const rounds = ctx.rounds.filter((r) => r.freezeEnd <= td.maxTick && td.flags.is_alive[at(td, a, Math.min(td.maxTick, r.freezeEnd + 1))]).length;
      const flags = locks.map((l, k) => ({
        tick: l.start,
        round: roundOf(ctx.rounds, l.start)?.round ?? null,
        victim: td.steamIds[l.victim],
        value: ms[k],
        note: `locked on ${lockSpot(l)} of hidden enemy for ${(ms[k] / 1000).toFixed(2)} s (spot drift ${l.drift.toFixed(1)} u, line of sight swept ${Math.round(l.sweep)} u, ${Math.round(l.distance)} u away)`,
      }));
      return {
        samples: rounds,
        metrics: { locks: locks.length, longest_lock_ms: r3(ms.length ? Math.max(...ms) : 0), lock_total_ms: r3(ms.reduce((s, x) => s + x, 0)) },
        flags: topFlags(flags, (f) => -(f.value ?? 0)),
      };
    });
  },
};

export const INDICATORS: Indicator[] = [ttd, reaction, preaim, accuracy, flick, recoil, triggerbot, obstacles, counterstrafe, aimLock];

export const INDICATOR_VERSION_KEY = INDICATORS.map((i) => `${i.id}@${i.version}`).join(',');

import { describe, expect, it } from 'vitest';
import { extractEngagements } from '../src/analysis/engagements.ts';
import { aimError, angleBetween, anglesTo, MS_PER_TICK } from '../src/analysis/geometry.ts';
import { INDICATORS, type IndicatorContext, weaponMaxSpeed } from '../src/analysis/indicators.ts';
import type { Row } from '../src/analysis/load.ts';
import { SpottedMaskVisibility } from '../src/analysis/visibility.ts';
import { makeTickData, oneRound, type PlayerSpec } from './synthetic.ts';

const A = '76561197960265729';
const V = '76561197960265730';
const victimPos = { x: 1000, y: 0, z: 0 };
const attackerPos = { x: 0, y: 0, z: 0 };
const onHead = anglesTo({ x: 0, y: 0, z: 64 }, { x: 1000, y: 0, z: 62 });

function scenario(opts: { visibleFrom: number; view: (t: number) => { pitch: number; yaw: number }; victimPos?: (t: number) => { x: number; y: number; z: number }; shots?: number[]; hurtAt?: number; killAt?: number }) {
  const players: PlayerSpec[] = [
    { steamId: A, team: 2, pos: () => attackerPos, view: opts.view },
    { steamId: V, team: 3, pos: opts.victimPos ?? (() => victimPos), view: () => ({ pitch: 0, yaw: 180 }), spottedBy: (t) => (t >= opts.visibleFrom ? [A] : []) },
  ];
  const td = makeTickData(600, players);
  const rounds = oneRound(600);
  const fires: Row[] = (opts.shots ?? []).map((tick) => ({ tick, user_steamid: A, weapon: 'weapon_ak47' }));
  const hurts: Row[] = opts.hurtAt !== undefined ? [{ tick: opts.hurtAt, attacker_steamid: A, user_steamid: V, weapon: 'ak47', hitgroup: 'head', attacker_team_num: 2, user_team_num: 3, attacker_X: 0, attacker_Y: 0, attacker_Z: 0, user_X: 1000, user_Y: 0, user_Z: 0, dmg_health: 100, user_health: 100 }] : [];
  const deaths: Row[] = opts.killAt !== undefined ? [{ tick: opts.killAt, attacker_steamid: A, user_steamid: V, attacker_team_num: 2, user_team_num: 3, weapon: 'ak47', headshot: true, thrusmoke: true, penetrated: 0, attackerblind: false }] : [];
  const vis = new SpottedMaskVisibility(td);
  const engagements = extractEngagements({ td, rounds, vis, fires, hurts, deaths, smokes: [], smokeExpired: [] });
  const ctx: IndicatorContext = { td, rounds, vis, engagements, fires, hurts, deaths, bulletDamage: [], players: [A, V] };
  const run = (id: string) => INDICATORS.find((i) => i.id === id)!.compute(ctx).get(A)!;
  return { td, engagements, run };
}

describe('view-angle helpers (R-CD-3)', () => {
  it('measures angular distance', () => {
    expect(angleBetween(0, 0, 0, 90)).toBeCloseTo(90);
    expect(angleBetween(0, 179, 0, -179)).toBeCloseTo(2);
    expect(angleBetween(-10, 0, 10, 0)).toBeCloseTo(20);
  });
  it('is zero when the crosshair sits on the head', () => {
    const { td } = scenario({ visibleFrom: 100, view: () => onHead });
    expect(aimError(td, 0, 1, 50)).toBeCloseTo(0, 3);
  });
});

describe('engagement extraction (R-CD-1)', () => {
  it('opens at first visibility and records shot/damage/kill ticks', () => {
    const { engagements } = scenario({ visibleFrom: 100, view: () => onHead, shots: [110], hurtAt: 110, killAt: 110 });
    const e = engagements.find((x) => x.attacker === A)!;
    expect(e).toMatchObject({ startTick: 100, firstShotTick: 110, firstDamageTick: 110, killTick: 110, outcome: 'kill', distance: 1000 });
    expect(e.startError).toBeCloseTo(0, 2);
  });
  it('produces nothing without visibility', () => {
    const { engagements } = scenario({ visibleFrom: 10_000, view: () => onHead });
    expect(engagements.filter((e) => e.attacker === A)).toHaveLength(0);
  });
});

describe('indicators on synthetic engagements', () => {
  it('TTD = visible → first damage', () => {
    const { run } = scenario({ visibleFrom: 100, view: () => onHead, shots: [110], hurtAt: 110, killAt: 110 });
    const r = run('ttd');
    expect(r.samples).toBe(1);
    expect(r.metrics.median_ms).toBeCloseTo(10 * MS_PER_TICK, 1);
  });

  it('pre-aim: measured against the body center, not the head', () => {
    const onBody = anglesTo({ x: 0, y: 0, z: 64 }, { x: 1000, y: 0, z: 40 });
    expect(scenario({ visibleFrom: 100, view: () => onBody }).run('preaim').metrics).toMatchObject({ median_deg: 0, share_under_2deg: 1 });
    // Head is ~1.3° above the body center at 1000 u.
    expect(scenario({ visibleFrom: 100, view: () => onHead }).run('preaim').metrics.median_deg).toBeCloseTo(1.26, 1);
  });

  it('reaction: time until the crosshair starts moving toward the target', () => {
    // 30° off until tick 120, then sweeps onto the head at 300°/s.
    const view = (t: number) => ({ pitch: onHead.pitch, yaw: t < 120 ? 30 : Math.max(0, 30 - (t - 120) * (300 / 64)) });
    const { run } = scenario({ visibleFrom: 100, view });
    const r = run('reaction');
    expect(r.samples).toBe(1);
    expect(r.metrics.median_ms).toBeCloseTo(20 * MS_PER_TICK, 0);
    expect(r.metrics.share_under_150ms).toBe(0);
  });

  it('reaction: the victim walking into a still crosshair is not a reaction', () => {
    // Victim strafes from 500 u to the side onto the crosshair at 900 u/s (> 30°/s angular); the view never moves.
    const victim = (t: number) => ({ x: 1000, y: Math.max(0, 500 - Math.max(0, t - 100) * (900 / 64)), z: 0 });
    const { run, engagements } = scenario({ visibleFrom: 100, view: () => onHead, victimPos: victim });
    const e = engagements.find((x) => x.attacker === A)!;
    expect(e.errors[0] - e.errors[5]).toBeGreaterThan(2);
    expect(run('reaction').samples).toBe(0);
  });

  it('triggerbot: shot fired on the tick the crosshair enters the hitbox', () => {
    const view = (t: number) => ({ pitch: onHead.pitch, yaw: t < 130 ? 10 - (t - 100) * 0.3 : 0 });
    const { run } = scenario({ visibleFrom: 100, view, shots: [130] });
    const r = run('triggerbot');
    expect(r.samples).toBe(1);
    expect(r.metrics.share_within_1tick).toBe(1);
  });

  it('through-obstacle kills', () => {
    const { run } = scenario({ visibleFrom: 100, view: () => onHead, shots: [110], hurtAt: 110, killAt: 110 });
    expect(run('obstacles').metrics).toMatchObject({ obstacle_kill_share: 1, smoke_kill_share: 1, wallbang_kill_share: 0 });
  });

  it('every indicator declares id, version, description and a score spec (R-CD-4)', () => {
    const ids = new Set<string>();
    for (const i of INDICATORS) {
      expect(i.id).toMatch(/^[a-z_]+$/);
      expect(ids.has(i.id)).toBe(false);
      ids.add(i.id);
      expect(i.version).toBeGreaterThan(0);
      expect(i.description.length).toBeGreaterThan(20);
      expect(['low', 'high']).toContain(i.score.suspicious);
    }
  });
});

describe('counter-strafing', () => {
  // Three shot attempts 100 ticks apart; speed profile before each one is set per test.
  function strafe(profile: (tick: number, shot: number) => number) {
    const shots = [100, 200, 300];
    const { td, run } = scenario({ visibleFrom: 10_000, view: () => onHead, shots });
    for (const shot of shots) for (let t = shot - 40; t <= shot; t++) td.f.vel_x[t] = profile(t, shot);
    return run('counterstrafe').metrics;
  }
  it('counts a stop faster than friction as a counter-strafe', () => {
    // 250 → 0 in ~9 ticks (≈ 30 u/s per tick, friction alone allows ≈ 20 at 250 and less below).
    const m = strafe((t, shot) => Math.max(0, Math.min(250, (shot - 2 - t) * 30)));
    expect(m).toMatchObject({ accurate_share: 1, counterstrafe_share: 1, shot_attempts: 3 });
    // AK max speed 215 → accurate below 73.1 u/s, reached 4 ticks before the shot.
    expect(m.median_stop_to_shot_ms).toBeCloseTo(4 * MS_PER_TICK, 2);
  });
  it('a friction-only stop is accurate but not a counter-strafe', () => {
    const m = strafe((t, shot) => (t < shot - 30 ? 250 : 250 * (1 - 5.2 / 64) ** (t - (shot - 30))));
    expect(m).toMatchObject({ accurate_share: 1, counterstrafe_share: 0 });
  });
  it('uses the weapon max speed, scoped where it differs', () => {
    expect(weaponMaxSpeed('weapon_ak47', false)).toBe(215);
    expect(weaponMaxSpeed('weapon_awp', true)).toBe(100);
    expect(weaponMaxSpeed('weapon_ssg08', true)).toBe(230);
    expect(weaponMaxSpeed('weapon_knife', false)).toBeNull();
    // 80 u/s is accurate with a Glock (limit 81.6) but not with an AK (73.1).
    expect(strafe(() => 80)).toMatchObject({ accurate_share: 0 });
  });
  it('shooting while running is not accurate', () => {
    const m = strafe(() => 200);
    expect(m).toMatchObject({ accurate_share: 0, counterstrafe_share: null });
  });
});

describe('aim lock on hidden enemies', () => {
  // Attacker strafes along y, victim runs along y the other way 1000 u away: the line of sight sweeps.
  const attacker = (t: number) => ({ x: 0, y: 100 * Math.sin(t / 40), z: 0 });
  const victim = (t: number) => ({ x: 1000, y: 300 - t * 2, z: 0 });
  /** View that points `up` units above the victim's body centre (z + 40), plus `wobble(t)` units sideways. */
  const aimAt = (up: number, wobble: (t: number) => number = () => 0) => (t: number) => {
    const a = attacker(t);
    const v = victim(t);
    return anglesTo({ x: a.x, y: a.y, z: 64 }, { x: v.x, y: v.y + wobble(t), z: 40 + up });
  };
  function run(view: (t: number) => { pitch: number; yaw: number }, opts: { spotted?: (t: number) => boolean; still?: boolean } = {}) {
    const still = opts.still ? () => ({ x: 0, y: 0, z: 0 }) : null;
    const players: PlayerSpec[] = [
      { steamId: A, team: 2, pos: still ?? attacker, view },
      { steamId: V, team: 3, pos: opts.still ? () => ({ x: 1000, y: 0, z: 0 }) : victim, view: () => ({ pitch: 0, yaw: 180 }), spottedBy: (t) => (opts.spotted?.(t) ? [A] : []) },
    ];
    const td = makeTickData(400, players);
    const ctx: IndicatorContext = { td, rounds: oneRound(400), vis: new SpottedMaskVisibility(td), engagements: [], fires: [], hurts: [], deaths: [], bulletDamage: [], players: [A, V] };
    return INDICATORS.find((i) => i.id === 'aim_lock')!.compute(ctx).get(A)!;
  }
  const lockedBetween = (from: number, to: number) => (t: number) => t >= from && t < to;

  it('flags a crosshair glued to the head of a hidden, moving enemy', () => {
    const view = (t: number) => (lockedBetween(100, 200)(t) ? aimAt(22)(t) : { pitch: 0, yaw: 90 });
    const r = run(view);
    expect(r.metrics.locks).toBe(1);
    expect(r.metrics.longest_lock_ms).toBeCloseTo(100 * MS_PER_TICK, 0);
    expect(r.flags![0].note).toMatch(/head of hidden enemy/);
  });

  it('tolerates small jitter of the spot, but not a crosshair that slides over the body', () => {
    expect(run(aimAt(0, (t) => 1.5 * Math.sin(t))).metrics.locks).toBe(1);
    // Sliding from the left to the right side of the body over 2 s: on the body the whole time, never one spot.
    expect(run(aimAt(0, (t) => -14 + (t % 128) * (28 / 128))).metrics.locks).toBe(0);
  });

  it('holding an angle while the enemy walks through it is not a lock', () => {
    expect(run(() => aimAt(0)(200)).metrics.locks).toBe(0);
  });

  it('needs the enemy hidden, movement, and at least 1 s', () => {
    expect(run(aimAt(0), { spotted: () => true }).metrics.locks).toBe(0);
    const stillHead = anglesTo({ x: 0, y: 0, z: 64 }, { x: 1000, y: 0, z: 62 });
    expect(run(() => stillHead, { still: true }).metrics.locks).toBe(0);
    expect(run((t) => (lockedBetween(100, 150)(t) ? aimAt(0)(t) : { pitch: 0, yaw: 90 })).metrics).toMatchObject({ locks: 0, longest_lock_ms: 0 });
  });
});

import { describe, expect, it } from 'vitest';
import { extractEngagements } from '../src/analysis/engagements.ts';
import { aimError, angleBetween, anglesTo, MS_PER_TICK } from '../src/analysis/geometry.ts';
import { INDICATORS, type IndicatorContext } from '../src/analysis/indicators.ts';
import type { Row } from '../src/analysis/load.ts';
import { SpottedMaskVisibility } from '../src/analysis/visibility.ts';
import { makeTickData, oneRound, type PlayerSpec } from './synthetic.ts';

const A = '76561197960265729';
const V = '76561197960265730';
const victimPos = { x: 1000, y: 0, z: 0 };
const attackerPos = { x: 0, y: 0, z: 0 };
const onHead = anglesTo({ x: 0, y: 0, z: 64 }, { x: 1000, y: 0, z: 62 });

function scenario(opts: { visibleFrom: number; view: (t: number) => { pitch: number; yaw: number }; shots?: number[]; hurtAt?: number; killAt?: number }) {
  const players: PlayerSpec[] = [
    { steamId: A, team: 2, pos: () => attackerPos, view: opts.view },
    { steamId: V, team: 3, pos: () => victimPos, view: () => ({ pitch: 0, yaw: 180 }), spottedBy: (t) => (t >= opts.visibleFrom ? [A] : []) },
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

  it('pre-aim: crosshair already on the head at visibility', () => {
    const { run } = scenario({ visibleFrom: 100, view: () => onHead });
    expect(run('preaim').metrics.share_under_2deg).toBe(1);
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

  it('triggerbot: shot fired on the tick the crosshair enters the hitbox', () => {
    const view = (t: number) => ({ pitch: onHead.pitch, yaw: t < 130 ? 10 - (t - 100) * 0.3 : 0 });
    const { run } = scenario({ visibleFrom: 100, view, shots: [130] });
    const r = run('triggerbot');
    expect(r.samples).toBe(1);
    expect(r.metrics.share_within_1tick).toBe(1);
  });

  it('wall tracking: crosshair following a hidden enemy', () => {
    // Never visible, crosshair always on the head → every considered tick is on target.
    const { run } = scenario({ visibleFrom: 10_000, view: () => onHead });
    const r = run('wall_tracking');
    expect(r.samples).toBeGreaterThan(500);
    expect(r.metrics.occluded_on_target_share).toBe(1);
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

// Synthetic match data for indicator unit tests (R-NFR-6).
import { TICK_FIELDS, type TickData, type TickField } from '../src/analysis/load.ts';
import type { Round } from '../src/analysis/rounds.ts';

export interface PlayerSpec {
  steamId: string;
  team: 2 | 3;
  pos: (t: number) => { x: number; y: number; z: number };
  view: (t: number) => { pitch: number; yaw: number };
  /** Ticks where this player is in the spotted mask of the given players. */
  spottedBy?: (t: number) => string[];
}

export function makeTickData(maxTick: number, players: PlayerSpec[]): TickData {
  const stride = maxTick + 1;
  const size = players.length * stride;
  const f = Object.fromEntries(TICK_FIELDS.map((k) => [k, new Float32Array(size).fill(NaN)])) as Record<TickField, Float32Array>;
  const flags = { is_alive: new Uint8Array(size), ducking: new Uint8Array(size), is_scoped: new Uint8Array(size), is_airborne: new Uint8Array(size) };
  const spottedBy = new Uint32Array(size);
  const weapon = new Int16Array(size).fill(0);
  const present = new Uint8Array(size);
  players.forEach((p, i) => {
    for (let t = 0; t <= maxTick; t++) {
      const k = i * stride + t;
      const pos = p.pos(t);
      const v = p.view(t);
      f.x[k] = pos.x;
      f.y[k] = pos.y;
      f.z[k] = pos.z;
      f.pitch[k] = v.pitch;
      f.yaw[k] = v.yaw;
      f.vel_x[k] = 0;
      f.vel_y[k] = 0;
      f.vel_z[k] = 0;
      f.team_num[k] = p.team;
      f.health[k] = 100;
      f.flash_duration[k] = 0;
      f.aim_punch_pitch[k] = 0;
      f.aim_punch_yaw[k] = 0;
      f.shots_fired[k] = 0;
      flags.is_alive[k] = 1;
      present[k] = 1;
      let mask = 0;
      for (const sid of p.spottedBy?.(t) ?? []) mask |= 1 << players.findIndex((q) => q.steamId === sid);
      spottedBy[k] = mask;
    }
  });
  return {
    steamIds: players.map((p) => p.steamId),
    index: new Map(players.map((p, i) => [p.steamId, i])),
    names: players.map((p) => p.steamId),
    maxTick,
    f,
    flags,
    spottedBy,
    weapon,
    weaponNames: ['AK-47'],
    present,
    stride,
  };
}

export const oneRound = (end: number): Round[] => [{ round: 1, start: 0, freezeEnd: 1, buyEnd: 1, end, winnerSide: 2, winReason: 9, scoreT: 1, scoreCT: 0 }];

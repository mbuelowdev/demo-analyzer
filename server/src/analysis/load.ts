// Loads one match's Parquet data into compact in-memory structures for analysis.
import fs from 'node:fs';
import path from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import { sqlStr } from '../lib/duck.ts';

export type Row = Record<string, unknown>;

export function jsValue(v: unknown): unknown {
  if (typeof v === 'bigint') return Number(v);
  if (Array.isArray(v)) return v.map(jsValue);
  return v;
}

export async function queryRows(con: DuckDBConnection, sql: string): Promise<Row[]> {
  const r = await con.runAndReadAll(sql);
  return r.getRowObjectsJS().map((o) => {
    const out: Row = {};
    for (const [k, v] of Object.entries(o)) out[k] = jsValue(v);
    return out;
  });
}

export class MatchFiles {
  constructor(public dir: string) {}
  has(rel: string) {
    return fs.existsSync(path.join(this.dir, rel));
  }
  path(rel: string) {
    return sqlStr(path.join(this.dir, rel));
  }
  event(name: string) {
    return `events/${name}.parquet`;
  }
}

/** All rows of an event, ordered by tick; [] if the demo has no such event. */
export async function loadEvent(con: DuckDBConnection, files: MatchFiles, name: string): Promise<Row[]> {
  const rel = files.event(name);
  if (!files.has(rel)) return [];
  return queryRows(con, `SELECT * FROM read_parquet(${files.path(rel)}) ORDER BY tick`);
}

/** Per-tick fields loaded for analysis, as dense typed arrays indexed [player][tick]. */
export const TICK_FIELDS = [
  'x', 'y', 'z', 'pitch', 'yaw', 'vel_x', 'vel_y', 'vel_z', 'health', 'team_num', 'flash_duration',
  'aim_punch_pitch', 'aim_punch_yaw', 'shots_fired', 'money', 'equip_value',
] as const;
export type TickField = (typeof TICK_FIELDS)[number];
const FLAG_FIELDS = ['is_alive', 'ducking', 'is_scoped', 'is_airborne'] as const;
export type FlagField = (typeof FLAG_FIELDS)[number];

export interface TickData {
  /** Player SteamIDs; index = player slot used in all arrays. */
  steamIds: string[];
  index: Map<string, number>;
  names: string[];
  maxTick: number;
  /** f[field][player * stride + tick] */
  f: Record<TickField, Float32Array>;
  flags: Record<FlagField, Uint8Array>;
  /** Bitmask of player slots that have spotted this player (R-CD-2 v1 visibility source). */
  spottedBy: Uint32Array;
  /** Index into weaponNames, -1 = none. */
  weapon: Int16Array;
  weaponNames: string[];
  /** 1 where a row existed for that player/tick. */
  present: Uint8Array;
  stride: number;
}

export function at(td: TickData, p: number, tick: number): number {
  return p * td.stride + tick;
}

export async function loadTicks(con: DuckDBConnection, files: MatchFiles, steamIds: string[], maxTick: number): Promise<TickData> {
  const index = new Map(steamIds.map((s, i) => [s, i]));
  if (steamIds.length > 32) throw new Error('more than 32 players not supported by the spotted bitmask');
  const stride = maxTick + 1;
  const size = steamIds.length * stride;
  const f = Object.fromEntries(TICK_FIELDS.map((k) => [k, new Float32Array(size).fill(NaN)])) as Record<TickField, Float32Array>;
  const flags = Object.fromEntries(FLAG_FIELDS.map((k) => [k, new Uint8Array(size)])) as Record<FlagField, Uint8Array>;
  const spottedBy = new Uint32Array(size);
  const weapon = new Int16Array(size).fill(-1);
  const present = new Uint8Array(size);
  const names: string[] = new Array(steamIds.length).fill('');
  const weaponNames: string[] = [];
  const weaponIdx = new Map<string, number>();

  const cols = ['tick', 'steamid', 'name', 'weapon', 'spotted_by', ...TICK_FIELDS, ...FLAG_FIELDS];
  const result = await con.stream(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM read_parquet(${files.path('ticks.parquet')}) WHERE tick <= ${maxTick}`);
  for (;;) {
    const chunk = await result.fetchChunk();
    if (!chunk || chunk.rowCount === 0) break;
    const c = chunk.getColumns();
    const n = chunk.rowCount;
    for (let r = 0; r < n; r++) {
      const p = index.get(c[1][r] as string);
      if (p === undefined) continue;
      const tick = c[0][r] as number;
      const i = p * stride + tick;
      present[i] = 1;
      if (!names[p] && c[2][r]) names[p] = c[2][r] as string;
      const w = c[3][r] as string | null;
      if (w) {
        let wi = weaponIdx.get(w);
        if (wi === undefined) {
          wi = weaponNames.length;
          weaponNames.push(w);
          weaponIdx.set(w, wi);
        }
        weapon[i] = wi;
      }
      const sb = c[4][r] as { items: readonly unknown[] } | null;
      if (sb && sb.items.length) {
        let mask = 0;
        for (const s of sb.items) {
          const q = index.get(String(s));
          if (q !== undefined) mask |= 1 << q;
        }
        spottedBy[i] = mask >>> 0;
      }
      for (let k = 0; k < TICK_FIELDS.length; k++) {
        const v = c[5 + k][r];
        if (v !== null) f[TICK_FIELDS[k]][i] = v as number;
      }
      for (let k = 0; k < FLAG_FIELDS.length; k++) {
        if (c[5 + TICK_FIELDS.length + k][r]) flags[FLAG_FIELDS[k]][i] = 1;
      }
    }
  }
  return { steamIds, index, names, maxTick, f, flags, spottedBy, weapon, weaponNames, present, stride };
}

/** Inventory lists at specific ticks (for purchases and unused utility). */
export async function loadInventories(con: DuckDBConnection, files: MatchFiles, ticks: number[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!ticks.length) return out;
  const rows = await queryRows(
    con,
    `SELECT tick, steamid, inventory FROM read_parquet(${files.path('ticks.parquet')}) WHERE tick IN (${[...new Set(ticks)].join(',')})`,
  );
  for (const r of rows) out.set(`${r.tick}:${r.steamid}`, (r.inventory as string[] | null) ?? []);
  return out;
}

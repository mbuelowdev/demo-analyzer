// Full extraction of one .dem into per-match Parquet files (R-PARSE-2..4).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DuckDBConnection, DuckDBValue } from '@duckdb/node-api';
import { appendColumns, duckType, duckTypeSql, sqlStr, toDuck, withDuck } from '../lib/duck.ts';
import {
  EVENT_OTHER_EXTRA,
  EVENT_PLAYER_EXTRA,
  INPUT_HISTORY_FIELDS,
  INPUT_HISTORY_PROP,
  PARSER_VERSION,
  ROUND_PROPS,
  SCHEMA_VERSION,
  TICK_COLUMNS,
} from './schema.ts';

const require = createRequire(import.meta.url);
// The native binding is CommonJS; loaded lazily so the API process never maps it.
type Demoparser = typeof import('@laihoe/demoparser2');
let dp: Demoparser | null = null;
function parser(): Demoparser {
  return (dp ??= require('@laihoe/demoparser2') as Demoparser);
}

export const TICK_RATE = 64;

export interface ParseOptions {
  /** Ticks per parseTicks call (R-PARSE-4). 8192 ≈ 0.5 GB of parser output, see SPIKE.md. */
  tickChunk?: number;
  /** Extract usercmd input history (sub-tick view angles). Default true. */
  inputHistory?: boolean;
  tmpDir: string;
  duckMemoryLimit?: string;
  onProgress?: (msg: string) => void;
}

export interface ParseResult {
  header: Record<string, string>;
  parserVersion: string;
  schemaVersion: number;
  tickRate: number;
  maxTick: number;
  durationS: number;
  players: { steamid: string; name: string; team_number: number }[];
  eventCounts: Record<string, number>;
  tickRows: number;
  inputHistoryRows: number;
  grenadeRows: number;
  missingTickProps: string[];
  timingsMs: Record<string, number>;
  sizes: Record<string, number>;
}

export async function parseDemo(demPath: string, outDir: string, opts: ParseOptions): Promise<ParseResult> {
  const p = parser();
  const progress = opts.onProgress ?? (() => {});
  const timings: Record<string, number> = {};
  const time = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
    const t = performance.now();
    try {
      return await fn();
    } finally {
      timings[name] = Math.round(performance.now() - t);
    }
  };

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, 'events'), { recursive: true });
  fs.mkdirSync(opts.tmpDir, { recursive: true });

  const header = (await time('header', () => p.parseHeader(demPath))) as Record<string, string>;
  const players = (await time('playerInfo', () => p.parsePlayerInfo(demPath))) as ParseResult['players'];
  const duckFile = path.join(opts.tmpDir, `parse-${process.pid}-${Date.now()}.duckdb`);

  try {
    return await withDuck(
      async (con) => {
        // ---- events ----
        progress('events');
        const eventNames = (await time('listEvents', () => p.listGameEvents(demPath))) as string[];
        const events = (await time('parseEvents', () =>
          p.parseEvents(demPath, eventNames, EVENT_PLAYER_EXTRA, EVENT_OTHER_EXTRA),
        )) as Record<string, unknown>[];
        const byName = new Map<string, Record<string, unknown>[]>();
        let maxEventTick = 0;
        for (const e of events) {
          const name = String(e.event_name);
          if (typeof e.tick === 'number' && e.tick > maxEventTick) maxEventTick = e.tick;
          if (e.round === undefined && typeof e.total_rounds_played === 'number') e.round = e.total_rounds_played + 1;
          let arr = byName.get(name);
          if (!arr) byName.set(name, (arr = []));
          arr.push(e);
        }
        const eventCounts: Record<string, number> = {};
        await time('writeEvents', async () => {
          for (const [name, rows] of byName) {
            if (!/^[a-z0-9_]+$/.test(name)) continue;
            eventCounts[name] = rows.length;
            await writeJsonRows(con, rows, path.join(outDir, 'events', `${name}.parquet`), opts.tmpDir);
          }
        });
        byName.clear();
        events.length = 0;

        // ---- per-tick state ----
        const maxTick = maxEventTick + TICK_RATE * 2;
        const withHistory = opts.inputHistory ?? true;
        const props = [...new Set(TICK_COLUMNS.map((c) => c.prop))];
        if (withHistory) props.push(INPUT_HISTORY_PROP);
        const tickChunk = opts.tickChunk ?? 8192;
        const colsSql = TICK_COLUMNS.map((c) => `"${c.col}" ${duckTypeSql(c.type)}`).join(', ');
        await con.run(`CREATE TABLE ticks (tick INTEGER, round INTEGER, steamid VARCHAR, name VARCHAR, ${colsSql})`);
        const types = [duckType('int'), duckType('int'), duckType('varchar'), duckType('varchar'), ...TICK_COLUMNS.map((c) => duckType(c.type))];
        await con.run(
          `CREATE TABLE usercmd_history (tick INTEGER, steamid VARCHAR, idx INTEGER, ${INPUT_HISTORY_FIELDS.map((f) => `"${f}" ${f.endsWith('count') ? 'INTEGER' : 'FLOAT'}`).join(', ')})`,
        );
        const histTypes = [duckType('int'), duckType('varchar'), duckType('int'), ...INPUT_HISTORY_FIELDS.map((f) => duckType(f.endsWith('count') ? 'int' : 'float'))];
        const seenProps = new Set<string>();
        let tickRows = 0;
        let inputHistoryRows = 0;
        await time('ticks', async () => {
          for (let start = 0; start <= maxTick; start += tickChunk) {
            const end = Math.min(maxTick + 1, start + tickChunk);
            progress(`ticks ${start}-${end} of ${maxTick}`);
            // One tick of overlap: demoparser2 derives velocity from the previous *requested* tick.
            const from = Math.max(0, start - 1);
            const wanted = Array.from({ length: end - from }, (_, i) => from + i);
            const soa = p.parseTicks(demPath, props, wanted, null, true) as Record<string, unknown[]> | null;
            if (!soa || !soa.tick) continue;
            for (const k of Object.keys(soa)) seenProps.add(k);
            // Drop the overlap tick.
            const tickArr = soa.tick as number[];
            let first = 0;
            if (start > 0) while (first < tickArr.length && tickArr[first] < start) first++;
            const n = tickArr.length - first;
            if (n <= 0) continue;
            const roundsArr = (soa.total_rounds_played ?? []) as (number | null)[];
            const slice = (col: number, s: number, e: number): DuckDBValue[] => {
              const out: DuckDBValue[] = new Array(e - s);
              for (let i = s; i < e; i++) {
                const r = first + i;
                if (col === 0) out[i - s] = tickArr[r];
                else if (col === 1) out[i - s] = typeof roundsArr[r] === 'number' ? (roundsArr[r] as number) + 1 : null;
                else if (col === 2) out[i - s] = toDuck('varchar', (soa.steamid as unknown[])[r]);
                else if (col === 3) out[i - s] = toDuck('varchar', (soa.name as unknown[])[r]);
                else {
                  const c = TICK_COLUMNS[col - 4];
                  const arr = soa[c.prop];
                  out[i - s] = arr ? toDuck(c.type, arr[r], c.index) : null;
                }
              }
              return out;
            };
            await appendColumns(con, 'ticks', types, slice, n);
            tickRows += n;
            const hist = soa[INPUT_HISTORY_PROP] as (Record<string, number>[] | null)[] | undefined;
            if (hist) {
              const flat: DuckDBValue[][] = histTypes.map(() => []);
              for (let r = first; r < tickArr.length; r++) {
                const entries = hist[r];
                if (!Array.isArray(entries)) continue;
                entries.forEach((h, idx) => {
                  flat[0].push(tickArr[r]);
                  flat[1].push(toDuck('varchar', (soa.steamid as unknown[])[r]));
                  flat[2].push(idx);
                  INPUT_HISTORY_FIELDS.forEach((f, j) => flat[3 + j].push(toDuck(f.endsWith('count') ? 'int' : 'float', h?.[f])));
                });
              }
              const rows = flat[0].length;
              await appendColumns(con, 'usercmd_history', histTypes, (c, s0, e0) => flat[c].slice(s0, e0), rows);
              inputHistoryRows += rows;
            }
            // Without a checkpoint the appended rows pile up as native memory outside memory_limit:
            // peak RSS 2.4 GB → 1.5 GB at the same speed (SPIKE.md, "Small hosts").
            await con.run('CHECKPOINT');
            (globalThis as { gc?: () => void }).gc?.();
          }
        });
        progress('writing ticks.parquet');
        await time('writeTicks', () =>
          con.run(`COPY ticks TO ${sqlStr(path.join(outDir, 'ticks.parquet'))} (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 122880)`),
        );
        await con.run('DROP TABLE ticks');
        if (inputHistoryRows > 0) {
          await time('writeUsercmd', () =>
            con.run(`COPY usercmd_history TO ${sqlStr(path.join(outDir, 'usercmd_history.parquet'))} (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 122880)`),
          );
        }
        await con.run('DROP TABLE usercmd_history');
        const missingTickProps = props.filter((pr) => !seenProps.has(pr));

        // ---- round snapshots ----
        // MM GOTV demos carry no round_end event; sample game state just before each round_officially_ended
        // and at the last tick so scores, win reasons and economy can be derived (see SPIKE.md).
        progress('rounds');
        const roundEnds = eventCounts.round_officially_ended ? await readEventTicks(con, outDir, 'round_officially_ended') : [];
        // The last round has no round_officially_ended and entities are gone at the very end: sample at the win panel too.
        const winPanel = eventCounts.cs_win_panel_match ? await readEventTicks(con, outDir, 'cs_win_panel_match') : [];
        const sampleTicks = [...new Set([...roundEnds.map((t) => t - 1), ...winPanel.flatMap((t) => [t - 1, t]), maxTick - TICK_RATE])]
          .filter((t) => t > 0)
          .sort((a, b) => a - b);
        await time('rounds', async () => {
          const rows = sampleTicks.length ? (p.parseTicks(demPath, ROUND_PROPS, sampleTicks) as Record<string, unknown>[]) : [];
          await writeJsonRows(con, rows, path.join(outDir, 'round_snapshots.parquet'), opts.tmpDir);
        });

        // ---- grenades ----
        progress('grenades');
        let grenadeRows = 0;
        await time('grenades', async () => {
          // grenades=false skips held (non-projectile) grenades: same trajectory rows, 1/6 of the memory (SPIKE.md).
          const g = (p.parseGrenades(demPath, null, false) as Record<string, unknown>[]).filter((r) => r.x !== null && r.x !== undefined);
          grenadeRows = g.length;
          await writeJsonRows(con, g, path.join(outDir, 'grenades.parquet'), opts.tmpDir);
        });

        // ---- players ----
        await writeJsonRows(con, players, path.join(outDir, 'players.parquet'), opts.tmpDir);

        const result: ParseResult = {
          header,
          parserVersion: PARSER_VERSION,
          schemaVersion: SCHEMA_VERSION,
          tickRate: TICK_RATE,
          maxTick,
          durationS: maxTick / TICK_RATE,
          players,
          eventCounts,
          tickRows,
          inputHistoryRows,
          grenadeRows,
          missingTickProps,
          timingsMs: timings,
          sizes: {},
        };
        fs.writeFileSync(path.join(outDir, 'header.json'), JSON.stringify(result, null, 1));
        result.sizes = folderSizes(outDir);
        fs.writeFileSync(path.join(outDir, 'header.json'), JSON.stringify(result, null, 1));
        return result;
      },
      { path: duckFile, memoryLimit: opts.duckMemoryLimit ?? '128MB', threads: 2, tempDir: opts.tmpDir },
    );
  } finally {
    for (const f of [duckFile, `${duckFile}.wal`]) fs.rmSync(f, { force: true });
  }
}

/** Writes heterogeneous JSON rows to Parquet via a temporary NDJSON file; DuckDB infers the schema. */
export async function writeJsonRows(con: DuckDBConnection, rows: unknown[], out: string, tmpDir: string) {
  const tmp = path.join(tmpDir, `rows-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.ndjson`);
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      let buf: string[] = [];
      for (const r of rows) {
        buf.push(JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
        if (buf.length >= 5000) {
          fs.writeSync(fd, buf.join('\n') + '\n');
          buf = [];
        }
      }
      if (buf.length) fs.writeSync(fd, buf.join('\n') + '\n');
    } finally {
      fs.closeSync(fd);
    }
    if (rows.length === 0) {
      await con.run(`COPY (SELECT NULL::INTEGER AS tick WHERE false) TO ${sqlStr(out)} (FORMAT parquet)`);
      return;
    }
    await con.run(
      `COPY (SELECT * FROM read_json(${sqlStr(tmp)}, format = 'newline_delimited', sample_size = -1, union_by_name = true))
       TO ${sqlStr(out)} (FORMAT parquet, COMPRESSION zstd)`,
    );
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function readEventTicks(con: DuckDBConnection, outDir: string, name: string): Promise<number[]> {
  const r = await con.runAndReadAll(`SELECT DISTINCT tick FROM read_parquet(${sqlStr(path.join(outDir, 'events', `${name}.parquet`))}) ORDER BY tick`);
  return r.getRowObjectsJS().map((x) => Number(x.tick));
}

function folderSizes(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  let total = 0;
  const walk = (d: string, prefix: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, `${prefix}${e.name}/`);
      else {
        const s = fs.statSync(full).size;
        total += s;
        if (prefix === 'events/') out['events/*'] = (out['events/*'] ?? 0) + s;
        else out[prefix + e.name] = s;
      }
    }
  };
  walk(dir, '');
  out.total = total;
  return out;
}

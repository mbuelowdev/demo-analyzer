import {
  BOOLEAN,
  DOUBLE,
  DuckDBConnection,
  DuckDBDataChunk,
  DuckDBInstance,
  FLOAT,
  INTEGER,
  LIST,
  UBIGINT,
  VARCHAR,
  listValue,
  type DuckDBType,
  type DuckDBValue,
} from '@duckdb/node-api';
import type { ColType } from '../parse/schema.ts';

export interface DuckOptions {
  memoryLimit?: string;
  threads?: number;
  tempDir?: string;
}

/** Opens a DuckDB instance (in-memory or file), runs fn, always closes. */
export async function withDuck<T>(fn: (con: DuckDBConnection) => Promise<T>, opts: DuckOptions & { path?: string } = {}): Promise<T> {
  const options: Record<string, string> = {};
  if (opts.memoryLimit) options.memory_limit = opts.memoryLimit;
  if (opts.threads) options.threads = String(opts.threads);
  if (opts.tempDir) options.temp_directory = opts.tempDir;
  const inst = await DuckDBInstance.create(opts.path ?? ':memory:', options);
  const con = await inst.connect();
  try {
    return await fn(con);
  } finally {
    con.closeSync();
    inst.closeSync();
  }
}

export function sqlStr(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

export function duckType(t: ColType): DuckDBType {
  switch (t) {
    case 'float':
      return FLOAT;
    case 'int':
      return INTEGER;
    case 'bool':
      return BOOLEAN;
    case 'ubigint':
      return UBIGINT;
    case 'list_varchar':
      return LIST(VARCHAR);
    case 'varchar':
    case 'json':
      return VARCHAR;
  }
}

export function duckTypeSql(t: ColType | 'double'): string {
  switch (t) {
    case 'float':
      return 'FLOAT';
    case 'double':
      return 'DOUBLE';
    case 'int':
      return 'INTEGER';
    case 'bool':
      return 'BOOLEAN';
    case 'ubigint':
      return 'UBIGINT';
    case 'list_varchar':
      return 'VARCHAR[]';
    case 'varchar':
    case 'json':
      return 'VARCHAR';
  }
}

export { DOUBLE };

/** Converts a raw demoparser2 value to the DuckDB value for a column type. Unparseable → NULL. */
export function toDuck(t: ColType, v: unknown, index?: number): DuckDBValue {
  if (v === null || v === undefined) return null;
  if (index !== undefined) {
    if (!Array.isArray(v)) return null;
    v = v[index];
    if (v === null || v === undefined) return null;
  }
  switch (t) {
    case 'float':
    case 'int': {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) return null;
      return t === 'int' ? Math.trunc(n) : n;
    }
    case 'bool':
      return Boolean(v);
    case 'ubigint':
      try {
        return BigInt(v as string | number);
      } catch {
        return null;
      }
    case 'varchar':
      return String(v);
    case 'json':
      return JSON.stringify(v);
    case 'list_varchar':
      return Array.isArray(v) ? listValue(v.map((x) => String(x))) : null;
  }
}

const CHUNK = 2048;

/**
 * Appends column-major data to a table in DuckDB vector-sized chunks. `slice(col, start, end)`
 * converts only one chunk at a time so a large parse batch is never duplicated in memory.
 */
export async function appendColumns(
  con: DuckDBConnection,
  table: string,
  types: DuckDBType[],
  slice: (col: number, start: number, end: number) => DuckDBValue[],
  rowCount: number,
) {
  const appender = await con.createAppender(table);
  try {
    for (let start = 0; start < rowCount; start += CHUNK) {
      const end = Math.min(rowCount, start + CHUNK);
      const chunk = DuckDBDataChunk.create(types, end - start);
      chunk.setColumns(types.map((_, i) => slice(i, start, end)));
      appender.appendDataChunk(chunk);
    }
    appender.flushSync();
  } finally {
    appender.closeSync();
  }
}

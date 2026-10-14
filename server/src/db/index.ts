import Database from 'better-sqlite3';
import { MAP_SEED } from '../../../shared/src/maps.ts';
import { MIGRATIONS } from './migrations.ts';

export type DB = Database.Database;

export const now = () => Date.now();

export function openDb(file: string): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  seed(db);
  return db;
}

function migrate(db: DB) {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}

function seed(db: DB) {
  const ins = db.prepare('INSERT OR IGNORE INTO maps (name, display_name, pools) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (const m of MAP_SEED) ins.run(m.name, m.displayName, m.pools);
  })();
}

export function kvSet(db: DB, key: string, value: string) {
  db.prepare(
    'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(key, value, now());
}

export function kvGet(db: DB, key: string): { value: string; updated_at: number } | undefined {
  return db.prepare('SELECT value, updated_at FROM kv WHERE key = ?').get(key) as { value: string; updated_at: number } | undefined;
}

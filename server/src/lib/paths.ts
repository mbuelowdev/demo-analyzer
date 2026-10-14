import fs from 'node:fs';
import path from 'node:path';

/** Layout of the data volume (spec "Storage layout"). Generated names only (R-SEC-4). */
export function dataPaths(dataDir: string) {
  return {
    root: dataDir,
    db: path.join(dataDir, 'app.sqlite'),
    raw: path.join(dataDir, 'raw'),
    tmp: path.join(dataDir, 'tmp'),
    matches: path.join(dataDir, 'matches'),
    maps: path.join(dataDir, 'maps'),
    rawFile: (demoId: number, ext: 'bz2' | 'zst') => path.join(dataDir, 'raw', `${demoId}.dem.${ext}`),
    matchDir: (demoId: number) => path.join(dataDir, 'matches', String(demoId)),
    mapFile: (name: string) => path.join(dataDir, 'maps', `${name}.vpk`),
  };
}

export type DataPaths = ReturnType<typeof dataPaths>;

export function ensureDataDirs(p: DataPaths) {
  for (const d of [p.root, p.raw, p.tmp, p.matches, p.maps]) fs.mkdirSync(d, { recursive: true });
}

export function dirSize(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else if (e.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

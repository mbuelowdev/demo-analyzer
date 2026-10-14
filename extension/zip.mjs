// R-EXT-5: packs dist/ into a zip that the app serves for download.
import fs from 'node:fs';
import path from 'node:path';
import { zipSync } from 'fflate';

const dist = path.resolve(import.meta.dirname, 'dist');
const out = path.join(dist, 'demo-analyzer-extension.zip');
const files = {};
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (full === out) continue;
    if (e.isDirectory()) walk(full);
    else files[path.relative(dist, full).split(path.sep).join('/')] = fs.readFileSync(full);
  }
};
walk(dist);
fs.writeFileSync(out, zipSync(files, { level: 9 }));
console.log(`wrote ${out} (${Object.keys(files).length} files)`);

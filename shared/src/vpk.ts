// Minimal Valve VPK (v1/v2) directory reader, used for R-MAP-3 auto-detection and R-MAP-4 validation.
export const VPK_MAGIC = 0x55aa1234;

export function isVpkHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) === VPK_MAGIC;
}

/**
 * Lists the directory paths in a VPK tree. `bytes` must hold at least the header and the tree
 * (the tree sits at the start of the file). Returns null if the header is invalid; stops quietly
 * if the buffer ends early.
 */
export function vpkPaths(bytes: Uint8Array): string[] | null {
  if (!isVpkHeader(bytes) || bytes.length < 12) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint32(4, true);
  const treeSize = dv.getUint32(8, true);
  const headerSize = version === 2 ? 28 : version === 1 ? 12 : -1;
  if (headerSize < 0) return null;
  const end = Math.min(bytes.length, headerSize + treeSize);
  let pos = headerSize;
  const dec = new TextDecoder();
  const readStr = (): string | null => {
    const start = pos;
    while (pos < end && bytes[pos] !== 0) pos++;
    if (pos >= end) return null;
    const s = dec.decode(bytes.subarray(start, pos));
    pos++;
    return s;
  };
  const paths = new Set<string>();
  outer: for (;;) {
    const ext = readStr();
    if (ext === null || ext === '') break;
    for (;;) {
      const dir = readStr();
      if (dir === null) break outer;
      if (dir === '') break;
      for (;;) {
        const name = readStr();
        if (name === null) break outer;
        if (name === '') break;
        paths.add(dir === ' ' ? `${name}.${ext}` : `${dir}/${name}.${ext}`);
        if (pos + 18 > end) break outer;
        const preload = dv.getUint16(pos + 4, true);
        pos += 18 + preload;
      }
    }
  }
  return [...paths];
}

/** Known map names referenced as `maps/<name>/…` or `maps/<name>.vmap_c` inside the VPK. */
export function mapsInVpk(paths: string[], known: string[]): string[] {
  const set = new Set(known);
  const found = new Set<string>();
  for (const p of paths) {
    const m = /^maps\/([a-z0-9_]+)(?:\/|\.vmap_c$)/.exec(p);
    if (m && set.has(m[1])) found.add(m[1]);
  }
  return [...found];
}

/** R-MAP-3: exact file-name match first, then a single unambiguous internal path match. */
export function detectMap(fileName: string, paths: string[] | null, known: string[]): string | null {
  const base = fileName.toLowerCase().replace(/\.vpk$/, '');
  if (known.includes(base)) return base;
  if (!paths) return null;
  const hits = mapsInVpk(paths, known);
  return hits.length === 1 ? hits[0] : null;
}

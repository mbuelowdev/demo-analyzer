import { describe, expect, it } from 'vitest';
import { parseReplayUrl } from '../src/replay.ts';
import { accountIdToSteamId64, isSteamId64 } from '../src/steam.ts';
import { detectMap, isVpkHeader, mapsInVpk, vpkPaths } from '../src/vpk.ts';

describe('replay URLs (R-DL-1, R-SEC-3)', () => {
  it('extracts match identity', () => {
    const r = parseReplayUrl('http://replay100.valve.net/730/003800000000000000001_0100000001.dem.bz2');
    expect(r).toMatchObject({ matchId: '003800000000000000001', outcomeId: '0100000001', key: '003800000000000000001_0100000001' });
  });
  it('rejects anything else', () => {
    for (const u of [
      'http://replay181.valve.net.evil.com/730/1_2.dem.bz2',
      'http://evil.com/730/1_2.dem.bz2',
      'http://replay181.valve.net/570/1_2.dem.bz2',
      'http://replay181.valve.net/730/1_2.dem.bz2?x=1',
      'file:///etc/passwd',
      'http://127.0.0.1/730/1_2.dem.bz2',
    ])
      expect(parseReplayUrl(u)).toBeNull();
  });
});

describe('steam ids', () => {
  it('converts account ids', () => {
    expect(accountIdToSteamId64('1')).toBe('76561197960265729');
    expect(accountIdToSteamId64('1000000000')).toBe('76561198960265728');
    expect(isSteamId64('76561198960265728')).toBe(true);
    expect(accountIdToSteamId64('abc')).toBeNull();
  });
});

function buildVpk(entries: [string, string, string][]): Uint8Array {
  // v2 header + tree: ext \0 path \0 name \0 + 18-byte entry, terminators.
  const enc = new TextEncoder();
  const tree: number[] = [];
  const byExt = new Map<string, Map<string, string[]>>();
  for (const [ext, dir, name] of entries) {
    if (!byExt.has(ext)) byExt.set(ext, new Map());
    const d = byExt.get(ext)!;
    if (!d.has(dir)) d.set(dir, []);
    d.get(dir)!.push(name);
  }
  const str = (s: string) => tree.push(...enc.encode(s), 0);
  for (const [ext, dirs] of byExt) {
    str(ext);
    for (const [dir, names] of dirs) {
      str(dir);
      for (const n of names) {
        str(n);
        tree.push(0, 0, 0, 0, 0, 0, 0xff, 0x7f, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff);
      }
      tree.push(0);
    }
    tree.push(0);
  }
  tree.push(0);
  const out = new Uint8Array(28 + tree.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x55aa1234, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, tree.length, true);
  out.set(tree, 28);
  return out;
}

describe('VPK (R-MAP-3, R-MAP-4)', () => {
  const vpk = buildVpk([
    ['vmap_c', 'maps', 'de_dust2'],
    ['vphys_c', 'maps/de_dust2', 'world_physics'],
    ['vtex_c', 'materials/foo', 'bar'],
  ]);
  it('validates the magic', () => {
    expect(isVpkHeader(vpk)).toBe(true);
    expect(isVpkHeader(new Uint8Array([1, 2, 3, 4]))).toBe(false);
  });
  it('lists paths and detects maps', () => {
    const paths = vpkPaths(vpk)!;
    expect(paths).toContain('maps/de_dust2.vmap_c');
    expect(mapsInVpk(paths, ['de_dust2', 'de_mirage'])).toEqual(['de_dust2']);
    expect(detectMap('whatever.vpk', paths, ['de_dust2', 'de_mirage'])).toBe('de_dust2');
    expect(detectMap('de_mirage.vpk', null, ['de_dust2', 'de_mirage'])).toBe('de_mirage');
    expect(detectMap('x.vpk', [], ['de_dust2'])).toBeNull();
  });
});

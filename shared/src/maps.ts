// R-MAP-1 seed list (checked against a real CS2 install on 2026-10-14).
export interface MapSeed {
  name: string;
  displayName: string;
  pools: string;
}

export const MAP_SEED: MapSeed[] = [
  { name: 'de_ancient', displayName: 'Ancient', pools: 'Premier, Competitive' },
  { name: 'de_anubis', displayName: 'Anubis', pools: 'Premier, Competitive' },
  { name: 'de_cache', displayName: 'Cache', pools: 'Premier, Competitive' },
  { name: 'de_dust2', displayName: 'Dust II', pools: 'Premier, Competitive' },
  { name: 'de_inferno', displayName: 'Inferno', pools: 'Premier, Competitive' },
  { name: 'de_mirage', displayName: 'Mirage', pools: 'Premier, Competitive' },
  { name: 'de_nuke', displayName: 'Nuke', pools: 'Premier, Competitive' },
  { name: 'de_overpass', displayName: 'Overpass', pools: 'Competitive' },
  { name: 'de_train', displayName: 'Train', pools: 'Competitive' },
  { name: 'de_vertigo', displayName: 'Vertigo', pools: 'Competitive' },
  { name: 'cs_office', displayName: 'Office', pools: 'Competitive (hostage)' },
  { name: 'cs_italy', displayName: 'Italy', pools: 'Competitive (hostage)' },
  { name: 'de_boulder', displayName: 'Boulder', pools: 'Competitive (community)' },
  { name: 'de_fachwerk', displayName: 'Fachwerk', pools: 'Competitive (community)' },
  { name: 'cs_shelter', displayName: 'Shelter', pools: 'Competitive (community)' },
  { name: 'rush_001', displayName: 'Rush arenas', pools: 'Rush' },
  { name: 'de_ancient_night', displayName: 'Ancient (night)', pools: 'other / casual' },
  { name: 'de_debris', displayName: 'Debris', pools: 'other / casual' },
  { name: 'de_eldorado', displayName: 'Eldorado', pools: 'other / casual' },
  { name: 'de_poseidon', displayName: 'Poseidon', pools: 'other / casual' },
  { name: 'ar_baggage', displayName: 'Baggage', pools: 'Arms Race' },
  { name: 'ar_pool_day', displayName: 'Pool Day', pools: 'Arms Race' },
  { name: 'ar_shoots', displayName: 'Shoots', pools: 'Arms Race' },
  { name: 'ar_shoots_night', displayName: 'Shoots (night)', pools: 'Arms Race' },
];

export const MAP_NAME_RE = /^[a-z0-9_]{2,64}$/;

/** `*_vanity` files are main-menu scenes and never offered (R-MAP spec note). */
export function isVanityMap(name: string): boolean {
  return name.endsWith('_vanity');
}

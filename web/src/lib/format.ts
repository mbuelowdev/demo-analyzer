export const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '–');
export const fmtDay = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '–');
export const num = (v: number | null | undefined, digits = 0) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(digits));
export const pct = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? '–' : `${(v * 100).toFixed(digits)}%`);

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export const MAP_NAMES: Record<string, string> = {
  de_ancient: 'Ancient', de_anubis: 'Anubis', de_cache: 'Cache', de_dust2: 'Dust II', de_inferno: 'Inferno', de_mirage: 'Mirage', de_nuke: 'Nuke',
  de_overpass: 'Overpass', de_train: 'Train', de_vertigo: 'Vertigo', cs_office: 'Office', cs_italy: 'Italy', rush_001: 'Rush',
};
export const mapName = (m: string | null | undefined) => (m ? (MAP_NAMES[m] ?? m) : '–');
export const modeName = (m: string) => ({ premier: 'Premier', competitive: 'Competitive', wingman: 'Wingman', rush: 'Rush', unknown: '–' })[m] ?? m;

/** Formats an indicator metric by its naming convention: shares/rates as %, *_ms as ms, *_deg as °. */
export function fmtMetric(key: string, v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  const k = key.split('|')[0];
  if (k.startsWith('share') || k.endsWith('_rate') || k.endsWith('_share') || k.startsWith('hs_rate')) return `${(v * 100).toFixed(0)}%`;
  if (k.endsWith('_ms')) return `${v.toFixed(0)} ms`;
  if (k.endsWith('_deg')) return `${v.toFixed(1)}°`;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

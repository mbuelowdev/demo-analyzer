export const STEAMID64_BASE = 76561197960265728n;
export const STEAMID64_RE = /^7656119\d{10}$/;

export function accountIdToSteamId64(accountId: string | number): string | null {
  const s = String(accountId).trim();
  if (!/^\d{1,10}$/.test(s)) return null;
  return (STEAMID64_BASE + BigInt(s)).toString();
}

export function isSteamId64(s: unknown): s is string {
  return typeof s === 'string' && STEAMID64_RE.test(s);
}

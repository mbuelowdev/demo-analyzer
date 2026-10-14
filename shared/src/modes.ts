export const MATCH_MODES = ['premier', 'competitive', 'wingman', 'rush', 'unknown'] as const;
export type MatchMode = (typeof MATCH_MODES)[number];

export const GCPD_BASE = 'https://steamcommunity.com/my/gcpd/730/';

/** Flyout option → GCPD tab (spec table under "Chromium extension"). */
export const GCPD_TABS: Record<Exclude<MatchMode, 'unknown'>, string> = {
  premier: 'matchhistorypremier',
  competitive: 'matchhistorycompetitivepermap',
  wingman: 'matchhistorywingman',
  rush: 'matchhistoryrush',
};

export function modeFromTab(tab: string | null | undefined): MatchMode {
  for (const [mode, t] of Object.entries(GCPD_TABS)) if (t === tab) return mode as MatchMode;
  return 'unknown';
}

export const MATCH_STATUSES = ['queued', 'downloading', 'parsing', 'analysing', 'analysed', 'failed', 'expired'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

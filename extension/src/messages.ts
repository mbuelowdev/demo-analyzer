import type { IngestResponse } from '../../shared/src/api.ts';
import type { MatchMode } from '../../shared/src/modes.ts';

export interface Settings {
  appUrl: string;
  apiKey: string;
}

export const DEFAULT_SETTINGS: Settings = { appUrl: 'https://demo-analyzer.mbuelow.dev', apiKey: '' };

export interface LastResult {
  at: number;
  source: 'gcpd' | 'manual';
  mode?: MatchMode;
  ok: boolean;
  error?: string;
  found?: number;
  rowsWithoutReplay?: number;
  response?: IngestResponse;
  stage?: string;
}

export type Message =
  | { type: 'open-gcpd'; mode: Exclude<MatchMode, 'unknown'> }
  | { type: 'scan-active-tab' }
  | { type: 'manual-urls'; urls: string[] }
  | { type: 'should-auto-scan' }
  | { type: 'scraped'; mode: MatchMode; result: import('./scraper.ts').ScrapeResult }
  | { type: 'scrape-failed'; error: string }
  | { type: 'progress'; stage: string }
  | { type: 'scan' };

export async function getSettings(): Promise<Settings> {
  const s = await chrome.storage.sync.get({ ...DEFAULT_SETTINGS } as Record<string, unknown>);
  return { appUrl: String(s.appUrl || DEFAULT_SETTINGS.appUrl).replace(/\/$/, ''), apiKey: String(s.apiKey || '') };
}

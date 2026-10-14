// GCPD match-history scraper. R-EXT-6: every Steam selector lives in SELECTORS, and failures throw
// a clear ScrapeError instead of silently sending nothing. Pure DOM code, tested against the saved page.
import type { ScrapedMatch, ScrapedPlayer } from '../../shared/src/api.ts';
import { accountIdToSteamId64 } from '../../shared/src/steam.ts';

export const SELECTORS = {
  table: '.generic_kv_table.csgo_scoreboard_root',
  leftCell: ':scope > td.val_left',
  leftInfoCells: 'table.csgo_scoreboard_inner_left td',
  replayLink: 'a[href*=".dem.bz2"]',
  rightTable: 'table.csgo_scoreboard_inner_right',
  playerNameCell: 'td.inner_name',
  scoreCell: 'td.csgo_scoreboard_score',
  playerLink: '.playerNickname a, a.linkTitle',
  loadMore: '#load_more_clickable',
} as const;

export class ScrapeError extends Error {}

export interface ScrapeResult {
  matches: ScrapedMatch[];
  /** Match rows found on the page (with or without a replay link). */
  rowCount: number;
  rowsWithoutReplay: number;
  ownSteamId: string | null;
}

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

export function findTable(doc: Document): HTMLTableElement | null {
  return doc.querySelector<HTMLTableElement>(SELECTORS.table);
}

/** Match rows of the scoreboard table (rows with the left info cell). */
export function matchRows(table: HTMLTableElement): HTMLTableRowElement[] {
  return [...table.rows].filter((r) => r.parentElement?.closest('table') === table && r.querySelector(SELECTORS.leftCell));
}

export function ownSteamId(doc: Document): string | null {
  for (const s of doc.querySelectorAll('script')) {
    const m = /g_steamID\s*=\s*"(\d{17})"/.exec(s.textContent ?? '');
    if (m) return m[1];
  }
  return null;
}

function parsePlayers(row: HTMLTableRowElement): ScrapedPlayer[] {
  const right = row.querySelector(SELECTORS.rightTable);
  if (!right) return [];
  const players: ScrapedPlayer[] = [];
  let team: 0 | 1 = 0;
  for (const tr of right.querySelectorAll('tr')) {
    if (tr.querySelector(SELECTORS.scoreCell)) {
      team = 1;
      continue;
    }
    if (!tr.querySelector(SELECTORS.playerNameCell)) continue;
    const cells = [...tr.children].filter((c) => c.tagName === 'TD');
    const link = tr.querySelector<HTMLAnchorElement>(SELECTORS.playerLink);
    const mini = link?.getAttribute('data-miniprofile');
    players.push({
      name: text(link) || text(cells[0]),
      steamId: mini ? accountIdToSteamId64(mini) : null,
      profileUrl: link?.href ?? null,
      ping: text(cells[1]),
      kills: text(cells[2]),
      assists: text(cells[3]),
      deaths: text(cells[4]),
      mvps: text(cells[5]),
      hsp: text(cells[6]),
      score: text(cells[7]),
      team,
    });
  }
  return players;
}

export function scrapeMatchHistory(doc: Document): ScrapeResult {
  const table = findTable(doc);
  if (!table) throw new ScrapeError('Scoreboard table not found. Is this a GCPD match-history page? Steam’s markup may have changed.');
  const rows = matchRows(table);
  const matches: ScrapedMatch[] = [];
  let withoutReplay = 0;
  for (const row of rows) {
    const left = row.querySelector(SELECTORS.leftCell)!;
    const link = left.querySelector<HTMLAnchorElement>(SELECTORS.replayLink);
    if (!link) {
      withoutReplay++;
      continue;
    }
    const info = [...left.querySelectorAll(SELECTORS.leftInfoCells)].map(text).filter(Boolean);
    const m: ScrapedMatch = { replayUrl: link.getAttribute('href')!.trim(), players: parsePlayers(row) };
    for (const t of info) {
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(t)) m.dateText = t;
      else if (t.startsWith('Match Duration:')) m.durationText = t.slice(15).trim();
      else if (t.startsWith('Wait Time:')) m.waitTimeText = t.slice(10).trim();
      else if (t.startsWith('Ranked:')) m.rankedText = t.slice(7).trim();
      else if (/download replay/i.test(t)) continue;
      else if (!m.mapText) m.mapText = t;
    }
    const score = row.querySelector(`${SELECTORS.rightTable} ${SELECTORS.scoreCell}`);
    if (score) m.scoreText = text(score);
    matches.push(m);
  }
  if (rows.length > 0 && matches.length === 0 && withoutReplay === 0) {
    throw new ScrapeError('Found match rows but could not read them. Steam’s markup may have changed.');
  }
  return { matches, rowCount: rows.length, rowsWithoutReplay: withoutReplay, ownSteamId: ownSteamId(doc) };
}

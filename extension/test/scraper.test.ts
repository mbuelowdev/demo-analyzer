import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { scrapeMatchHistory, ScrapeError } from '../src/scraper.ts';

const FIXTURE = path.resolve(import.meta.dirname, '../../fixtures/gcpd/matchhistory.html');
const hasFixture = fs.existsSync(FIXTURE);

// R-EXT-7: developed and tested against a real saved GCPD page (gitignored; skipped in CI).
describe.skipIf(!hasFixture)('GCPD scraper on the saved page', () => {
  const doc = hasFixture ? new JSDOM(fs.readFileSync(FIXTURE, 'utf8'), { url: 'https://steamcommunity.com/id/x/gcpd/730/?tab=matchhistorypremier' }).window.document : null;

  it('finds every match with replay link and metadata', () => {
    const r = scrapeMatchHistory(doc!);
    expect(r.rowCount).toBeGreaterThan(0);
    expect(r.matches.length + r.rowsWithoutReplay).toBe(r.rowCount);
    expect(r.matches.length).toBe(20);
    for (const m of r.matches) {
      expect(m.replayUrl).toMatch(/^http:\/\/replay\d+\.valve\.net\/730\/\d+_\d+\.dem\.bz2$/);
      expect(m.dateText).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
      expect(m.mapText).toBeTruthy();
      expect(m.durationText).toMatch(/^\d+:\d{2}$/);
      expect(m.scoreText).toMatch(/^\d+ : \d+$/);
      expect(m.players!.length).toBe(10);
      expect(m.players!.filter((p) => p.team === 1).length).toBe(5);
      for (const p of m.players!) expect(p.steamId).toMatch(/^7656119\d{10}$/);
    }
  });

  it('detects the logged-in SteamID', () => {
    expect(scrapeMatchHistory(doc!).ownSteamId).toMatch(/^7656119\d{10}$/);
  });
});

describe('scraper failures are loud (R-EXT-6)', () => {
  it('throws when the table is missing', () => {
    const doc = new JSDOM('<html><body><p>Steam redesign</p></body></html>').window.document;
    expect(() => scrapeMatchHistory(doc)).toThrow(ScrapeError);
  });
  it('reports rows without replay links instead of dropping them silently', () => {
    const html = `<table class="generic_kv_table csgo_scoreboard_root"><tbody><tr><th>Map</th></tr>
      <tr><td class="val_left"><table class="csgo_scoreboard_inner_left"><tbody><tr><td>Premier Mirage</td></tr></tbody></table></td><td></td></tr></tbody></table>`;
    const r = scrapeMatchHistory(new JSDOM(html).window.document);
    expect(r.rowCount).toBe(1);
    expect(r.rowsWithoutReplay).toBe(1);
    expect(r.matches).toEqual([]);
  });
});

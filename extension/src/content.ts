// Content script on GCPD pages. Scrapes and hands the result to the background worker; no filtering (R-EXT-2).
import { modeFromTab } from '../../shared/src/modes.ts';
import type { Message } from './messages.ts';
import { findTable, matchRows, scrapeMatchHistory, ScrapeError, SELECTORS } from './scraper.ts';

declare global {
  interface Window {
    __demoAnalyzerContent?: boolean;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rowCount(): number {
  const t = findTable(document);
  return t ? matchRows(t).length : 0;
}

async function waitForRows(timeoutMs: number): Promise<number> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const n = rowCount();
    if (n > 0) return n;
    await sleep(300);
  }
  return rowCount();
}

function send(msg: Message) {
  return chrome.runtime.sendMessage(msg);
}

/** Spec flow steps 2–4: if the table is empty, click "load more" exactly once, then scrape as soon as rows appear. */
async function autoScan() {
  const mode = modeFromTab(new URL(location.href).searchParams.get('tab'));
  try {
    send({ type: 'progress', stage: 'waiting for match table' });
    let n = await waitForRows(4000);
    if (n === 0) {
      const more = document.querySelector<HTMLElement>(SELECTORS.loadMore);
      if (!more) throw new ScrapeError('No matches on the page and no "Load more history" button found.');
      send({ type: 'progress', stage: 'loading match history' });
      more.click();
      n = await waitForRows(20000);
      if (n === 0) throw new ScrapeError('No matches appeared after loading more history.');
    }
    await sleep(500);
    await scanNow(mode);
  } catch (e) {
    send({ type: 'scrape-failed', error: (e as Error).message });
  }
}

async function scanNow(mode = modeFromTab(new URL(location.href).searchParams.get('tab'))) {
  const result = scrapeMatchHistory(document);
  await send({ type: 'scraped', mode, result });
}

if (!window.__demoAnalyzerContent) {
  window.__demoAnalyzerContent = true;
  chrome.runtime.onMessage.addListener((msg: Message, _sender, reply) => {
    if (msg.type === 'scan') {
      scanNow()
        .then(() => reply({ ok: true }))
        .catch((e: Error) => {
          send({ type: 'scrape-failed', error: e.message });
          reply({ ok: false, error: e.message });
        });
      return true;
    }
    return false;
  });
  // Only scan automatically when the flyout opened this tab for a match type.
  chrome.runtime.sendMessage({ type: 'should-auto-scan' } satisfies Message).then((yes: boolean) => {
    if (yes) void autoScan();
  });
}

// Service worker: opens GCPD tabs, receives scrape results, posts them to the app with the API key (R-EXT-3).
import type { IngestRequest, IngestResponse } from '../../shared/src/api.ts';
import { GCPD_BASE, GCPD_TABS } from '../../shared/src/modes.ts';
import { getSettings, type LastResult, type Message } from './messages.ts';

const pendingAutoScan = new Set<number>();

async function setResult(r: LastResult) {
  await chrome.storage.session.set({ lastResult: r });
}

async function post(body: IngestRequest): Promise<IngestResponse> {
  const { appUrl, apiKey } = await getSettings();
  if (!apiKey) throw new Error('No API key set. Open the extension options and paste the key from the app’s settings page.');
  const res = await fetch(`${appUrl}/api/ext/matches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      /* not json */
    }
    throw new Error(`App rejected the upload: ${msg}`);
  }
  return (await res.json()) as IngestResponse;
}

async function scanActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith('https://steamcommunity.com/') || !tab.url.includes('/gcpd/730')) {
    throw new Error('Open a Steam GCPD match-history page (steamcommunity.com/my/gcpd/730/…) first.');
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'scan' } satisfies Message);
  } catch {
    // Page was opened before the extension loaded: inject the content script, then ask again.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'scan' } satisfies Message);
  }
}

chrome.runtime.onMessage.addListener((msg: Message, sender, reply) => {
  (async () => {
    switch (msg.type) {
      case 'open-gcpd': {
        const url = `${GCPD_BASE}?tab=${GCPD_TABS[msg.mode]}`;
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        await setResult({ at: Date.now(), source: 'gcpd', mode: msg.mode, ok: true, stage: 'opening GCPD page' });
        const target = tab?.id && tab.url?.startsWith('https://steamcommunity.com/') ? await chrome.tabs.update(tab.id, { url }) : await chrome.tabs.create({ url });
        if (target?.id) pendingAutoScan.add(target.id);
        return { ok: true };
      }
      case 'should-auto-scan': {
        const id = sender.tab?.id;
        if (id !== undefined && pendingAutoScan.has(id)) {
          pendingAutoScan.delete(id);
          return true;
        }
        return false;
      }
      case 'progress':
        await setResult({ at: Date.now(), source: 'gcpd', ok: true, stage: msg.stage });
        return { ok: true };
      case 'scan-active-tab':
        await setResult({ at: Date.now(), source: 'gcpd', ok: true, stage: 'scanning page' });
        await scanActiveTab();
        return { ok: true };
      case 'scraped': {
        const { result, mode } = msg;
        if (result.matches.length === 0) {
          await setResult({ at: Date.now(), source: 'gcpd', mode, ok: false, found: 0, rowsWithoutReplay: result.rowsWithoutReplay, error: `No replay links found (${result.rowCount} match rows on the page).` });
          return { ok: false };
        }
        await setResult({ at: Date.now(), source: 'gcpd', mode, ok: true, stage: `sending ${result.matches.length} matches` });
        const response = await post({ source: 'gcpd', mode, ownSteamId: result.ownSteamId, matches: result.matches });
        await setResult({ at: Date.now(), source: 'gcpd', mode, ok: true, found: result.matches.length, rowsWithoutReplay: result.rowsWithoutReplay, response });
        return { ok: true };
      }
      case 'scrape-failed':
        await setResult({ at: Date.now(), source: 'gcpd', ok: false, error: msg.error });
        return { ok: false };
      case 'manual-urls': {
        const urls = msg.urls.map((u) => u.trim()).filter(Boolean);
        if (!urls.length) throw new Error('Paste at least one replay URL.');
        const response = await post({ source: 'manual', matches: urls.map((replayUrl) => ({ replayUrl })) });
        await setResult({ at: Date.now(), source: 'manual', ok: true, found: urls.length, response });
        return { ok: true };
      }
      default:
        return undefined;
    }
  })()
    .then(reply)
    .catch(async (e: Error) => {
      await setResult({ at: Date.now(), source: msg.type === 'manual-urls' ? 'manual' : 'gcpd', ok: false, error: e.message });
      reply({ ok: false, error: e.message });
    });
  return true;
});

chrome.tabs.onRemoved.addListener((id) => pendingAutoScan.delete(id));

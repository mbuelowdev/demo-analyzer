import type { LastResult, Message } from './messages.ts';
import { getSettings } from './messages.ts';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

function render(r: LastResult | undefined) {
  const el = $('#result');
  if (!r) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.className = `result ${r.ok ? (r.response ? 'ok' : 'busy') : 'error'}`;
  const when = new Date(r.at).toLocaleTimeString();
  if (!r.ok) el.textContent = `${when} · ${r.error ?? 'failed'}`;
  else if (r.response) {
    const { new: n, known, failed } = r.response;
    const extra = r.rowsWithoutReplay ? ` · ${r.rowsWithoutReplay} rows without replay link` : '';
    el.innerHTML = '';
    const strong = document.createElement('strong');
    strong.textContent = `${n} new, ${known} already known, ${failed} failed`;
    el.append(strong, document.createTextNode(` (${r.found} sent${extra}) · ${when}`));
  } else el.textContent = `${when} · ${r.stage ?? 'working'}…`;
}

async function sendMsg(m: Message) {
  const res = (await chrome.runtime.sendMessage(m)) as { ok: boolean; error?: string } | undefined;
  if (res && !res.ok && res.error) render({ at: Date.now(), source: 'gcpd', ok: false, error: res.error });
}

document.querySelectorAll<HTMLButtonElement>('button[data-mode]').forEach((b) =>
  b.addEventListener('click', () => void sendMsg({ type: 'open-gcpd', mode: b.dataset.mode as 'premier' })),
);
$('#scan').addEventListener('click', () => void sendMsg({ type: 'scan-active-tab' }));
$('#send').addEventListener('click', () => {
  const urls = $<HTMLTextAreaElement>('#urls').value.split('\n');
  void sendMsg({ type: 'manual-urls', urls });
});
$('#options').addEventListener('click', (e) => {
  e.preventDefault();
  void chrome.runtime.openOptionsPage();
});
$('#app').addEventListener('click', async (e) => {
  e.preventDefault();
  const s = await getSettings();
  void chrome.tabs.create({ url: s.appUrl });
});

chrome.storage.session.get('lastResult').then((v) => render(v.lastResult as LastResult | undefined));
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.lastResult) render(changes.lastResult.newValue as LastResult);
});

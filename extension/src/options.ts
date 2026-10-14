import { DEFAULT_SETTINGS, getSettings } from './messages.ts';

const appUrl = document.querySelector<HTMLInputElement>('#appUrl')!;
const apiKey = document.querySelector<HTMLInputElement>('#apiKey')!;
const status = document.querySelector<HTMLDivElement>('#status')!;

function show(ok: boolean, msg: string) {
  status.hidden = false;
  status.className = `result ${ok ? 'ok' : 'error'}`;
  status.textContent = msg;
}

getSettings().then((s) => {
  appUrl.value = s.appUrl;
  apiKey.value = s.apiKey;
});

/** R-EXT-4: the app URL is configurable; origins other than production need a runtime host permission. */
async function ensurePermission(url: string): Promise<boolean> {
  const origin = `${new URL(url).origin}/*`;
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  return chrome.permissions.request({ origins: [origin] });
}

document.querySelector('#save')!.addEventListener('click', async () => {
  try {
    const url = (appUrl.value.trim() || DEFAULT_SETTINGS.appUrl).replace(/\/$/, '');
    new URL(url);
    if (!(await ensurePermission(url))) return show(false, 'Permission for that URL was not granted.');
    await chrome.storage.sync.set({ appUrl: url, apiKey: apiKey.value.trim() });
    show(true, 'Saved.');
  } catch (e) {
    show(false, (e as Error).message);
  }
});

document.querySelector('#test')!.addEventListener('click', async () => {
  const s = await getSettings();
  try {
    const res = await fetch(`${s.appUrl}/api/ext/ping`, { headers: { authorization: `Bearer ${s.apiKey}` } });
    const body = (await res.json()) as { username?: string; error?: string };
    if (res.ok) show(true, `Connected as ${body.username}.`);
    else show(false, body.error ?? `HTTP ${res.status}`);
  } catch (e) {
    show(false, `Could not reach ${s.appUrl}: ${(e as Error).message}`);
  }
});

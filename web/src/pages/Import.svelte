<script lang="ts">
  import { api, uploadFile } from '../lib/api.ts';

  interface Upload { name: string; size: number; progress: number; status: 'uploading' | 'done' | 'error'; message?: string; matchId?: number }
  let uploads = $state<Upload[]>([]);
  let dragging = $state(false);
  let urls = $state('');
  let urlResult = $state<string | null>(null);
  let active = $state<{ active: { id: number; status: string; error: string | null }[]; counts: { status: string; n: number }[] }>({ active: [], counts: [] });

  const ACCEPT = /\.dem(\.bz2|\.zst)?$/i;

  async function handleFiles(files: FileList | File[]) {
    for (const file of files) {
      const u: Upload = { name: file.name, size: file.size, progress: 0, status: 'uploading' };
      uploads.unshift(u);
      const item = uploads[0];
      if (!ACCEPT.test(file.name)) {
        item.status = 'error';
        item.message = 'Only .dem, .dem.bz2 and .dem.zst files';
        continue;
      }
      try {
        const res = (await uploadFile(`/api/uploads?name=${encodeURIComponent(file.name)}`, file, (p) => (item.progress = p))) as { result: string; matchId: number };
        item.status = 'done';
        item.matchId = res.matchId;
        item.message = res.result === 'known' ? 'already imported' : 'queued for parsing';
      } catch (e) {
        item.status = 'error';
        item.message = (e as Error).message;
      }
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    if (e.dataTransfer?.files) handleFiles(e.dataTransfer.files);
  }

  async function poll() {
    try {
      active = await api('/api/matches/active');
    } catch {
      /* ignore */
    }
  }
  $effect(() => {
    poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  });

  async function sendUrls() {
    urlResult = null;
    try {
      // Manual URLs go through the same ingest logic as the extension, using a session-authenticated twin endpoint.
      const r = await api<{ new: number; known: number; failed: number }>('/api/ingest', { method: 'POST', body: { source: 'manual', matches: urls.split('\n').filter((s) => s.trim()).map((replayUrl) => ({ replayUrl })) } });
      urlResult = `${r.new} new, ${r.known} already known, ${r.failed} failed`;
      urls = '';
    } catch (e) {
      urlResult = (e as Error).message;
    }
  }
</script>

<h1>Import</h1>

<div class="grid-2">
  <section class="card">
    <h2>Upload demo files</h2>
    <div
      class="drop"
      class:dragging
      role="button"
      tabindex="0"
      ondragover={(e) => {
        e.preventDefault();
        dragging = true;
      }}
      ondragleave={() => (dragging = false)}
      ondrop={onDrop}
    >
      <p>Drop <code>.dem</code>, <code>.dem.bz2</code> or <code>.dem.zst</code> files here</p>
      <label class="button">Choose files<input type="file" multiple accept=".dem,.bz2,.zst" hidden onchange={(e) => handleFiles((e.target as HTMLInputElement).files!)} /></label>
    </div>
    {#each uploads as u}
      <div class="upload">
        <div class="row"><span>{u.name}</span><span class="spacer"></span><span class="muted">{u.status === 'uploading' ? `${Math.round(u.progress * 100)}%` : u.message}</span></div>
        {#if u.status === 'uploading'}<div class="progress"><div style="width:{u.progress * 100}%"></div></div>{/if}
        {#if u.status === 'error'}<div class="error-box">{u.message}</div>{/if}
        {#if u.matchId}<a href="/matches/{u.matchId}">Open match</a>{/if}
      </div>
    {/each}
  </section>

  <section class="card">
    <h2>Processing</h2>
    {#if active.active.length}
      <ul>
        {#each active.active as a}<li><a href="/matches/{a.id}">Match #{a.id}</a> · {a.status}{a.error ? ` · ${a.error}` : ''}</li>{/each}
      </ul>
    {:else}
      <p class="muted">Nothing in progress.</p>
    {/if}
    <p class="muted">{active.counts.map((c) => `${c.n} ${c.status}`).join(' · ')}</p>

    <h3>Replay URLs</h3>
    <textarea rows="3" bind:value={urls} placeholder="http://replay123.valve.net/730/…_….dem.bz2 (one per line)" style="width:100%"></textarea>
    <div class="row"><button onclick={sendUrls} disabled={!urls.trim()}>Add URLs</button>{#if urlResult}<span class="muted">{urlResult}</span>{/if}</div>
  </section>
</div>

<section class="card">
  <h2>Chromium extension</h2>
  <ol>
    <li><a href="/api/extension.zip" download data-native>Download the extension (.zip)</a> and unzip it.</li>
    <li>Open <code>chrome://extensions</code> (or Edge/Brave/Vivaldi equivalent), enable Developer mode, click “Load unpacked” and pick the unzipped folder.</li>
    <li>Create an API key in <a href="/settings">Settings</a> and paste it into the extension’s options together with this app’s URL: <code>{location.origin}</code>.</li>
    <li>Log in to Steam in the same browser, click the extension icon and pick a match type. It opens your GCPD match history, loads it and sends every replay link here.</li>
  </ol>
  <p class="muted">Valve keeps replays for about 2 weeks, so run it every now and then. Expired links keep the scoreboard metadata.</p>
</section>

<style>
  .drop { border: 2px dashed var(--border); border-radius: var(--radius); padding: 24px; text-align: center; margin-bottom: 12px; }
  .drop.dragging { border-color: var(--accent); background: var(--surface-2); }
  .upload { padding: 8px 0; border-top: 1px solid var(--border); }
  ul { padding-left: 18px; }
</style>

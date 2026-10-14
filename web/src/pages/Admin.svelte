<script lang="ts">
  import { MAP_SEED } from '../../../shared/src/maps.ts';
  import { detectMap, vpkPaths } from '../../../shared/src/vpk.ts';
  import { api, uploadFile } from '../lib/api.ts';
  import { bytes, fmtDate } from '../lib/format.ts';

  type Any = Record<string, any>;
  let whitelist = $state<Any[]>([]);
  let maps = $state<Any[]>([]);
  let jobs = $state<Any | null>(null);
  let disk = $state<Any | null>(null);
  let scoreCfg = $state<Any | null>(null);
  let scoreText = $state('');
  let scoreMsg = $state<string | null>(null);
  let error = $state<string | null>(null);

  let newId = $state('');
  let newNote = $state('');
  let newAdmin = $state(false);

  let mapFile = $state<File | null>(null);
  let mapChoice = $state('');
  let mapDetect = $state<string | null>(null);
  let mapProgress = $state<number | null>(null);
  let mapMsg = $state<string | null>(null);

  const wrap = async (fn: () => Promise<unknown>) => {
    try {
      error = null;
      await fn();
    } catch (e) {
      error = (e as Error).message;
    }
  };
  const loadWl = () => wrap(async () => (whitelist = await api('/api/admin/whitelist')));
  const loadMaps = () => wrap(async () => (maps = await api('/api/admin/maps')));
  const loadJobs = () => wrap(async () => (jobs = await api('/api/admin/jobs')));
  const loadDisk = () => wrap(async () => (disk = await api('/api/admin/disk')));
  const loadScore = () =>
    wrap(async () => {
      scoreCfg = await api('/api/admin/score-config');
      scoreText = JSON.stringify(scoreCfg!.config, null, 2);
    });
  loadWl();
  loadMaps();
  loadJobs();
  loadDisk();
  loadScore();
  $effect(() => {
    const t = setInterval(loadJobs, 5000);
    return () => clearInterval(t);
  });

  const add = () =>
    wrap(async () => {
      await api('/api/admin/whitelist', { method: 'POST', body: { discordId: newId.trim(), note: newNote, isAdmin: newAdmin } });
      newId = newNote = '';
      newAdmin = false;
      loadWl();
    });
  const remove = (id: string) => wrap(async () => confirm(`Remove ${id}? Their sessions and API keys are revoked immediately.`) && (await api(`/api/admin/whitelist/${id}`, { method: 'DELETE' }), loadWl()));
  const setAdmin = (id: string, isAdmin: boolean) => wrap(async () => (await api(`/api/admin/whitelist/${id}`, { method: 'PATCH', body: { isAdmin } }), loadWl()));

  // R-MAP-3: auto-select from the file name or the VPK's internal paths.
  async function pickMap(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0] ?? null;
    mapFile = f;
    mapMsg = null;
    mapDetect = null;
    if (!f) return;
    if (/_vanity\.vpk$/i.test(f.name)) {
      mapMsg = 'Vanity (main-menu) maps are not used.';
      return;
    }
    const known = maps.map((m) => m.name as string);
    const head = new Uint8Array(await f.slice(0, Math.min(f.size, 32 * 1024 * 1024)).arrayBuffer());
    const paths = vpkPaths(head);
    if (!paths) {
      mapMsg = 'This does not look like a VPK file (bad header).';
      return;
    }
    const d = detectMap(f.name, paths, known);
    mapDetect = d;
    mapChoice = d ?? '';
  }
  const uploadMap = () =>
    wrap(async () => {
      if (!mapFile || !mapChoice) return;
      mapProgress = 0;
      try {
        await uploadFile(`/api/admin/maps/${mapChoice}/file`, mapFile, (p) => (mapProgress = p));
        mapMsg = `Uploaded ${mapFile.name} as ${mapChoice}.`;
        mapFile = null;
        loadMaps();
        loadDisk();
      } finally {
        mapProgress = null;
      }
    });
  const deleteMap = (name: string) => wrap(async () => confirm(`Delete the file for ${name}?`) && (await api(`/api/admin/maps/${name}/file`, { method: 'DELETE' }), loadMaps()));

  const saveScore = () =>
    wrap(async () => {
      const cfg = JSON.parse(scoreText);
      await api('/api/admin/score-config', { method: 'PUT', body: cfg });
      scoreMsg = 'Saved. Scores are being recomputed for all users.';
      loadScore();
    });
  const displayName = (n: string) => MAP_SEED.find((m) => m.name === n)?.displayName ?? n;
</script>

<h1>Admin</h1>
{#if error}<div class="error-box">{error}</div>{/if}

<section class="card">
  <h2>Whitelist</h2>
  <div class="row">
    <input bind:value={newId} placeholder="Discord ID" />
    <input bind:value={newNote} placeholder="Note, e.g. Max – friend" />
    <label class="row"><input type="checkbox" bind:checked={newAdmin} /> admin</label>
    <button class="primary" onclick={add} disabled={!newId.trim()}>Add</button>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Discord ID</th><th>User</th><th>Note</th><th>Admin</th><th>Last login</th><th></th></tr></thead>
      <tbody>
        {#each whitelist as w}
          <tr>
            <td><code>{w.discordId}</code></td>
            <td>{w.username ?? '–'}</td>
            <td>{w.note ?? ''}</td>
            <td>{#if w.fixed}yes <span class="muted">(fixed)</span>{:else}<input type="checkbox" checked={w.isAdmin} onchange={(e) => setAdmin(w.discordId, (e.target as HTMLInputElement).checked)} />{/if}</td>
            <td>{w.lastLoginAt ? fmtDate(new Date(w.lastLoginAt).toISOString()) : 'never'}</td>
            <td>{#if !w.fixed}<button class="danger" onclick={() => remove(w.discordId)}>Remove</button>{/if}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>

<section class="card">
  <h2>Map files</h2>
  <p class="muted">Upload <code>…/game/csgo/maps/&lt;map&gt;.vpk</code> from a CS2 install. Shared by all users; used later for ray-cast visibility. A new upload replaces the old file.</p>
  <div class="row">
    <input type="file" accept=".vpk" onchange={pickMap} />
    <select bind:value={mapChoice}>
      <option value="">Select map…</option>
      {#each maps as m}<option value={m.name}>{m.displayName} ({m.name})</option>{/each}
    </select>
    <button class="primary" onclick={uploadMap} disabled={!mapFile || !mapChoice || mapProgress !== null}>Upload</button>
    {#if mapFile}<span class="muted">{bytes(mapFile.size)}{mapDetect ? ` · detected ${displayName(mapDetect)}` : ' · no exact match, pick the map'}</span>{/if}
  </div>
  {#if mapProgress !== null}<div class="progress" style="margin-top:8px"><div style="width:{mapProgress * 100}%"></div></div>{/if}
  {#if mapMsg}<p class="muted">{mapMsg}</p>{/if}
  <div class="table-wrap">
    <table>
      <thead><tr><th>Map</th><th>Name</th><th>Pools</th><th>Status</th><th class="num">Size</th><th>Uploaded</th><th></th></tr></thead>
      <tbody>
        {#each maps as m}
          <tr>
            <td>{m.displayName}</td><td><code>{m.name}</code></td><td class="muted">{m.pools}</td><td>{m.status}</td>
            <td class="num">{bytes(m.fileSize)}</td><td>{m.uploadedAt ? `${fmtDate(new Date(m.uploadedAt).toISOString())} · ${m.uploadedBy}` : '–'}</td>
            <td>{#if m.fileSize}<button class="danger" onclick={() => deleteMap(m.name)}>Delete file</button>{/if}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>

<div class="grid-2">
  <section class="card">
    <h2>Job queue</h2>
    {#if jobs}
      <p>{jobs.demos.map((d: Any) => `${d.n} ${d.status}`).join(' · ') || 'No demos yet.'}</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>#</th><th>Type</th><th>Status</th><th class="num">Try</th><th>Updated</th><th>Error</th></tr></thead>
          <tbody>
            {#each jobs.recent.slice(0, 30) as j}
              <tr><td>{j.id}</td><td>{j.type}</td><td>{j.status}</td><td class="num">{j.attempts}/{j.maxAttempts}</td><td>{fmtDate(new Date(j.updatedAt).toISOString())}</td><td class="muted err">{j.error ?? ''}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
  <section class="card">
    <h2>Disk usage</h2>
    {#if disk}
      {#if disk.warning}<div class="error-box">Free space is below {bytes(disk.warnBelowBytes)}.</div>{/if}
      <table>
        <tbody>
          <tr><td>Raw demos</td><td class="num">{bytes(disk.raw)}</td></tr>
          <tr><td>Parsed match data</td><td class="num">{bytes(disk.matches)}</td></tr>
          <tr><td>Map files</td><td class="num">{bytes(disk.maps)}</td></tr>
          <tr><td>Database</td><td class="num">{bytes(disk.db)}</td></tr>
          <tr><td>Temp</td><td class="num">{bytes(disk.tmp)}</td></tr>
          <tr><td>Free / total</td><td class="num">{bytes(disk.free)} / {bytes(disk.total)}</td></tr>
        </tbody>
      </table>
    {/if}
  </section>
</div>

<section class="card">
  <h2>Suspicion score configuration</h2>
  <p class="muted">Weights (0 disables) and minimum samples per indicator, minimum indicators per score, and <code>baselineMin</code>: how many player-matches a metric needs in a user’s own demos before they replace the built-in reference (R-SCORE-1..3). Saving recomputes all scores.</p>
  {#if scoreCfg}
    <p class="muted small">{scoreCfg.indicators.map((i: Any) => `${i.id}: ${i.metric} (${i.suspicious} = suspicious)`).join(' · ')}</p>
  {/if}
  <textarea rows="14" bind:value={scoreText} style="width:100%;font-family:monospace"></textarea>
  <div class="row"><button class="primary" onclick={saveScore}>Save</button><button onclick={() => (scoreText = JSON.stringify(scoreCfg?.defaults, null, 2))}>Reset to defaults</button>{#if scoreMsg}<span class="muted">{scoreMsg}</span>{/if}</div>
</section>

<style>
  .err { white-space: normal; max-width: 320px; font-size: 12px; }
  .small { font-size: 12px; }
</style>

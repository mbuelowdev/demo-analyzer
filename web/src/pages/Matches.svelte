<script lang="ts">
  import type { MatchListItem, MeResponse } from '../../../shared/src/api.ts';
  import StatusBadge from '../components/StatusBadge.svelte';
  import SuspicionBadge from '../components/SuspicionBadge.svelte';
  import { api } from '../lib/api.ts';
  import { fmtDate, mapName, modeName } from '../lib/format.ts';
  import { navigate } from '../lib/router.svelte.ts';

  let { me }: { me: MeResponse } = $props();
  let matches = $state<MatchListItem[]>([]);
  let maps = $state<string[]>([]);
  let mode = $state('');
  let map = $state('');
  let from = $state('');
  let to = $state('');
  let error = $state<string | null>(null);
  let loaded = $state(false);

  async function load() {
    const q = new URLSearchParams();
    if (mode) q.set('mode', mode);
    if (map) q.set('map', map);
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    try {
      matches = await api<MatchListItem[]>(`/api/matches?${q}`);
      error = null;
    } catch (e) {
      error = (e as Error).message;
    }
    loaded = true;
  }

  $effect(() => {
    void [mode, map, from, to];
    load();
  });
  api<string[]>('/api/matches/maps').then((m) => (maps = m));

  // R-UI-3: poll while anything is in progress.
  $effect(() => {
    const busy = matches.some((m) => ['queued', 'downloading', 'parsing', 'analysing'].includes(m.status));
    if (!busy) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  });
</script>

<div class="row">
  <h1>Matches</h1>
  <span class="spacer"></span>
  <a class="button primary" href="/import">Import demos</a>
</div>

{#if !me.steamId}
  <div class="notice">Link your SteamID64 in <a href="/settings">Settings</a> (or run the extension once) so the app knows which player is you.</div>
{/if}

<div class="row filters">
  <select bind:value={mode} aria-label="Mode">
    <option value="">All modes</option>
    <option value="premier">Premier</option>
    <option value="competitive">Competitive</option>
    <option value="wingman">Wingman</option>
    <option value="rush">Rush</option>
    <option value="unknown">Unknown (uploads)</option>
  </select>
  <select bind:value={map} aria-label="Map">
    <option value="">All maps</option>
    {#each maps as m}<option value={m}>{mapName(m)}</option>{/each}
  </select>
  <label class="row">From <input type="date" bind:value={from} /></label>
  <label class="row">To <input type="date" bind:value={to} /></label>
  <span class="muted">{matches.length} matches</span>
</div>

{#if error}<div class="error-box">{error}</div>{/if}

{#if loaded && !matches.length}
  <div class="card"><p>No matches yet. <a href="/import">Import some demos</a> with the extension or a file upload.</p></div>
{:else}
  <div class="card table-wrap">
    <table>
      <thead>
        <tr><th>Date</th><th>Mode</th><th>Map</th><th class="num">Score</th><th class="num">K / D</th><th>Status</th><th>Highest suspicion</th></tr>
      </thead>
      <tbody>
        {#each matches as m (m.id)}
          <tr class="clickable" onclick={() => navigate(`/matches/${m.id}`)}>
            <td><a href="/matches/{m.id}">{fmtDate(m.playedAt)}</a></td>
            <td>{modeName(m.mode)}</td>
            <td>{mapName(m.map)}</td>
            <td class="num" class:win={m.scoreOwn !== null && m.scoreOpp !== null && m.scoreOwn > m.scoreOpp} class:loss={m.scoreOwn !== null && m.scoreOpp !== null && m.scoreOwn < m.scoreOpp}>{m.scoreText ?? '–'}</td>
            <td class="num">{m.ownKills ?? '–'} / {m.ownDeaths ?? '–'}</td>
            <td><StatusBadge status={m.status} error={m.error} /></td>
            <td>{#if m.status === 'analysed'}<SuspicionBadge score={m.maxSuspicion} insufficient />{:else}<span class="muted">–</span>{/if}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .filters { margin-bottom: 12px; }
  td.win { color: var(--good); }
  td.loss { color: var(--critical); }
</style>

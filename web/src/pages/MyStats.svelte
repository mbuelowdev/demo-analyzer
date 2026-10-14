<script lang="ts">
  import type { MeResponse } from '../../../shared/src/api.ts';
  import LineChart from '../components/LineChart.svelte';
  import { api } from '../lib/api.ts';
  import { fmtDate, mapName, num } from '../lib/format.ts';
  import { navigate } from '../lib/router.svelte.ts';

  let { me }: { me: MeResponse } = $props();
  type Point = Record<string, any>;
  let points = $state<Point[]>([]);
  let maps = $state<string[]>([]);
  let mode = $state('');
  let map = $state('');
  let from = $state('');
  let to = $state('');
  let showTable = $state(false);

  $effect(() => {
    const q = new URLSearchParams();
    if (mode) q.set('mode', mode);
    if (map) q.set('map', map);
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    api<{ points: Point[] }>(`/api/stats/me?${q}`).then((r) => (points = r.points));
  });
  api<string[]>('/api/matches/maps').then((m) => (maps = m));

  const avg = (k: string) => {
    const v = points.map((p) => p[k]).filter((x) => typeof x === 'number');
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const wins = $derived(points.filter((p) => p.won === true).length);
  const series = (k: string) => points.map((p) => ({ x: Date.parse(p.playedAt), y: p[k], label: `${fmtDate(p.playedAt)} · ${mapName(p.map)}` }));
  const CHARTS: [string, string, (v: number) => string][] = [
    ['rating', 'Rating', (v) => v.toFixed(2)],
    ['adr', 'ADR', (v) => v.toFixed(0)],
    ['kd', 'K/D', (v) => v.toFixed(2)],
    ['hsPercent', 'HS%', (v) => `${v.toFixed(0)}%`],
    ['kast', 'KAST', (v) => `${v.toFixed(0)}%`],
    ['utilityDamagePerRound', 'Utility damage per round', (v) => v.toFixed(0)],
  ];
</script>

<h1>My stats</h1>
{#if !me.steamId}
  <div class="notice">Link your SteamID64 in <a href="/settings">Settings</a> first.</div>
{:else}
  <div class="row filters">
    <select bind:value={mode} aria-label="Mode">
      <option value="">All modes</option><option value="premier">Premier</option><option value="competitive">Competitive</option><option value="wingman">Wingman</option><option value="rush">Rush</option>
    </select>
    <select bind:value={map} aria-label="Map"><option value="">All maps</option>{#each maps as m}<option value={m}>{mapName(m)}</option>{/each}</select>
    <label class="row">From <input type="date" bind:value={from} /></label>
    <label class="row">To <input type="date" bind:value={to} /></label>
  </div>

  <div class="stat-tiles">
    <div class="stat-tile"><div class="label">Matches</div><div class="value">{points.length}</div></div>
    <div class="stat-tile"><div class="label">Win rate</div><div class="value">{points.length ? `${Math.round((100 * wins) / points.length)}%` : '–'}</div></div>
    <div class="stat-tile"><div class="label">Avg rating</div><div class="value">{num(avg('rating'), 2)}</div></div>
    <div class="stat-tile"><div class="label">Avg ADR</div><div class="value">{num(avg('adr'), 1)}</div></div>
    <div class="stat-tile"><div class="label">Avg HS%</div><div class="value">{num(avg('hsPercent'), 0)}</div></div>
    <div class="stat-tile"><div class="label">Avg KAST</div><div class="value">{num(avg('kast'), 0)}%</div></div>
  </div>

  <div class="grid-3">
    {#each CHARTS as [k, title, f]}
      <LineChart {title} points={series(k)} format={f} onSelect={(i) => navigate(`/matches/${points[i].matchId}`)} />
    {/each}
  </div>

  <p><button onclick={() => (showTable = !showTable)}>{showTable ? 'Hide' : 'Show'} table</button></p>
  {#if showTable}
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Map</th><th>Result</th><th class="num">K</th><th class="num">D</th><th class="num">A</th><th class="num">ADR</th><th class="num">HS%</th><th class="num">KAST</th><th class="num">Rating</th></tr></thead>
        <tbody>
          {#each points.slice().reverse() as p}
            <tr class="clickable" onclick={() => navigate(`/matches/${p.matchId}`)}>
              <td>{fmtDate(p.playedAt)}</td><td>{mapName(p.map)}</td><td>{p.won === true ? 'Win' : p.won === false ? 'Loss' : '–'}</td>
              <td class="num">{p.kills}</td><td class="num">{p.deaths}</td><td class="num">{p.assists}</td><td class="num">{num(p.adr, 1)}</td><td class="num">{num(p.hsPercent)}</td><td class="num">{num(p.kast)}</td><td class="num">{num(p.rating, 2)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/if}

<style>
  .filters { margin-bottom: 12px; }
</style>

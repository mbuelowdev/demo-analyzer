<script lang="ts">
  import LineChart from '../components/LineChart.svelte';
  import SuspicionBadge from '../components/SuspicionBadge.svelte';
  import { api } from '../lib/api.ts';
  import { fmtDate, fmtMetric, mapName, modeName, num } from '../lib/format.ts';
  import { navigate } from '../lib/router.svelte.ts';

  let { steamId }: { steamId: string } = $props();
  type Any = Record<string, any>;
  let data = $state<Any | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    api<Any>(`/api/players/${steamId}`).then((d) => (data = d)).catch((e) => (error = e.message));
  });
</script>

{#if error}
  <div class="error-box">{error}</div>
{:else if !data}
  <p class="muted">Loading…</p>
{:else}
  <div class="row">
    <h1>{data.names[0]} {#if data.isMe}<span class="muted">(you)</span>{/if}</h1>
    <span class="spacer"></span>
    <a href="https://steamcommunity.com/profiles/{steamId}" target="_blank" rel="noopener">Steam profile ↗</a>
  </div>
  {#if data.names.length > 1}<p class="muted">Also seen as: {data.names.slice(1).join(', ')}</p>{/if}

  <div class="stat-tiles">
    <div class="stat-tile"><div class="label">Matches with you</div><div class="value">{data.totals.matches}</div></div>
    <div class="stat-tile"><div class="label">K / D</div><div class="value">{data.totals.kills} / {data.totals.deaths}</div></div>
    <div class="stat-tile"><div class="label">Avg ADR</div><div class="value">{num(data.totals.adr, 1)}</div></div>
    <div class="stat-tile"><div class="label">Avg rating</div><div class="value">{num(data.totals.rating, 2)}</div></div>
    <div class="stat-tile"><div class="label">Avg HS%</div><div class="value">{num(data.totals.hsPercent, 0)}</div></div>
    <div class="stat-tile">
      <div class="label">Aggregated suspicion</div>
      <div class="value"><SuspicionBadge score={data.aggregatedScore} insufficient /></div>
      <div class="label">{data.scoredMatches} scored matches</div>
    </div>
  </div>
  <p class="muted">The aggregated score is the sample-weighted mean of this player’s per-match scores, each against your own baseline. An aid for investigation, not a verdict.</p>

  <h2>Indicator trends</h2>
  <div class="grid-3">
    {#each data.trends as t}
      <LineChart
        title="{t.name} · {t.metric}"
        points={t.points.map((p: Any) => ({ x: Date.parse(p.playedAt), y: p.value, label: `${fmtDate(p.playedAt)} · ${p.samples} samples` }))}
        format={(v) => fmtMetric(t.metric, v)}
        onSelect={(i) => navigate(`/matches/${t.points[i].matchId}`)}
      />
    {/each}
  </div>

  <h2>Matches</h2>
  <div class="card table-wrap">
    <table>
      <thead><tr><th>Date</th><th>Mode</th><th>Map</th><th>Result</th><th class="num">K</th><th class="num">D</th><th class="num">A</th><th class="num">ADR</th><th class="num">HS%</th><th class="num">Rating</th><th>Suspicion</th></tr></thead>
      <tbody>
        {#each data.matches.slice().reverse() as m}
          <tr class="clickable" onclick={() => navigate(`/matches/${m.matchId}`)}>
            <td><a href="/matches/{m.matchId}">{fmtDate(m.playedAt)}</a></td><td>{modeName(m.mode)}</td><td>{mapName(m.map)}</td>
            <td>{m.won === true ? 'Win' : m.won === false ? 'Loss' : '–'}</td>
            <td class="num">{m.kills}</td><td class="num">{m.deaths}</td><td class="num">{m.assists}</td><td class="num">{num(m.adr, 1)}</td><td class="num">{num(m.hsPercent)}</td><td class="num">{num(m.rating, 2)}</td>
            <td><SuspicionBadge score={m.score} insufficient={!!m.breakdown} /></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

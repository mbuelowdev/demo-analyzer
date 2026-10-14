<script lang="ts">
  import type { MeResponse } from '../../../shared/src/api.ts';
  import StatusBadge from '../components/StatusBadge.svelte';
  import SuspicionBadge from '../components/SuspicionBadge.svelte';
  import { api } from '../lib/api.ts';
  import { bytes, fmtDate, fmtMetric, mapName, modeName, num, pct } from '../lib/format.ts';
  import { navigate } from '../lib/router.svelte.ts';

  let { id, me }: { id: string; me: MeResponse } = $props();

  // Loose typing: the payload mirrors server/src/analysis/stats.ts.
  type Any = Record<string, any>;
  let data = $state<Any | null>(null);
  let error = $state<string | null>(null);
  let tab = $state<'scoreboard' | 'rounds' | 'utility' | 'cheat'>('scoreboard');
  let log = $state<string | null>(null);
  let busyMsg = $state<string | null>(null);
  let selected = $state<string | null>(null);

  async function load() {
    try {
      data = await api<Any>(`/api/matches/${id}`);
      error = null;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  load();

  const status = $derived(data?.match.status as string | undefined);
  $effect(() => {
    if (!status || !['queued', 'downloading', 'parsing', 'analysing'].includes(status)) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  });

  async function action(path: string, label: string) {
    busyMsg = `${label}…`;
    try {
      await api(`/api/matches/${id}/${path}`, { method: 'POST' });
      busyMsg = `${label} queued.`;
      load();
    } catch (e) {
      busyMsg = (e as Error).message;
    }
  }
  async function remove() {
    if (!confirm('Delete this match from your account?')) return;
    await api(`/api/matches/${id}`, { method: 'DELETE' });
    navigate('/');
  }
  async function showLog() {
    const r = await api<{ error: string; log: string }>(`/api/matches/${id}/log`);
    log = `${r.error ?? ''}\n\n${r.log ?? ''}`.trim();
  }

  const players = $derived(((data?.players ?? []) as Any[]).slice().sort((a, b) => (a.team === b.team ? (b.rating ?? 0) - (a.rating ?? 0) : a.team < b.team ? -1 : 1)));
  const teamA = $derived(players.filter((p) => p.team === 'A'));
  const teamB = $derived(players.filter((p) => p.team === 'B'));
  const nameOf = (sid: string) => players.find((p) => p.steamId === sid)?.name ?? sid;
  const ownTeam = $derived(players.find((p) => p.steamId === me.steamId)?.team ?? null);
  const scoreOf = (sid: string) => (data?.scores as Any[] | undefined)?.find((s) => s.steamId === sid);
  const resultOf = (sid: string, ind: string) => (data?.indicatorResults as Any[] | undefined)?.find((r) => r.steamId === sid && r.indicator === ind);

  const STAT_COLS: [string, string, (p: Any) => string][] = [
    ['K', 'Kills', (p) => String(p.kills)],
    ['A', 'Assists', (p) => String(p.assists)],
    ['D', 'Deaths', (p) => String(p.deaths)],
    ['K/D', 'Kill/death ratio', (p) => num(p.kd, 2)],
    ['ADR', 'Average damage per round', (p) => num(p.adr, 1)],
    ['HS%', 'Headshot kill percentage', (p) => num(p.hsPercent, 0)],
    ['KAST', 'Rounds with kill, assist, survived or traded', (p) => (p.kast === null ? '–' : `${num(p.kast, 0)}%`)],
    ['2K–5K', 'Multi-kill rounds', (p) => `${p.multiKills['2k']}/${p.multiKills['3k']}/${p.multiKills['4k']}/${p.multiKills['5k']}`],
    ['OK–OD', 'Opening kills – opening deaths', (p) => `${p.openingKills}–${p.openingDeaths}`],
    ['1vX', 'Clutches won/lost', (p) => `${p.clutches.won}/${p.clutches.won + p.clutches.lost}`],
    ['Trades', 'Trade kills / traded deaths', (p) => `${p.tradeKills}/${p.tradedDeaths}`],
    ['MVP', 'MVPs', (p) => (p.mvps ?? '–') + ''],
    ['Rating', 'HLTV 2.0-style rating approximation', (p) => num(p.rating, 2)],
  ];

  const isRush = $derived(!!data?.summary?.isRush);
  const weaponRows = (p: Any) => Object.entries(p.weapons as Record<string, Any>).sort((a, b) => b[1].kills - a[1].kills || b[1].damage - a[1].damage);
</script>

{#if error}
  <div class="error-box">{error}</div>
{:else if !data}
  <p class="muted">Loading…</p>
{:else}
  {@const m = data.match}
  <div class="row head">
    <div>
      <h1>{mapName(m.map)} <span class="muted">· {modeName(m.mode)}</span></h1>
      <div class="row muted">
        <span>{fmtDate(m.playedAt)}</span>
        {#if m.durationText}<span>· {m.durationText}</span>{/if}
        {#if m.serverName}<span>· {m.serverName}</span>{/if}
        <StatusBadge status={m.status} error={m.error} />
      </div>
    </div>
    <span class="spacer"></span>
    {#if data.summary}
      <div class="score">
        <span class="team-a">{data.summary.scoreA}</span><span class="muted"> : </span><span class="team-b">{data.summary.scoreB}</span>
      </div>
    {/if}
  </div>

  {#if m.error}
    <div class="error-box">{m.error} {#if m.hasLog}<button onclick={showLog}>Show log</button>{/if}</div>
  {/if}
  {#if log}<pre>{log}</pre>{/if}

  <div class="row actions">
    {#if m.status === 'failed' || m.status === 'expired'}<button onclick={() => action('retry', 'Retry')}>Retry</button>{/if}
    <button onclick={() => action('reparse', 'Re-parse')} disabled={!m.hasRaw} title={m.hasRaw ? 'Parse the raw demo again' : 'Raw demo deleted after retention; only re-analysis is possible'}>Re-parse</button>
    <button onclick={() => action('reanalyse', 'Re-analyse')} disabled={!m.hasParsedData}>Re-analyse</button>
    <button class="danger" onclick={remove}>Delete</button>
    {#if busyMsg}<span class="muted">{busyMsg}</span>{/if}
    <span class="spacer"></span>
    <span class="muted small">parser {m.parserVersion ?? '–'} · schema {m.schemaVersion ?? '–'} · {bytes(m.dataSize)}{m.parseMs ? ` · parsed in ${Math.round(m.parseMs / 1000)} s` : ''}</span>
  </div>

  {#if !players.length}
    {#if m.scraped?.players?.length}
      <section class="card">
        <h2>Scoreboard from Steam</h2>
        <p class="muted">The demo isn’t analysed{m.status === 'expired' ? ' (replay expired)' : ' yet'}; this is the scoreboard scraped from your GCPD page. Score {m.scraped.scoreText}.</p>
        <table>
          <thead><tr><th>Player</th><th class="num">K</th><th class="num">A</th><th class="num">D</th><th class="num">HS</th><th class="num">Score</th></tr></thead>
          <tbody>
            {#each m.scraped.players as p}
              <tr class:team-b-row={p.team === 1}><td>{p.name}</td><td class="num">{p.kills}</td><td class="num">{p.assists}</td><td class="num">{p.deaths}</td><td class="num">{p.hsp}</td><td class="num">{p.score}</td></tr>
            {/each}
          </tbody>
        </table>
      </section>
    {:else}
      <p class="muted">No analysis yet.</p>
    {/if}
  {:else}
    <div class="tabs">
      <button class:active={tab === 'scoreboard'} onclick={() => (tab = 'scoreboard')}>Scoreboard</button>
      <button class:active={tab === 'rounds'} onclick={() => (tab = 'rounds')}>Rounds</button>
      <button class:active={tab === 'utility'} onclick={() => (tab = 'utility')}>Utility & economy</button>
      <button class:active={tab === 'cheat'} onclick={() => (tab = 'cheat')}>Cheat analysis</button>
    </div>

    {#if tab === 'scoreboard'}
      {#each [['A', teamA], ['B', teamB]] as [letter, team]}
        <section class="card table-wrap">
          <h3 class={letter === 'A' ? 'team-a' : 'team-b'}>Team {letter} {letter === ownTeam ? '(you)' : ''} · started {(team as Any[])[0]?.startSide === 2 ? 'T' : 'CT'} · {letter === 'A' ? data.summary.scoreA : data.summary.scoreB} rounds</h3>
          <table>
            <thead>
              <tr><th>Player</th>{#each STAT_COLS as [h, title]}<th class="num" {title}>{h}</th>{/each}<th>Suspicion</th></tr>
            </thead>
            <tbody>
              {#each team as Any[] as p}
                <tr class:me={p.steamId === me.steamId}>
                  <td><a href="/players/{p.steamId}">{p.name}</a>{#if p.rank}<span class="muted small" title="Rank / rating from the demo"> · {p.rank.toLocaleString()}</span>{/if}</td>
                  {#each STAT_COLS as [, , f]}<td class="num">{f(p)}</td>{/each}
                  <td><SuspicionBadge score={scoreOf(p.steamId)?.score} insufficient={!!scoreOf(p.steamId)} /></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </section>
      {/each}
      <section class="card">
        <h3>Weapons</h3>
        <div class="row">
          <select bind:value={selected}>
            <option value={null}>Pick a player</option>
            {#each players as p}<option value={p.steamId}>{p.name}</option>{/each}
          </select>
        </div>
        {#if selected}
          {@const p = players.find((x) => x.steamId === selected)!}
          <div class="table-wrap">
            <table>
              <thead><tr><th>Weapon</th><th class="num">Kills</th><th class="num">HS%</th><th class="num">Damage</th><th class="num">Shots</th><th class="num">Hits</th><th class="num">Accuracy</th></tr></thead>
              <tbody>
                {#each weaponRows(p) as [w, s]}
                  <tr><td>{w}</td><td class="num">{s.kills}</td><td class="num">{num(s.hsPercent)}</td><td class="num">{s.damage}</td><td class="num">{s.shots}</td><td class="num">{s.hits}</td><td class="num">{s.accuracy === null ? '–' : `${num(s.accuracy, 1)}%`}</td></tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </section>
    {:else if tab === 'rounds'}
      <section class="card table-wrap">
        <table>
          <thead><tr><th>#</th><th>Winner</th><th>Reason</th><th class="num">Score</th><th>First death</th>{#if !isRush}<th>Buy A</th><th>Buy B</th>{/if}<th>Kills (damage)</th></tr></thead>
          <tbody>
            {#each data.rounds as r}
              <tr>
                <td>{r.round}</td>
                <td class={r.winner === 'A' ? 'team-a' : r.winner === 'B' ? 'team-b' : ''}>{r.winner ? `Team ${r.winner}` : '–'} <span class="muted">{r.winnerSide ?? ''}</span></td>
                <td>{r.winReason ?? '–'}</td>
                <td class="num">{r.scoreA} : {r.scoreB}</td>
                <td>{r.firstDeath ? `${nameOf(r.firstDeath.victim)}${r.firstDeath.attacker ? ` (by ${nameOf(r.firstDeath.attacker)})` : ''}` : '–'}</td>
                {#if !isRush}<td>{r.teams.A.buyType ?? '–'} <span class="muted small">${r.teams.A.equipValue}</span></td><td>{r.teams.B.buyType ?? '–'} <span class="muted small">${r.teams.B.equipValue}</span></td>{/if}
                <td class="small">
                  {#each Object.entries(r.players as Record<string, Any>).filter(([, s]) => s.kills > 0 || s.damage > 0).sort((a, b) => b[1].kills - a[1].kills) as [sid, s]}
                    <span class="pk">{nameOf(sid)} {s.kills}k ({s.damage})</span>
                  {/each}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </section>
    {:else if tab === 'utility'}
      <section class="card table-wrap">
        <h3>Utility</h3>
        <table>
          <thead>
            <tr>
              <th>Player</th><th class="num" title="Flashbangs thrown">Flashes</th><th class="num">Enemies flashed</th><th class="num">Team flashed</th><th class="num">Avg blind (s)</th>
              <th class="num">Flash assists</th><th class="num">HE dmg</th><th class="num">Fire dmg</th><th class="num">Smokes</th><th class="num">Utility dmg / round</th><th class="num" title="Grenade value carried at death">Unused at death</th>
            </tr>
          </thead>
          <tbody>
            {#each players as p}
              <tr>
                <td class={p.team === 'A' ? 'team-a' : 'team-b'}>{p.name}</td>
                <td class="num">{p.utility.flashesThrown}</td><td class="num">{p.utility.enemiesFlashed}</td><td class="num">{p.utility.teammatesFlashed}</td>
                <td class="num">{num(p.utility.avgEnemyBlindS, 2)}</td><td class="num">{p.utility.flashAssists}</td><td class="num">{p.utility.heDamage}</td>
                <td class="num">{p.utility.fireDamage}</td><td class="num">{p.utility.smokesThrown}</td><td class="num">{num(p.utility.utilityDamagePerRound, 1)}</td>
                <td class="num">${p.utility.unusedUtilityValue}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </section>
      {#if !isRush && data.summary.economy}
        <section class="card table-wrap">
          <h3>Economy</h3>
          <p class="muted small">Buy type per team from average equipment value at buy-time end: eco &lt; ${data.summary.economyConfig.ecoBelow}, full ≥ ${data.summary.economyConfig.fullBuyFrom}, in between force if less than ${data.summary.economyConfig.forceMoneyLeftBelow} left per player, else half buy.</p>
          <table>
            <thead><tr><th>Team</th>{#each ['pistol', 'eco', 'force', 'half', 'full'] as bt}<th class="num">{bt}</th>{/each}</tr></thead>
            <tbody>
              {#each ['A', 'B'] as t}
                <tr>
                  <td class={t === 'A' ? 'team-a' : 'team-b'}>Team {t}</td>
                  {#each ['pistol', 'eco', 'force', 'half', 'full'] as bt}
                    {@const e = data.summary.economy[t][bt]}
                    <td class="num">{e.rounds ? `${e.won}/${e.rounds} (${Math.round((100 * e.won) / e.rounds)}%)` : '–'}</td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
          <h3>Money</h3>
          <table>
            <thead><tr><th>Player</th><th class="num">Money spent</th><th class="num">Avg equipment value</th></tr></thead>
            <tbody>
              {#each players as p}<tr><td class={p.team === 'A' ? 'team-a' : 'team-b'}>{p.name}</td><td class="num">${p.economy.moneySpent}</td><td class="num">${p.economy.avgEquipValue ?? '–'}</td></tr>{/each}
            </tbody>
          </table>
          <h3>Purchases per round</h3>
          <p class="muted small">Items gained during buy time (from inventory changes; the demos carry no item_purchase event, so picked-up drops count too).</p>
          <div class="table-wrap">
            <table>
              <thead><tr><th>#</th>{#each players as p}<th class={p.team === 'A' ? 'team-a' : 'team-b'}>{p.name}</th>{/each}</tr></thead>
              <tbody>
                {#each data.rounds as r}
                  <tr><td>{r.round}</td>{#each players as p}<td class="small">{(r.players[p.steamId]?.purchases ?? []).join(', ') || '–'}</td>{/each}</tr>
                {/each}
              </tbody>
            </table>
          </div>
        </section>
      {/if}
    {:else if tab === 'cheat'}
      <div class="notice">
        Suspicion scores compare each player to the distribution over all players in <strong>your own</strong> demos. They are an aid for
        investigation, not a verdict: GOTV data is coarse, visibility uses the game’s spotted mask (approximate), and good players are outliers too.
      </div>
      <section class="card table-wrap">
        <table>
          <thead>
            <tr><th>Player</th><th>Score</th>{#each data.indicators as ind}<th class="num" title={ind.description}>{ind.name}</th>{/each}</tr>
          </thead>
          <tbody>
            {#each players as p}
              {@const s = scoreOf(p.steamId)}
              <tr class="clickable" class:sel={selected === p.steamId} onclick={() => (selected = selected === p.steamId ? null : p.steamId)}>
                <td class={p.team === 'A' ? 'team-a' : 'team-b'}>{p.name}</td>
                <td><SuspicionBadge score={s?.score} insufficient={!!s} /></td>
                {#each data.indicators as ind}
                  {@const r = resultOf(p.steamId, ind.id)}
                  {@const c = (s?.breakdown as Any[] | undefined)?.find((b) => b.indicator === ind.id)}
                  <td class="num" title={r ? `${r.samples} samples` : ''}>
                    {#if r}
                      {ind.score.stratified ? fmtMetric('hs_rate_overall', r.metrics.hs_rate_overall) : fmtMetric(ind.score.metric, r.metrics[ind.score.metric])}
                      {#if c?.status === 'ok' && c.points > 0}<span class="pts">+{c.points.toFixed(1)}</span>{/if}
                    {:else}–{/if}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
        <p class="muted small">Values show each indicator’s scored metric (accuracy: HS% of hits overall). “+n” is the points it adds to the 0–100 score. Click a player for the breakdown.</p>
      </section>

      {#if selected}
        {@const s = scoreOf(selected)}
        <section class="card">
          <h3>{nameOf(selected)} · <a href="/players/{selected}">all matches</a></h3>
          {#if s}
            <div class="table-wrap">
              <table>
                <thead><tr><th>Indicator</th><th>Metric</th><th class="num">Value</th><th class="num">Baseline median</th><th class="num">Percentile</th><th class="num">Samples</th><th class="num">Weight</th><th class="num">Points</th><th>Status</th></tr></thead>
                <tbody>
                  {#each s.breakdown as c}
                    <tr>
                      <td>{c.name}</td><td class="muted">{c.metric}</td><td class="num">{fmtMetric(c.metric, c.value)}</td><td class="num">{fmtMetric(c.metric, c.baselineMedian)}</td>
                      <td class="num">{c.percentile === null ? '–' : pct(c.percentile)}</td><td class="num">{c.samples}</td><td class="num">{c.weight}</td>
                      <td class="num">{c.points ? c.points.toFixed(1) : '0'}</td>
                      <td class="muted">{c.status === 'ok' ? '' : c.status.replaceAll('_', ' ')}{c.status === 'insufficient_baseline' ? ` (${c.baselineN} in baseline)` : ''}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {:else}
            <p class="muted">No score computed yet.</p>
          {/if}
          <h3>Indicator details</h3>
          {#each data.indicators as ind}
            {@const r = resultOf(selected, ind.id)}
            {#if r}
              <details>
                <summary>{ind.name} <span class="muted">· {r.samples} samples{r.flags.length ? ` · ${r.flags.length} flagged moments` : ''}</span></summary>
                <p class="muted small">{ind.description}</p>
                <table>
                  <tbody>
                    {#each Object.entries(r.metrics).filter(([k]) => !k.endsWith('#n')) as [k, v]}<tr><td class="muted">{k}</td><td class="num">{fmtMetric(k, v as number)}</td></tr>{/each}
                  </tbody>
                </table>
                {#if r.flags.length}
                  <h4>Flagged moments</h4>
                  <ul>
                    {#each r.flags as f}<li>Round {f.round ?? '?'}, tick {f.tick}{f.victim ? ` vs ${nameOf(f.victim)}` : ''}: {f.note}</li>{/each}
                  </ul>
                {/if}
              </details>
            {/if}
          {/each}
        </section>
      {/if}
    {/if}
  {/if}
{/if}

<style>
  .head { align-items: flex-start; }
  .score { font-size: 34px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .actions { margin-bottom: 16px; }
  .small { font-size: 12px; }
  tr.me td { background: color-mix(in srgb, var(--accent) 8%, transparent); }
  tr.sel td { background: var(--surface-2); }
  .pk { margin-right: 10px; }
  .pts { color: var(--warning); font-size: 11px; margin-left: 4px; }
  details { border-top: 1px solid var(--border); padding: 8px 0; }
  summary { cursor: pointer; }
  table td.small { white-space: normal; min-width: 120px; }
</style>

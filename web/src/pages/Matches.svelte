<script lang="ts">
  import type { MatchListItem, MatchScoreboard, MeResponse } from '../../../shared/src/api.ts';
  import StatusBadge from '../components/StatusBadge.svelte';
  import SuspicionBadge from '../components/SuspicionBadge.svelte';
  import { api } from '../lib/api.ts';
  import { fmtDate, mapName, modeName, num } from '../lib/format.ts';
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
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const BUSY = ['queued', 'downloading', 'parsing', 'analysing'];
  let notice = $state<string | null>(null);

  // Clicking a row expands a simplified scoreboard; cached per match + status so it refreshes once analysis finishes.
  let expanded = $state<number | null>(null);
  let boards = $state<Record<string, MatchScoreboard | { error: string }>>({});
  const boardKey = (m: MatchListItem) => `${m.id}:${m.status}`;
  function toggle(m: MatchListItem) {
    expanded = expanded === m.id ? null : m.id;
  }
  $effect(() => {
    const m = matches.find((x) => x.id === expanded);
    if (!m) return;
    const key = boardKey(m);
    if (boards[key]) return;
    api<MatchScoreboard>(`/api/matches/${m.id}/scoreboard`)
      .then((b) => (boards[key] = b))
      .catch((e) => (boards[key] = { error: (e as Error).message }));
  });

  async function action(m: MatchListItem, path: MenuItem['path'], label: string, menu: HTMLElement) {
    menu.hidePopover();
    try {
      if (path === 'keep') await api(`/api/matches/${m.id}/keep`, { method: 'POST', body: { keep: !m.keepRaw } });
      else await api(`/api/matches/${m.id}/${path}`, { method: 'POST' });
      notice = path === 'keep' ? `${label}: ${mapName(m.map)} (${fmtDate(m.playedAt)}).` : `${label} queued for ${mapName(m.map)} (${fmtDate(m.playedAt)}).`;
      error = null;
      load();
    } catch (e) {
      error = `${label} failed: ${(e as Error).message}`;
    }
  }

  type MenuItem = { path: 'reparse' | 'reanalyse' | 'keep'; label: string; disabled: boolean; title: string };
  function menuItems(m: MatchListItem): MenuItem[] {
    const busy = BUSY.includes(m.status);
    return [
      { path: 'reparse', label: 'Re-parse', disabled: !m.hasRaw || busy, title: m.hasRaw ? 'Parse the raw demo again' : 'Raw demo deleted after retention; only re-analysis is possible' },
      { path: 'reanalyse', label: 'Re-analyse', disabled: busy, title: 'Run the analysis again from stored tick data' },
      m.keepRaw
        ? { path: 'keep', label: 'Stop keeping demo', disabled: false, title: 'Let retention cleanup remove the raw demo again' }
        : { path: 'keep', label: 'Keep demo', disabled: !m.hasRaw, title: m.hasRaw ? 'Never remove this raw demo during retention cleanup' : 'Raw demo already deleted after retention' },
    ];
  }

  // The menu lives in the top layer (popover), so the scrolling table can't clip it; place it under its button.
  function placeMenu(e: ToggleEvent) {
    if (e.newState !== 'open') return;
    const menu = e.currentTarget as HTMLElement;
    const btn = document.querySelector(`[popovertarget="${menu.id}"]`)!.getBoundingClientRect();
    menu.style.top = `${btn.bottom + 4}px`;
    menu.style.left = `${Math.max(8, btn.right - menu.offsetWidth)}px`;
  }

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
    const busy = matches.some((m) => BUSY.includes(m.status));
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
{#if notice}<div class="notice">{notice}</div>{/if}

{#if loaded && !matches.length}
  <div class="card"><p>No matches yet. <a href="/import">Import some demos</a> with the extension or a file upload.</p></div>
{:else}
  <div class="card table-wrap">
    <table>
      <thead>
        <tr><th>Date</th><th>Mode</th><th>Map</th><th class="num">Score</th><th class="num">K / D</th><th>Status</th><th>Highest suspicion</th><th></th></tr>
      </thead>
      <tbody>
        {#each matches as m (m.id)}
          <tr class="clickable" class:open={expanded === m.id} onclick={() => toggle(m)} aria-expanded={expanded === m.id}>
            <td><a href="/matches/{m.id}" onclick={(e) => e.stopPropagation()}>{fmtDate(m.playedAt)}</a></td>
            <td>{modeName(m.mode)}</td>
            <td>{mapName(m.map)}</td>
            <td class="num" class:win={m.scoreOwn !== null && m.scoreOpp !== null && m.scoreOwn > m.scoreOpp} class:loss={m.scoreOwn !== null && m.scoreOpp !== null && m.scoreOwn < m.scoreOpp}>{m.scoreText ?? '–'}</td>
            <td class="num">{m.ownKills ?? '–'} / {m.ownDeaths ?? '–'}</td>
            <td><StatusBadge status={m.status} error={m.error} /></td>
            <td>{#if m.status === 'analysed'}<SuspicionBadge score={m.maxSuspicion} insufficient />{:else}<span class="muted">–</span>{/if}</td>
            <td class="row-actions" onclick={(e) => e.stopPropagation()}>
              {#if m.hasRaw && m.keepRaw}
                <span class="kept" title="Demo kept: never removed by retention cleanup" aria-label="Demo kept">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z" /></svg>
                </span>
              {/if}
              {#if m.hasRaw}
                <a class="button icon" href="/api/matches/{m.id}/demo?tz={encodeURIComponent(tz)}" download title="Download demo (unpacked .dem)" aria-label="Download demo">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
                </a>
              {/if}
              <button class="icon" popovertarget="menu-{m.id}" title="More actions" aria-label="More actions">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" /></svg>
              </button>
              <div class="menu" id="menu-{m.id}" popover ontoggle={placeMenu}>
                {#each menuItems(m) as a}
                  <button disabled={a.disabled} title={a.title} onclick={(e) => action(m, a.path, a.label, (e.currentTarget as HTMLElement).parentElement!)}>{a.label}</button>
                {/each}
              </div>
            </td>
          </tr>
          {#if expanded === m.id}
            {@const b = boards[boardKey(m)]}
            <tr class="expand">
              <td colspan="8">
                <button class="details" onclick={() => navigate(`/matches/${m.id}`)}>Show match details</button>
                {#if !b}
                  <p class="muted">Loading…</p>
                {:else if 'error' in b}
                  <div class="error-box">{b.error}</div>
                {:else if !b.players.length}
                  <p class="muted">No scoreboard yet: the demo isn’t analysed.</p>
                {:else}
                  <div class="boards">
                    {#each ['A', 'B'] as const as letter}
                      {@const team = b.players.filter((p) => p.team === letter)}
                      <table>
                        <thead>
                          <tr>
                            <th class={letter === 'A' ? 'team-a' : 'team-b'}>
                              Team {letter}{team.some((p) => p.steamId === me.steamId) ? ' (you)' : ''}
                              <span class="muted">· {letter === 'A' ? b.scoreA ?? '–' : b.scoreB ?? '–'}</span>
                            </th>
                            <th class="num" title="Kills">K</th><th class="num" title="Assists">A</th><th class="num" title="Deaths">D</th>
                            <th class="num" title="Kill/death ratio">K/D</th><th class="num" title="Average damage per round">ADR</th><th>Suspicion</th>
                          </tr>
                        </thead>
                        <tbody>
                          {#each team as p (p.steamId)}
                            <tr class:me={p.steamId === me.steamId}>
                              <td><a href="/players/{p.steamId}">{p.name}</a></td>
                              <td class="num">{p.kills}</td><td class="num">{p.assists}</td><td class="num">{p.deaths}</td>
                              <td class="num">{num(p.kd, 2)}</td><td class="num">{num(p.adr, 1)}</td>
                              <td><SuspicionBadge score={p.suspicion} insufficient={p.scored} /></td>
                            </tr>
                          {/each}
                        </tbody>
                      </table>
                    {/each}
                  </div>
                {/if}
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .filters { margin-bottom: 12px; }
  td.win { color: var(--good); }
  td.loss { color: var(--critical); }
  .row-actions { text-align: right; cursor: default; }
  .row-actions .icon { padding: 4px 6px; vertical-align: middle; }
  .row-actions .icon + .icon { margin-left: 4px; }
  .kept { color: var(--accent); margin-right: 6px; vertical-align: middle; display: inline-flex; }
  .menu { position: fixed; inset: auto; margin: 0; padding: 4px; min-width: 140px; background: var(--surface-1); color: var(--text-primary); border: 1px solid var(--border); border-radius: 6px; box-shadow: 0 6px 20px rgb(0 0 0 / 0.4); }
  .menu:popover-open { display: flex; flex-direction: column; }
  .menu button { border: 0; background: none; justify-content: flex-start; padding: 6px 10px; }
  .menu button:not(:disabled):hover { background: var(--surface-2); }
  tr.open td { background: var(--surface-2); }
  tr.expand > td { background: var(--bg); padding: 12px; }
  .details { width: 100%; justify-content: center; margin-bottom: 12px; }
  .boards { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .boards table { width: 100%; }
  .boards tr.me td { background: color-mix(in srgb, var(--accent) 8%, transparent); }
  @media (max-width: 900px) { .boards { grid-template-columns: 1fr; } }
</style>

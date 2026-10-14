<script lang="ts">
  import type { MeResponse } from '../../shared/src/api.ts';
  import { api, loadMe } from './lib/api.ts';
  import { match, navigate, route } from './lib/router.svelte.ts';
  import Login from './pages/Login.svelte';
  import Matches from './pages/Matches.svelte';
  import Import from './pages/Import.svelte';
  import MatchDetail from './pages/MatchDetail.svelte';
  import Player from './pages/Player.svelte';
  import MyStats from './pages/MyStats.svelte';
  import Settings from './pages/Settings.svelte';
  import Admin from './pages/Admin.svelte';

  let me = $state<MeResponse | null>(null);
  let loading = $state(true);
  let fatal = $state<string | null>(null);

  async function refreshMe() {
    try {
      me = await loadMe();
    } catch (e) {
      fatal = (e as Error).message;
    } finally {
      loading = false;
    }
  }
  refreshMe();

  $effect(() => {
    if (!loading && !me && route.path !== '/login') navigate('/login', true);
    if (!loading && me && route.path === '/login') navigate('/', true);
  });

  async function logout() {
    await api('/auth/logout', { method: 'POST' });
    me = null;
    navigate('/login');
  }

  const links = $derived([
    ['/', 'Matches'],
    ['/import', 'Import'],
    ['/stats', 'My stats'],
    ['/settings', 'Settings'],
    ...(me?.isAdmin ? [['/admin', 'Admin']] : []),
  ]);
  const matchParams = $derived(match('/matches/:id', route.path));
  const playerParams = $derived(match('/players/:steamId', route.path));
</script>

{#if loading}
  <main><p class="muted">Loading…</p></main>
{:else if fatal}
  <main><div class="error-box">Could not reach the server: {fatal}</div></main>
{:else if !me}
  <Login />
{:else}
  <header>
    <nav>
      <a class="brand" href="/">demo-analyzer</a>
      {#each links as [href, label]}
        <a {href} class:active={href === '/' ? route.path === '/' || route.path.startsWith('/matches') : route.path.startsWith(href)}>{label}</a>
      {/each}
      <span class="spacer"></span>
      <span class="user">
        {#if me.avatarUrl}<img src={me.avatarUrl} alt="" width="24" height="24" />{/if}
        {me.username}
      </span>
      <button onclick={logout}>Log out</button>
    </nav>
  </header>
  <main>
    {#if route.path === '/'}
      <Matches {me} />
    {:else if matchParams}
      {#key matchParams.id}<MatchDetail id={matchParams.id} {me} />{/key}
    {:else if playerParams}
      {#key playerParams.steamId}<Player steamId={playerParams.steamId} />{/key}
    {:else if route.path === '/import'}
      <Import />
    {:else if route.path === '/stats'}
      <MyStats {me} />
    {:else if route.path === '/settings'}
      <Settings {me} onChange={refreshMe} />
    {:else if route.path === '/admin' && me.isAdmin}
      <Admin />
    {:else}
      <h1>Not found</h1>
    {/if}
  </main>
{/if}

<style>
  header { background: var(--surface-1); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 10; }
  nav { max-width: 1280px; margin: 0 auto; display: flex; align-items: center; gap: 4px; padding: 8px 16px; flex-wrap: wrap; }
  nav a { color: var(--text-secondary); padding: 6px 10px; border-radius: 6px; }
  nav a.active, nav a:hover { color: var(--text-primary); background: var(--surface-2); text-decoration: none; }
  .brand { color: var(--accent) !important; font-weight: 700; margin-right: 12px; background: none !important; }
  .spacer { flex: 1; }
  .user { display: flex; align-items: center; gap: 8px; color: var(--text-secondary); margin-right: 8px; }
  .user img { border-radius: 50%; }
</style>

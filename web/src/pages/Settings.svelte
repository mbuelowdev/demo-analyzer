<script lang="ts">
  import type { MeResponse } from '../../../shared/src/api.ts';
  import { untrack } from 'svelte';
  import { api } from '../lib/api.ts';
  import { fmtDate } from '../lib/format.ts';
  import { navigate } from '../lib/router.svelte.ts';

  let { me, onChange }: { me: MeResponse; onChange: () => void } = $props();
  interface Key { id: number; name: string; prefix: string; createdAt: number; lastUsedAt: number | null; revokedAt: number | null }
  let steamId = $state(untrack(() => me.steamId) ?? '');
  let steamMsg = $state<string | null>(null);
  let keys = $state<Key[]>([]);
  let keyName = $state('');
  let newKey = $state<string | null>(null);
  let confirmDelete = $state('');

  const loadKeys = async () => (keys = await api<Key[]>('/api/keys'));
  loadKeys();

  async function saveSteam() {
    try {
      await api('/api/me/steam-id', { method: 'PUT', body: { steamId: steamId.trim() || null } });
      steamMsg = 'Saved.';
      onChange();
    } catch (e) {
      steamMsg = (e as Error).message;
    }
  }
  async function createKey() {
    const r = await api<{ key: string }>('/api/keys', { method: 'POST', body: { name: keyName } });
    newKey = r.key;
    keyName = '';
    loadKeys();
  }
  async function revoke(id: number) {
    await api(`/api/keys/${id}`, { method: 'DELETE' });
    loadKeys();
  }
  async function deleteAll() {
    await api('/api/me/data', { method: 'DELETE' });
    confirmDelete = '';
    navigate('/');
  }
</script>

<h1>Settings</h1>

<section class="card">
  <h2>Linked SteamID64</h2>
  <p class="muted">Tells the app which player in a demo is you (personal stats, “My stats”). Detected automatically when the extension sees your GCPD page.</p>
  <div class="row">
    <input bind:value={steamId} placeholder="7656119…" size="22" />
    <button onclick={saveSteam}>Save</button>
    {#if steamMsg}<span class="muted">{steamMsg}</span>{/if}
  </div>
</section>

<section class="card">
  <h2>Extension API keys</h2>
  <div class="row">
    <input bind:value={keyName} placeholder="Name, e.g. Desktop Brave" />
    <button class="primary" onclick={createKey}>Create key</button>
  </div>
  {#if newKey}
    <div class="notice">
      Copy this key now, it won’t be shown again:
      <pre>{newKey}</pre>
      <button onclick={() => navigator.clipboard.writeText(newKey!)}>Copy</button>
    </div>
  {/if}
  <div class="table-wrap">
    <table>
      <thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th></th></tr></thead>
      <tbody>
        {#each keys as k}
          <tr>
            <td>{k.name}</td>
            <td><code>{k.prefix}…</code></td>
            <td>{fmtDate(new Date(k.createdAt).toISOString())}</td>
            <td>{k.lastUsedAt ? fmtDate(new Date(k.lastUsedAt).toISOString()) : 'never'}</td>
            <td>{#if k.revokedAt}<span class="muted">revoked</span>{:else}<button class="danger" onclick={() => revoke(k.id)}>Revoke</button>{/if}</td>
          </tr>
        {:else}
          <tr><td colspan="5" class="muted">No keys yet.</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>

<section class="card">
  <h2>Delete my data</h2>
  <p class="muted">Removes all your matches, their parsed data and raw demos (unless another user also imported the same match), and your API keys. Your login stays.</p>
  <div class="row">
    <input bind:value={confirmDelete} placeholder="type DELETE to confirm" />
    <button class="danger" disabled={confirmDelete !== 'DELETE'} onclick={deleteAll}>Delete everything</button>
  </div>
</section>

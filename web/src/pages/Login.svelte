<script lang="ts">
  import { route } from '../lib/router.svelte.ts';
  const messages: Record<string, string> = {
    not_whitelisted: 'Your Discord account is not on the whitelist. Ask the admin to add your Discord ID.',
    state: 'The login link expired or was tampered with. Please try again.',
    discord: 'Discord login failed. Please try again.',
    cancelled: 'Login was cancelled.',
  };
  const error = $derived(route.query.get('error'));
</script>

<main class="login">
  <div class="card">
    <h1>demo-analyzer</h1>
    <p class="secondary-text">Private CS2 demo collection, match stats and cheat-detection research.</p>
    {#if error}
      <div class="error-box">{messages[error] ?? 'Login failed.'}</div>
    {/if}
    <a class="button primary" href="/auth/discord/login" data-native>Login with Discord</a>
  </div>
</main>

<style>
  .login { max-width: 420px; padding-top: 12vh; }
  .card { text-align: center; padding: 28px; }
  .button { margin-top: 12px; }
</style>

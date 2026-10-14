<script lang="ts">
  let { status, error = null }: { status: string; error?: string | null } = $props();
  const colors: Record<string, string> = {
    queued: 'var(--text-muted)', downloading: 'var(--series-1)', parsing: 'var(--series-1)', analysing: 'var(--series-1)',
    analysed: 'var(--good)', failed: 'var(--critical)', expired: 'var(--warning)',
  };
  const busy = $derived(['downloading', 'parsing', 'analysing'].includes(status));
</script>

<span class="badge" title={error ?? ''}>
  <span class="dot" class:pulse={busy} style="background:{colors[status] ?? 'var(--text-muted)'}"></span>{status}
</span>

<style>
  .pulse { animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.3; } }
</style>

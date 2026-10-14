<script lang="ts">
  // Status colours always come with an icon and a label, never colour alone.
  let { score, insufficient = false }: { score: number | null | undefined; insufficient?: boolean } = $props();
  const level = $derived(score === null || score === undefined ? null : score >= 60 ? 'high' : score >= 30 ? 'elevated' : 'low');
</script>

{#if level === null}
  <span class="badge muted" title="Not enough data for a score (R-SCORE-3)">{insufficient ? 'insufficient data' : '–'}</span>
{:else}
  <span class="badge {level}" title="Suspicion score (0–100) vs your own baseline — an aid for investigation, not a verdict">
    {level === 'high' ? '▲' : level === 'elevated' ? '◆' : '●'} {score!.toFixed(0)} <span class="lbl">{level}</span>
  </span>
{/if}

<style>
  .high { border-color: var(--critical); color: var(--text-primary); }
  .high::first-letter { color: var(--critical); }
  .elevated { border-color: var(--warning); color: var(--text-primary); }
  .low { color: var(--text-secondary); }
  .lbl { color: var(--text-muted); font-size: 11px; }
</style>

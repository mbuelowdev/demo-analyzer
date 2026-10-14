<script lang="ts">
  // Single-series time chart (uPlot) with crosshair + tooltip. One series per chart; compare metrics
  // with small multiples, never a second y-axis.
  import uPlot from 'uplot';
  import { onDestroy } from 'svelte';

  let {
    title,
    points,
    format = (v: number) => v.toFixed(2),
    height = 180,
    onSelect,
  }: { title: string; points: { x: number; y: number | null; label?: string }[]; format?: (v: number) => string; height?: number; onSelect?: (i: number) => void } = $props();

  let el = $state<HTMLDivElement>();
  let plot: uPlot | null = null;
  let tip = $state<{ left: number; top: number; text: string; sub: string } | null>(null);

  function css(name: string) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function build() {
    plot?.destroy();
    if (!el || !points.length) return;
    const xs = points.map((p) => p.x / 1000);
    const ys = points.map((p) => p.y);
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const series = css('--series-1');
    const axis = { stroke: css('--text-muted'), grid: { stroke: css('--border'), width: 1 }, ticks: { show: false }, font: '11px system-ui' };
    plot = new uPlot(
      {
        width: el.clientWidth || 400,
        height,
        legend: { show: false },
        cursor: { points: { size: 8, fill: series }, drag: { x: false, y: false } },
        // A lone point (or a cluster within an hour) gets a fixed ±1 day window instead of uPlot's multi-year auto range.
        scales: { x: { time: true, ...(xMax - xMin < 3600 ? { auto: false, range: [xMin - 86400, xMax + 86400] as [number, number] } : {}) } },
        axes: [axis, { ...axis, size: 48, values: (_u, vals) => vals.map((v) => format(v)) }],
        series: [{}, { stroke: series, width: 2, points: { show: points.length < 40, size: 8, fill: series, stroke: css('--surface-1'), width: 2 }, spanGaps: true }],
        hooks: {
          setCursor: [
            (u) => {
              const i = u.cursor.idx;
              if (i === null || i === undefined || ys[i] === null) {
                tip = null;
                return;
              }
              tip = {
                left: u.valToPos(xs[i], 'x'),
                top: u.valToPos(ys[i] as number, 'y'),
                text: format(ys[i] as number),
                sub: points[i].label ?? new Date(points[i].x).toLocaleDateString(),
              };
            },
          ],
        },
      },
      [xs, ys],
      el,
    );
    if (onSelect) plot.over.addEventListener('click', () => plot?.cursor.idx != null && onSelect!(plot.cursor.idx));
  }

  $effect(() => {
    void points;
    build();
  });

  const ro = new ResizeObserver(() => plot && el && plot.setSize({ width: el.clientWidth, height }));
  $effect(() => {
    if (el) ro.observe(el);
  });
  onDestroy(() => {
    ro.disconnect();
    plot?.destroy();
  });
</script>

<figure class="chart">
  <figcaption>{title}</figcaption>
  {#if points.length}
    <div class="plot" bind:this={el}>
      {#if tip}
        <div class="tip" style="left:{tip.left + 48}px;top:{tip.top}px"><strong>{tip.text}</strong><span>{tip.sub}</span></div>
      {/if}
    </div>
  {:else}
    <p class="muted">No data yet.</p>
  {/if}
</figure>

<style>
  .chart { margin: 0; background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px; }
  figcaption { color: var(--text-secondary); font-size: 13px; margin-bottom: 4px; }
  .plot { position: relative; width: 100%; }
  .tip {
    position: absolute; transform: translate(-50%, calc(-100% - 12px)); pointer-events: none; background: var(--surface-2);
    border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; font-size: 12px; display: flex; flex-direction: column; white-space: nowrap; z-index: 2;
  }
  .tip span { color: var(--text-muted); }
</style>

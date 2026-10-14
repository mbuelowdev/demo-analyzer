// R-SCORE-1..5: per-user baselines and suspicion scores. Baselines come only from the user's own demos (R-PRIV-3).
import { kvGet, now, type DB } from '../db/index.ts';
import { INDICATORS } from './indicators.ts';

export interface ScoreConfig {
  /** Per indicator weight (0 disables). */
  weights: Record<string, number>;
  /** Per indicator minimum samples per player-match. */
  minSamples: Record<string, number>;
  /** Minimum number of player-match values in the user's baseline for a metric. */
  baselineMin: number;
  /** Minimum number of indicators with enough data for a score. */
  minIndicators: number;
}

export const SCORE_CONFIG_KEY = 'score_config';

export function defaultScoreConfig(): ScoreConfig {
  return {
    weights: Object.fromEntries(INDICATORS.map((i) => [i.id, i.score.defaultWeight])),
    minSamples: Object.fromEntries(INDICATORS.map((i) => [i.id, i.score.minSamples])),
    baselineMin: 20,
    minIndicators: 3,
  };
}

export function loadScoreConfig(db: DB): ScoreConfig {
  const def = defaultScoreConfig();
  const row = kvGet(db, SCORE_CONFIG_KEY);
  if (!row) return def;
  try {
    const c = JSON.parse(row.value) as Partial<ScoreConfig>;
    return {
      weights: { ...def.weights, ...(c.weights ?? {}) },
      minSamples: { ...def.minSamples, ...(c.minSamples ?? {}) },
      baselineMin: typeof c.baselineMin === 'number' ? c.baselineMin : def.baselineMin,
      minIndicators: typeof c.minIndicators === 'number' ? c.minIndicators : def.minIndicators,
    };
  } catch {
    return def;
  }
}

export interface Contribution {
  indicator: string;
  name: string;
  metric: string;
  value: number | null;
  samples: number;
  /** Share of the user's baseline that is less suspicious than this value (0–1). */
  percentile: number | null;
  baselineN: number;
  baselineMedian: number | null;
  weight: number;
  /** Points this indicator adds to the 0–100 score. */
  points: number;
  status: 'ok' | 'insufficient_samples' | 'insufficient_baseline' | 'disabled';
}

/** Percentile of `v` within sorted `xs` (mid-rank for ties). */
function percentileOf(xs: number[], v: number): number {
  let below = 0;
  let equal = 0;
  for (const x of xs) {
    if (x < v) below++;
    else if (x === v) equal++;
  }
  return (below + equal / 2) / xs.length;
}

/** Turns a 0–1 "how unusual" value into a 0–1 suspicion component: nothing below the median, steep in the tail. */
function component(s: number): number {
  return Math.max(0, (s - 0.5) / 0.5) ** 2;
}

interface IndRow {
  match_id: number;
  steam_id: string;
  indicator: string;
  samples: number;
  metrics_json: string;
}

export function scoreUser(db: DB, userId: number) {
  const cfg = loadScoreConfig(db);
  const rows = db
    .prepare(
      `SELECT m.id AS match_id, i.steam_id, i.indicator, i.samples, i.metrics_json
       FROM matches m JOIN demos d ON d.id = m.demo_id AND d.status = 'analysed'
       JOIN indicator_results i ON i.demo_id = m.demo_id
       WHERE m.user_id = ?`,
    )
    .all(userId) as IndRow[];

  // Baseline values per (indicator, metric key), one per player-match with enough samples.
  const baseline = new Map<string, number[]>();
  const parsed = rows.map((r) => ({ ...r, metrics: JSON.parse(r.metrics_json) as Record<string, number | null> }));
  for (const r of parsed) {
    const ind = INDICATORS.find((i) => i.id === r.indicator);
    if (!ind) continue;
    for (const [key, value] of metricValues(ind.score.metric, !!ind.score.stratified, r.metrics, cfg.minSamples[ind.id] ?? ind.score.minSamples, r.samples)) {
      const k = `${ind.id}:${key}`;
      let arr = baseline.get(k);
      if (!arr) baseline.set(k, (arr = []));
      arr.push(value);
    }
  }
  for (const arr of baseline.values()) arr.sort((a, b) => a - b);

  const byPlayerMatch = new Map<string, typeof parsed>();
  for (const r of parsed) {
    const k = `${r.match_id}:${r.steam_id}`;
    let arr = byPlayerMatch.get(k);
    if (!arr) byPlayerMatch.set(k, (arr = []));
    arr.push(r);
  }

  const t = now();
  const upsert = db.prepare(
    `INSERT INTO suspicion_scores (match_id, steam_id, score, samples, breakdown_json, computed_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(match_id, steam_id) DO UPDATE SET score = excluded.score, samples = excluded.samples, breakdown_json = excluded.breakdown_json, computed_at = excluded.computed_at`,
  );
  db.transaction(() => {
    db.prepare('DELETE FROM suspicion_scores WHERE match_id IN (SELECT id FROM matches WHERE user_id = ?)').run(userId);
    const maxPerMatch = new Map<number, number>();
    for (const [key, list] of byPlayerMatch) {
      const [matchId, steamId] = key.split(':');
      const contributions: Contribution[] = [];
      for (const ind of INDICATORS) {
        const r = list.find((x) => x.indicator === ind.id);
        const weight = cfg.weights[ind.id] ?? 0;
        const minSamples = cfg.minSamples[ind.id] ?? ind.score.minSamples;
        const base: Contribution = { indicator: ind.id, name: ind.name, metric: ind.score.metric, value: null, samples: r?.samples ?? 0, percentile: null, baselineN: 0, baselineMedian: null, weight, points: 0, status: 'insufficient_samples' };
        if (weight <= 0) {
          contributions.push({ ...base, status: 'disabled' });
          continue;
        }
        if (!r) {
          contributions.push(base);
          continue;
        }
        const values = metricValues(ind.score.metric, !!ind.score.stratified, r.metrics, minSamples, r.samples);
        if (!values.length) {
          contributions.push(base);
          continue;
        }
        // Stratified metrics: sample-weighted mean of per-stratum percentiles (each vs its own baseline).
        let pSum = 0;
        let wSum = 0;
        let bn = 0;
        let vSum = 0;
        let medSum = 0;
        for (const [k, v, n] of values) {
          const b = baseline.get(`${ind.id}:${k}`) ?? [];
          if (b.length < cfg.baselineMin) continue;
          const pct = percentileOf(b, v);
          const w = n ?? 1;
          pSum += (ind.score.suspicious === 'high' ? pct : 1 - pct) * w;
          vSum += v * w;
          medSum += b[Math.floor(b.length / 2)] * w;
          wSum += w;
          bn = Math.max(bn, b.length);
        }
        if (wSum === 0) {
          contributions.push({ ...base, value: values[0][1], status: 'insufficient_baseline', baselineN: baseline.get(`${ind.id}:${values[0][0]}`)?.length ?? 0 });
          continue;
        }
        contributions.push({ ...base, value: round3(vSum / wSum), percentile: round3(pSum / wSum), baselineN: bn, baselineMedian: round3(medSum / wSum), status: 'ok' });
      }
      const ok = contributions.filter((c) => c.status === 'ok');
      const totalWeight = ok.reduce((s, c) => s + c.weight, 0);
      let score: number | null = null;
      if (ok.length >= cfg.minIndicators && totalWeight > 0) {
        for (const c of ok) c.points = round3((100 * c.weight * component(c.percentile!)) / totalWeight);
        score = Math.round(ok.reduce((s, c) => s + c.points, 0) * 10) / 10;
      }
      const samples = list.reduce((s, r) => s + r.samples, 0);
      upsert.run(Number(matchId), steamId, score, samples, JSON.stringify(contributions), t);
      if (score !== null) maxPerMatch.set(Number(matchId), Math.max(maxPerMatch.get(Number(matchId)) ?? 0, score));
    }
    db.prepare('UPDATE matches SET max_suspicion = NULL, scored_at = ? WHERE user_id = ?').run(t, userId);
    const upd = db.prepare('UPDATE matches SET max_suspicion = ? WHERE id = ? AND user_id = ?');
    for (const [m, s] of maxPerMatch) upd.run(s, m, userId);
  })();
}

/** [metricKey, value, sampleWeight] tuples for the scored metric. */
function metricValues(metric: string, stratified: boolean, metrics: Record<string, number | null>, minSamples: number, samples: number): [string, number, number | undefined][] {
  if (!stratified) {
    const v = metrics[metric];
    return samples >= minSamples && typeof v === 'number' && Number.isFinite(v) ? [[metric, v, undefined]] : [];
  }
  const out: [string, number, number | undefined][] = [];
  for (const [k, v] of Object.entries(metrics)) {
    if (!k.startsWith(`${metric}|`) || k.endsWith('#n') || typeof v !== 'number') continue;
    const n = metrics[`${k}#n`] ?? 0;
    if (typeof n === 'number' && n >= minSamples) out.push([k, v, n]);
  }
  return out;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

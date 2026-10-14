// Built-in reference distributions: the fallback baseline when a user's own demos don't yet give
// `baselineMin` values for a metric, so every match gets a score (R-SCORE-1). Aggregate quantiles only.
import data from './reference.json' with { type: 'json' };

export const REFERENCE_QUANTILES = Array.from({ length: 21 }, (_, i) => i / 20);

export interface ReferenceFile {
  generatedAt: string;
  matches: number;
  quantiles: number[];
  metrics: Record<string, { n: number; values: number[] }>;
}

export const REFERENCE = data as ReferenceFile;

/** Percentile (0–1) of `v` in the reference for `key` (`<indicator>:<metric key>`), or null if unknown. */
export function referencePercentile(key: string, v: number): number | null {
  const m = REFERENCE.metrics[key];
  if (!m || m.values.length < 2) return null;
  const qs = m.values;
  const ps = REFERENCE.quantiles;
  // Ties (flat stretches, e.g. many players at 0) take the middle of the tied range.
  let lo = -1;
  let hi = -1;
  for (let i = 0; i < qs.length; i++) {
    if (qs[i] === v) {
      if (lo < 0) lo = i;
      hi = i;
    }
  }
  if (lo >= 0) return (ps[lo] + ps[hi]) / 2;
  if (v < qs[0]) return 0;
  if (v > qs[qs.length - 1]) return 1;
  for (let i = 1; i < qs.length; i++) {
    if (v < qs[i]) return ps[i - 1] + ((v - qs[i - 1]) / (qs[i] - qs[i - 1])) * (ps[i] - ps[i - 1]);
  }
  return 1;
}

export function referenceMedian(key: string): number | null {
  const m = REFERENCE.metrics[key];
  return m ? m.values[10] : null;
}

import type { Candidate } from '../contracts.ts';
import { DEFAULT_THRESHOLDS, rejectReasons, type FilterThresholds } from './filter.ts';

/** Quick indicator score used to pick the shortlist before the simulation runs. */
export interface QuickWeights {
  transit: number; population: number; retail: number; attractions: number; walk: number; area: number;
}

export const DEFAULT_QUICK_WEIGHTS: QuickWeights = {
  transit: 0.30, population: 0.20, retail: 0.20, attractions: 0.10, walk: 0.10, area: 0.10,
};

/** Area counts up to a full 40-stall market (~40 stalls × 30 m² plus aisles); more space adds nothing. */
export const AREA_TARGET_M2 = 3000;

export interface RankOptions { thresholds?: FilterThresholds; weights?: QuickWeights }

type Normaliser = (v: number) => number;

function minMax(values: number[]): Normaliser {
  const lo = Math.min(...values), hi = Math.max(...values);
  return hi > lo ? v => (v - lo) / (hi - lo) : () => 1;
}

/** 0–100 per candidate; counts are min–max normalised over the candidates that passed the filter. */
export function quickScores(pool: Candidate[], w: QuickWeights = DEFAULT_QUICK_WEIGHTS): Map<string, number> {
  const sum = w.transit + w.population + w.retail + w.attractions + w.walk + w.area;
  const pop = minMax(pool.map(c => c.indicators.population800m));
  const ret = minMax(pool.map(c => c.indicators.retailPoi400m));
  const att = minMax(pool.map(c => c.indicators.attractions400m));
  const out = new Map<string, number>();
  for (const c of pool) {
    const i = c.indicators;
    const s = w.transit * i.transitScore / 100
      + w.population * pop(i.population800m)
      + w.retail * ret(i.retailPoi400m)
      + w.attractions * att(i.attractions400m)
      + w.walk * i.walkScore / 100
      + w.area * Math.min(1, c.areaM2 / AREA_TARGET_M2);
    out.set(c.id, Math.round(1000 * s / sum) / 10);
  }
  return out;
}

/**
 * Applies the filter and the quick ranking. Pure: returns new objects, input untouched.
 * Rejected sites keep their reasons; benchmarks that fail are still returned (they are always simulated).
 * Ties break on id, so the order is deterministic.
 */
export function rankCandidates(candidates: Candidate[], opts: RankOptions = {}): Candidate[] {
  const t = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const reasons = new Map(candidates.map(c => [c.id, rejectReasons(c, t)]));
  const passed = candidates.filter(c => reasons.get(c.id)!.length === 0);
  const scores = quickScores(passed, opts.weights);
  const order = [...passed].sort((a, b) => scores.get(b.id)! - scores.get(a.id)! || a.id.localeCompare(b.id));
  const rank = new Map(order.map((c, i) => [c.id, i + 1]));
  return candidates
    .map((c): Candidate => {
      const r = reasons.get(c.id)!;
      const { rejectReason: _r, quickRank: _q, quickScore: _s, ...rest } = c;
      return r.length
        ? { ...rest, passedFilter: false, rejectReason: r.join('; ') }
        : { ...rest, passedFilter: true, quickRank: rank.get(c.id)!, quickScore: scores.get(c.id)! };
    })
    .sort((a, b) => (a.quickRank ?? Infinity) - (b.quickRank ?? Infinity) || a.id.localeCompare(b.id));
}

export interface Focus { sites: string[]; baseline?: string }

/**
 * The sites that get simulated. With a focus (the organisers' options + today's site as baseline) exactly those,
 * in that order; otherwise the top `n` passing discovered sites plus every benchmark (pass or fail), in rank order.
 */
export function shortlist(ranked: Candidate[], n = 3, focus?: Focus): Candidate[] {
  if (focus) {
    const ids = [...focus.sites, ...(focus.baseline ? [focus.baseline] : [])];
    return ids.map(id => {
      const c = ranked.find(r => r.id === id);
      if (!c) throw new Error(`focus site "${id}" is not in the candidate list`);
      return c;
    });
  }
  const top = ranked.filter(c => c.passedFilter && c.kind !== 'benchmark').slice(0, n);
  const benches = ranked.filter(c => c.kind === 'benchmark');
  return [...top, ...benches].sort((a, b) => (a.quickRank ?? Infinity) - (b.quickRank ?? Infinity));
}

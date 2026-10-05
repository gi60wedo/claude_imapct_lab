import type { PersonaId, SimulationResult, Weights } from '../contracts';

export const WEIGHT_KEYS = [
  'accessibility', 'footfall', 'fairness', 'localBusiness', 'walkability',
] as const satisfies readonly (keyof Weights)[];

export const PERSONA_IDS = ['senior', 'vendor', 'commuter', 'retailer'] as const satisfies readonly PersonaId[];

/** Default MarketScore weights (plan §6). */
export const DEFAULT_WEIGHTS: Weights = {
  accessibility: 0.30, footfall: 0.25, fairness: 0.20, localBusiness: 0.15, walkability: 0.10,
};

/** A persona below this score flags the site as failing a stakeholder group. */
export const PERSONA_GUARD_THRESHOLD = 40;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Min-max normalise to 0–100. A constant series maps to 50 so it neither wins nor loses. */
export function normalizeIndicator(values: readonly number[], invert = false): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 50);
  return values.map((v) => {
    const n = ((v - min) / (max - min)) * 100;
    return invert ? 100 - n : n;
  });
}

/** Negative / non-finite weights count as zero; the result sums to 1 (uniform if all zero). */
export function normalizeWeights(w: Weights): Weights {
  const clean = WEIGHT_KEYS.map((k) => (Number.isFinite(w[k]) ? Math.max(0, w[k]) : 0));
  const total = clean.reduce((a, b) => a + b, 0);
  return Object.fromEntries(
    WEIGHT_KEYS.map((k, i) => [k, total === 0 ? 1 / WEIGHT_KEYS.length : clean[i] / total]),
  ) as unknown as Weights;
}

/** Gini coefficient of a non-negative series: 0 = perfectly equal, →1 = one stall gets everything. */
export function gini(values: readonly number[]): number {
  const xs = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  const n = xs.length;
  const sum = xs.reduce((a, b) => a + b, 0);
  if (n === 0 || sum === 0) return 0;
  let weighted = 0;
  xs.forEach((x, i) => { weighted += (i + 1) * x; });
  return clamp((2 * weighted) / (n * sum) - (n + 1) / n, 0, 1);
}

/** Fairness criterion: 100 × (1 − Gini(stallExposure)). */
export function fairnessFromExposure(stallExposure: readonly number[]): number {
  return 100 * (1 - gini(stallExposure));
}

/** MarketScore = Σ criterion × weight, on 0–100. Weights are renormalised first. */
export function marketScore(criteria: Weights, weights: Weights): number {
  const w = normalizeWeights(weights);
  return WEIGHT_KEYS.reduce((s, k) => s + clamp(criteria[k], 0, 100) * w[k], 0);
}

/** Personas scoring below the guard threshold, worst first. */
export function failedPersonas(result: Pick<SimulationResult, 'personas'>): PersonaId[] {
  return PERSONA_IDS
    .filter((p) => result.personas[p].score < PERSONA_GUARD_THRESHOLD)
    .sort((a, b) => result.personas[a].score - result.personas[b].score);
}

/** Mean persona score: the "consensus dial". Shown beside the total, never instead of it. */
export function consensus(result: Pick<SimulationResult, 'personas'>): number {
  return PERSONA_IDS.reduce((s, p) => s + result.personas[p].score, 0) / PERSONA_IDS.length;
}

export interface ScoredSite {
  candidateId: string;
  marketScore: number;
  consensus: number;
  failedPersonas: PersonaId[];
  failsStakeholderGroup: boolean;
  result: SimulationResult;
}

export function scoreSite(result: SimulationResult, weights: Weights = DEFAULT_WEIGHTS): ScoredSite {
  const failed = failedPersonas(result);
  return {
    candidateId: result.candidateId,
    marketScore: marketScore(result.criteria, weights),
    consensus: consensus(result),
    failedPersonas: failed,
    failsStakeholderGroup: failed.length > 0,
    result,
  };
}

/** Highest MarketScore first; ties keep input order. */
export function rankSites(results: readonly SimulationResult[], weights: Weights = DEFAULT_WEIGHTS): ScoredSite[] {
  return results.map((r) => scoreSite(r, weights)).sort((a, b) => b.marketScore - a.marketScore);
}

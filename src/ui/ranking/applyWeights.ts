import type { SimulationResult, Weights } from '../../contracts';

export const WEIGHT_KEYS = [
  'accessibility', 'footfall', 'fairness', 'localBusiness', 'walkability',
] as const satisfies readonly (keyof Weights)[];

export const PRESETS = [
  { name: 'Accessibility first', weights: { accessibility: 0.45, footfall: 0.20, fairness: 0.15, localBusiness: 0.10, walkability: 0.10 } },
  { name: 'Trader fairness first', weights: { accessibility: 0.20, footfall: 0.20, fairness: 0.40, localBusiness: 0.10, walkability: 0.10 } },
  { name: 'Local business first', weights: { accessibility: 0.20, footfall: 0.25, fairness: 0.10, localBusiness: 0.35, walkability: 0.10 } },
] as const satisfies readonly { name: string; weights: Weights }[];

/** Compute the weighted sum without changing either input. */
export function applyWeights(criteria: Weights, w: Weights): number {
  return WEIGHT_KEYS.reduce((score, key) => score + criteria[key] * w[key], 0);
}

/** Invalid/negative entries contribute zero; an all-zero vector becomes uniform. */
export function normalize(w: Weights): Weights {
  const clean = WEIGHT_KEYS.map((key) => Number.isFinite(w[key]) ? Math.max(0, w[key]) : 0);
  // Scale first so even large finite weights cannot overflow the sum.
  const scale = Math.max(...clean);
  const scaled = clean.map((value) => scale === 0 ? 1 : value / scale);
  const total = scaled.reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(WEIGHT_KEYS.map((key, index) => [key, scaled[index] / total])) as unknown as Weights;
}

/** Return simulation results in descending score order; ties retain input order. */
export function rank(
  results: readonly SimulationResult[] | Record<string, SimulationResult>,
  weights: Weights,
): SimulationResult[] {
  return Object.values(results)
    .map((result) => ({ result, score: applyWeights(result.criteria, weights) }))
    .sort((a, b) => b.score - a.score)
    .map(({ result }) => result);
}

export function failsStakeholderGroup(result: SimulationResult): boolean {
  return Object.values(result.personas).some((persona) => persona.score < 40);
}

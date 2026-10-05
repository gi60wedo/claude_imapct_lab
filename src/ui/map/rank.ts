import type { Candidate, SimulationResult, Weights } from '../../contracts';

type Rgba = [number, number, number, number];

/** Weighted sum of the 0–100 criteria, with weights renormalized to sum to 1. */
export function marketScore(criteria: Weights, weights: Weights): number {
  const keys = Object.keys(weights) as (keyof Weights)[];
  const total = keys.reduce((s, k) => s + weights[k], 0) || 1;
  return keys.reduce((s, k) => s + (weights[k] / total) * criteria[k], 0);
}

export interface RankInfo { rank: number; of: number; score: number }

/** Rank (0 = best) of every passed candidate that has a result for the active scenario. */
export function rankCandidates(
  candidates: Candidate[], results: Record<string, SimulationResult>, weights: Weights,
): Map<string, RankInfo> {
  const scored = candidates
    .filter((c) => c.passedFilter && results[c.id])
    .map((c) => ({ id: c.id, score: marketScore(results[c.id].criteria, weights) }))
    .sort((a, b) => b.score - a.score);
  return new Map(scored.map((s, i) => [s.id, { rank: i, of: scored.length, score: s.score }]));
}

const GREEN: Rgba = [34, 197, 94, 170];
const AMBER: Rgba = [234, 179, 8, 170];
const RED: Rgba = [239, 68, 68, 170];
export const REJECTED: Rgba = [156, 163, 175, 102]; // grey, 40% alpha
export const UNRANKED: Rgba = [148, 163, 184, 140];

const lerp = (a: Rgba, b: Rgba, t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t)) as Rgba;

/** Green for the best rank, red for the worst. */
export function rankColor(info: RankInfo): Rgba {
  const t = info.of > 1 ? info.rank / (info.of - 1) : 0;
  return t < 0.5 ? lerp(GREEN, AMBER, t * 2) : lerp(AMBER, RED, (t - 0.5) * 2);
}

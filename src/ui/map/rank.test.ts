import { expect, test } from 'vitest';
import type { Candidate, SimulationResult, Weights } from '../../contracts';
import { marketScore, rankCandidates, rankColor } from './rank';

const crit = (accessibility: number, footfall: number): Weights =>
  ({ accessibility, footfall, fairness: 50, localBusiness: 50, walkability: 50 });
const cand = (id: string, passedFilter = true) => ({ id, passedFilter }) as Candidate;
const res = (criteria: Weights) => ({ criteria }) as SimulationResult;

const candidates = [cand('a'), cand('b'), cand('x', false)];
const results = { a: res(crit(90, 10)), b: res(crit(10, 90)) };
const w = (accessibility: number, footfall: number): Weights =>
  ({ accessibility, footfall, fairness: 0, localBusiness: 0, walkability: 0 });

test('marketScore renormalizes weights', () => {
  expect(marketScore(crit(80, 40), w(2, 2))).toBeCloseTo(60);
});

test('rank follows weights and skips rejected candidates', () => {
  const byAccess = rankCandidates(candidates, results, w(0.8, 0.2));
  expect(byAccess.get('a')?.rank).toBe(0);
  expect(byAccess.has('x')).toBe(false);
  const byFootfall = rankCandidates(candidates, results, w(0.2, 0.8));
  expect(byFootfall.get('b')?.rank).toBe(0);
});

test('best rank is green, worst is red', () => {
  const [r0, g0] = rankColor({ rank: 0, of: 3, score: 0 });
  const [r2, g2] = rankColor({ rank: 2, of: 3, score: 0 });
  expect(g0).toBeGreaterThan(r0);
  expect(r2).toBeGreaterThan(g2);
});

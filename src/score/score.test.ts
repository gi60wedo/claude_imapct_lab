import { describe, expect, it } from 'vitest';
import type { PersonaId, SimulationResult, Weights } from '../contracts';
import {
  DEFAULT_WEIGHTS, consensus, failedPersonas, fairnessFromExposure, gini,
  marketScore, normalizeIndicator, normalizeWeights, rankSites,
} from './score';

const crit = (n: number): Weights => ({ accessibility: n, footfall: n, fairness: n, localBusiness: n, walkability: n });
const make = (id: string, criteria: Weights, scores: Record<PersonaId, number>): SimulationResult => ({
  candidateId: id, scenario: 'SUNNY_SAT', seed: 1, mitigations: [], criteria,
  personas: Object.fromEntries(
    Object.entries(scores).map(([p, score]) => [p, { score, served: 0, droppedOut: 0, topFriction: '' }]),
  ) as SimulationResult['personas'],
  bySlice: {} as SimulationResult['bySlice'], stallExposure: [], trips: [],
});
const flat = { senior: 80, vendor: 80, commuter: 80, retailer: 80 };

describe('weights', () => {
  it('defaults sum to 1', () => {
    expect(Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
  it('normalizeWeights renormalises and survives bad input', () => {
    const w = normalizeWeights({ accessibility: 2, footfall: 2, fairness: 0, localBusiness: -1, walkability: NaN });
    expect(w.accessibility).toBeCloseTo(0.5);
    expect(w.localBusiness).toBe(0);
    expect(Object.values(normalizeWeights(crit(0))).every((v) => Math.abs(v - 0.2) < 1e-9)).toBe(true);
  });
});

describe('marketScore', () => {
  it('equals the weighted sum', () => {
    const c: Weights = { accessibility: 100, footfall: 0, fairness: 50, localBusiness: 0, walkability: 0 };
    expect(marketScore(c, DEFAULT_WEIGHTS)).toBeCloseTo(0.3 * 100 + 0.2 * 50);
  });
  it('is invariant to weight scale', () => {
    const c = crit(70);
    expect(marketScore(c, { ...DEFAULT_WEIGHTS, accessibility: 3 })).toBeCloseTo(70);
  });
});

describe('gini / fairness', () => {
  it('is 0 for equal exposure and fairness 100', () => {
    expect(gini([5, 5, 5, 5])).toBe(0);
    expect(fairnessFromExposure([5, 5, 5, 5])).toBe(100);
  });
  it('is high when one stall takes everything', () => {
    expect(gini([0, 0, 0, 100])).toBeCloseTo(0.75);
    expect(fairnessFromExposure([0, 0, 0, 100])).toBeCloseTo(25);
  });
  it('handles empty and all-zero', () => {
    expect(gini([])).toBe(0);
    expect(gini([0, 0])).toBe(0);
  });
});

describe('normalizeIndicator', () => {
  it('maps to 0–100, optionally inverted', () => {
    expect(normalizeIndicator([10, 20, 30])).toEqual([0, 50, 100]);
    expect(normalizeIndicator([10, 20, 30], true)).toEqual([100, 50, 0]);
    expect(normalizeIndicator([4, 4])).toEqual([50, 50]);
  });
});

describe('guard + ranking', () => {
  it('flags personas below 40 whatever the total', () => {
    const r = make('A', crit(95), { ...flat, vendor: 28, commuter: 39 });
    expect(failedPersonas(r)).toEqual(['vendor', 'commuter']);
    expect(rankSites([r])[0].failsStakeholderGroup).toBe(true);
    expect(failedPersonas(make('B', crit(50), { ...flat, vendor: 40 }))).toEqual([]);
  });
  it('ranks by MarketScore and reorders with weights', () => {
    const a = make('A', { accessibility: 90, footfall: 40, fairness: 60, localBusiness: 50, walkability: 60 }, flat);
    const b = make('B', { accessibility: 40, footfall: 95, fairness: 60, localBusiness: 50, walkability: 60 }, flat);
    expect(rankSites([a, b], { ...DEFAULT_WEIGHTS, accessibility: 0.8, footfall: 0.05 })[0].candidateId).toBe('A');
    expect(rankSites([a, b], { ...DEFAULT_WEIGHTS, accessibility: 0.05, footfall: 0.8 })[0].candidateId).toBe('B');
  });
  it('consensus is the mean persona score', () => {
    expect(consensus(make('A', crit(1), { senior: 100, vendor: 0, commuter: 50, retailer: 50 }))).toBe(50);
  });
});

import { describe, expect, it } from 'vitest';
import type { Candidate, SimulationResult } from '../../contracts';
import { DEFAULT_WEIGHTS } from '../state/store';
import { failingPersona, rankCandidates, sliceParts, sliceWindow } from './model';

const persona = (score: number) => ({ score, served: 1, droppedOut: 0, topFriction: 'x' });
const result = (id: string, accessibility: number, vendor = 60, times: number[] = []): SimulationResult => ({
  candidateId: id, scenario: 'SUNNY_SAT', seed: 42, mitigations: [],
  criteria: { accessibility, footfall: 50, fairness: 50, localBusiness: 50, walkability: 50 },
  personas: { senior: persona(70), vendor: persona(vendor), commuter: persona(55), retailer: persona(65) },
  bySlice: {
    '05:30_DELIVERY': { heat: [], bottlenecks: [] }, '11:30_PEAK': { heat: [], bottlenecks: [] },
    '15:00_LULL': { heat: [], bottlenecks: [] },
  },
  stallExposure: [1, 2, 3],
  trips: times.length ? [{ persona: 'senior', path: times.map((t) => [11, 49, t] as [number, number, number]) }] : [],
});
const cand = (id: string, kind: Candidate['kind']) => ({ id, name: id, kind, passedFilter: true } as Candidate);

describe('dashboard model', () => {
  it('splits contract slice ids into clock and phase', () => {
    expect(sliceParts('05:30_DELIVERY')).toEqual({ clock: '05:30', phase: 'Delivery' });
  });

  it('uses the engine slice window for day-clock trips and the trip span for relative ones', () => {
    expect(sliceWindow('11:30_PEAK', result('A', 50, 60, [40000, 42000]))).toEqual([39600, 45000]);
    expect(sliceWindow('11:30_PEAK', result('A', 50, 60, [10, 2600]))).toEqual([10, 2600]);
  });

  it('flags the weakest persona below the guard', () => {
    expect(failingPersona(result('A', 50, 21))).toEqual({ id: 'vendor', score: 21 });
    expect(failingPersona(result('A', 50, 60))).toBeNull();
  });

  it('ranks benchmarks plus the top shortlist by MarketScore', () => {
    const cands = [cand('B1', 'benchmark'), cand('S1', 'square'), cand('S2', 'square'), cand('S3', 'square'), cand('S4', 'square')];
    const res = Object.fromEntries(cands.map((c, i) => [c.id, result(c.id, 10 * (i + 1))]));
    const ranked = rankCandidates(cands, res, DEFAULT_WEIGHTS);
    expect(ranked.map((r) => r.candidate.id)).toEqual(['S4', 'S3', 'S2', 'B1']);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3, 5]);
  });
});

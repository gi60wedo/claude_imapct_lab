import { describe, expect, it } from 'vitest';
import type { Bottleneck, Candidate, PersonaId, SimulationResult } from '../../contracts';
import { SENIOR_WALK_BUDGET_M, VENDOR_MAX_CARRY_M } from '../../sim/params';
import {
  bindingBottleneck, budgetValue, BUDGETS, citizenChoice, countBottlenecks, rivalOf, servedShare, tripStats,
} from './citizens';
import type { Ranked } from './model';

const persona = (score: number) => ({ score, served: 9, droppedOut: 1, topFriction: 'x' });
const bn = (type: Bottleneck['type'], severity: number): Bottleneck => ({ lat: 49.45, lng: 11.07, severity, type, time: '11:40', cause: type });

const result = (id: string, scores: Partial<Record<PersonaId, number>> = {}, trips: SimulationResult['trips'] = []): SimulationResult => ({
  candidateId: id, scenario: 'SUNNY_SAT', seed: 42, mitigations: [],
  criteria: { accessibility: 50, footfall: 50, fairness: 50, localBusiness: 50, walkability: 50 },
  personas: {
    senior: persona(scores.senior ?? 50), vendor: persona(scores.vendor ?? 50),
    commuter: persona(scores.commuter ?? 50), retailer: persona(scores.retailer ?? 50),
  },
  bySlice: {
    '05:30_DELIVERY': { heat: [], bottlenecks: [bn('BOLLARD_BLOCKAGE', 0.9), bn('COBBLESTONE_FRICTION', 0.3)] },
    '11:30_PEAK': { heat: [], bottlenecks: [bn('CROWDING', 0.6), bn('ELEVATOR_CONGESTION', 0.5)] },
    '15:00_LULL': { heat: [], bottlenecks: [bn('CROWDING', 0.2)] },
  },
  stallExposure: [1], trips,
});
const cand = (id: string, kind: Candidate['kind'], vanDistM = 50) =>
  ({ id, name: id, kind, passedFilter: true, indicators: { vanDistM } } as Candidate);
const ranked = (rows: [string, Candidate['kind'], Partial<Record<PersonaId, number>>][]): Ranked[] =>
  rows.map(([id, kind, scores], i) => ({ candidate: cand(id, kind), result: result(id, scores), score: 90 - i, rank: i + 1 }));

describe('citizen choice model', () => {
  it('measures mean walked metres and minutes per persona from the trips', () => {
    // 0.001° of latitude is about 111.2 m.
    const r = result('A', {}, [
      { persona: 'senior', path: [[11, 49, 0], [11, 49.001, 120]] },
      { persona: 'senior', path: [[11, 49, 0], [11, 49.001, 60], [11, 49.002, 360]] },
      { persona: 'vendor', path: [] },
    ]);
    const s = tripStats(r);
    expect(s.senior.trips).toBe(2);
    expect(s.senior.meanM!).toBeCloseTo(111.2 * 1.5, 0);
    expect(s.senior.meanMin).toBeCloseTo(4);
    expect(s.vendor).toEqual({ trips: 0, meanM: null, meanMin: null });
    expect(tripStats(null).commuter.trips).toBe(0);
  });

  it('picks the most severe bottleneck of the persona’s binding kinds', () => {
    const r = result('A');
    expect(bindingBottleneck(r, 'vendor')).toMatchObject({ count: 1, worst: { type: 'BOLLARD_BLOCKAGE', slice: '05:30_DELIVERY' } });
    expect(bindingBottleneck(r, 'senior')).toMatchObject({ count: 2, worst: { type: 'ELEVATOR_CONGESTION', severity: 0.5 } });
    expect(bindingBottleneck(r, 'commuter')).toMatchObject({ count: 2, worst: { severity: 0.6, slice: '11:30_PEAK' } });
    expect(bindingBottleneck(null, 'senior')).toEqual({ worst: null, count: 0 });
    expect(countBottlenecks(r, 'CROWDING')).toBe(2);
  });

  it('measures each persona against its engine budget', () => {
    expect(BUDGETS.senior.limit).toBe(SENIOR_WALK_BUDGET_M);
    expect(BUDGETS.vendor.limit).toBe(VENDOR_MAX_CARRY_M);
    const trips = { trips: 1, meanM: 300, meanMin: 12 };
    expect(budgetValue('senior', trips, undefined)).toBe(300);
    expect(budgetValue('commuter', trips, undefined)).toBe(12);
    expect(budgetValue('vendor', trips, cand('A', 'square', 140))).toBe(140);
    expect(budgetValue('vendor', trips, undefined)).toBeNull();
  });

  it('computes the served share', () => {
    expect(servedShare(9, 1)).toBeCloseTo(0.9);
    expect(servedShare(0, 0)).toBeNull();
  });

  it('chooses the site each persona scores best at, ties to the better rank', () => {
    const rows = ranked([['A', 'square', { senior: 40, vendor: 70 }], ['B', 'benchmark', { senior: 80, vendor: 70 }], ['C', 'benchmark', { senior: 60 }]]);
    expect(citizenChoice(rows, 'senior', 'A')).toMatchObject({ best: { candidate: { id: 'B' } }, bestScore: 80, hereScore: 40, here: false });
    expect(citizenChoice(rows, 'vendor', 'A')).toMatchObject({ best: { candidate: { id: 'A' } }, here: true });
    expect(citizenChoice([], 'senior', 'A')).toBeNull();
  });

  it('compares against the best-ranked other benchmark', () => {
    const rows = ranked([['A', 'square', {}], ['B', 'benchmark', {}], ['C', 'benchmark', {}]]);
    expect(rivalOf(rows, 'A')?.candidate.id).toBe('B');
    expect(rivalOf(rows, 'B')?.candidate.id).toBe('C');
    expect(rivalOf(rows.slice(0, 1), 'A')).toBeNull();
  });
});

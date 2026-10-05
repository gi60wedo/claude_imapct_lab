// View model for the "Travel constraints & citizen choice" panel. Per citizen type: the trip
// numbers from the engine's trips, the engine budget they are measured against, the worst
// bottleneck of the kind that binds that persona, and the shortlisted site it scores best at.
import type { Bottleneck, Candidate, PersonaId, SimulationResult, TimeSlice } from '../../contracts';
import { haversineM } from '../../sim/geo';
import { COMMUTER_BREAK_MIN, RESIDENT_BUDGET_M, SENIOR_WALK_BUDGET_M, VENDOR_MAX_CARRY_M } from '../../sim/params';
import type { Ranked } from './model';

export interface TripStats {
  trips: number;
  /** Mean walked path length in metres, null without trips. */
  meanM: number | null;
  /** Mean trip duration in minutes, null without trips. */
  meanMin: number | null;
}

const EMPTY: TripStats = { trips: 0, meanM: null, meanMin: null };

/** Mean path length and duration per persona over the result's trips ([lng, lat, tSec] paths). */
export function tripStats(result: SimulationResult | null): Record<PersonaId, TripStats> {
  const acc: Record<PersonaId, { n: number; m: number; s: number }> = {
    senior: { n: 0, m: 0, s: 0 }, vendor: { n: 0, m: 0, s: 0 }, commuter: { n: 0, m: 0, s: 0 }, retailer: { n: 0, m: 0, s: 0 },
  };
  for (const t of result?.trips ?? []) {
    const a = acc[t.persona];
    if (!a || t.path.length === 0) continue;
    let m = 0;
    for (let i = 1; i < t.path.length; i++) m += haversineM(t.path[i - 1][0], t.path[i - 1][1], t.path[i][0], t.path[i][1]);
    a.n += 1;
    a.m += m;
    a.s += t.path[t.path.length - 1][2] - t.path[0][2];
  }
  const out = {} as Record<PersonaId, TripStats>;
  for (const id of Object.keys(acc) as PersonaId[]) {
    const a = acc[id];
    out[id] = a.n === 0 ? EMPTY : { trips: a.n, meanM: a.m / a.n, meanMin: a.s / a.n / 60 };
  }
  return out;
}

/** Bottleneck kinds that bind each persona (§2 personas, §6 frictions). */
export const BINDING_TYPES: Record<PersonaId, Bottleneck['type'][]> = {
  senior: ['ELEVATOR_CONGESTION', 'COBBLESTONE_FRICTION'],
  vendor: ['BOLLARD_BLOCKAGE'],
  commuter: ['CROWDING'],
  retailer: ['CROWDING', 'COBBLESTONE_FRICTION'],
};

export interface SliceBottleneck extends Bottleneck { slice: TimeSlice }

/** The most severe bottleneck of a persona's binding kinds across all slices, and how many there are. */
export function bindingBottleneck(result: SimulationResult | null, persona: PersonaId): { worst: SliceBottleneck | null; count: number } {
  let worst: SliceBottleneck | null = null;
  let count = 0;
  if (!result) return { worst, count };
  for (const [slice, s] of Object.entries(result.bySlice) as [TimeSlice, SimulationResult['bySlice'][TimeSlice]][]) {
    for (const b of s.bottlenecks) {
      if (!BINDING_TYPES[persona].includes(b.type)) continue;
      count += 1;
      if (!worst || b.severity > worst.severity) worst = { ...b, slice };
    }
  }
  return { worst, count };
}

/** Bottlenecks of one kind across all slices. */
export function countBottlenecks(result: SimulationResult | null, type: Bottleneck['type']): number {
  if (!result) return 0;
  return Object.values(result.bySlice).reduce((n, s) => n + s.bottlenecks.filter((b) => b.type === type).length, 0);
}

/** The engine budget a persona's main trip number is measured against (src/sim/params.ts). */
export type Budget =
  | { kind: 'walk'; limit: number; unit: 'm'; source: string }
  | { kind: 'time'; limit: number; unit: 'min'; source: string }
  | { kind: 'carry'; limit: number; unit: 'm'; source: string };

export const BUDGETS: Record<PersonaId, Budget> = {
  senior: { kind: 'walk', limit: SENIOR_WALK_BUDGET_M, unit: 'm', source: 'SENIOR_WALK_BUDGET_M' },
  vendor: { kind: 'carry', limit: VENDOR_MAX_CARRY_M, unit: 'm', source: 'VENDOR_MAX_CARRY_M' },
  commuter: { kind: 'time', limit: COMMUTER_BREAK_MIN, unit: 'min', source: 'COMMUTER_BREAK_MIN' },
  retailer: { kind: 'walk', limit: RESIDENT_BUDGET_M, unit: 'm', source: 'RESIDENT_BUDGET_M' },
};

/** The measured value for a persona's budget: walk metres, trip minutes, or the van-to-site carry distance. */
export function budgetValue(persona: PersonaId, trips: TripStats, candidate: Candidate | undefined): number | null {
  const b = BUDGETS[persona];
  if (b.kind === 'carry') return candidate ? candidate.indicators.vanDistM : null;
  return b.kind === 'time' ? trips.meanMin : trips.meanM;
}

/** Share served of everyone who set out, null when nobody did. */
export function servedShare(served: number, dropped: number): number | null {
  const total = served + dropped;
  return total > 0 ? served / total : null;
}

export interface Choice {
  /** Shortlisted site where this persona scores highest; ties go to the better MarketScore rank. */
  best: Ranked;
  bestScore: number;
  /** This persona's score at the selected site, null when it has no result. */
  hereScore: number | null;
  /** True when the selected site is the persona's pick. */
  here: boolean;
}

export function citizenChoice(ranked: Ranked[], persona: PersonaId, selectedId: string | null): Choice | null {
  let best: Ranked | null = null;
  for (const r of ranked) {
    const s = r.result.personas[persona].score;
    if (!best || s > best.result.personas[persona].score || (s === best.result.personas[persona].score && r.rank < best.rank)) best = r;
  }
  if (!best) return null;
  const here = ranked.find((r) => r.candidate.id === selectedId);
  return {
    best, bestScore: best.result.personas[persona].score,
    hereScore: here ? here.result.personas[persona].score : null,
    here: best.candidate.id === selectedId,
  };
}

/**
 * The site the selection is compared against: the best-ranked benchmark other than the selection.
 * Benchmarks are the organizer's sites, so every delta reads as "versus the strongest rival benchmark".
 */
export function rivalOf(ranked: Ranked[], selectedId: string | null): Ranked | null {
  return ranked.find((r) => r.candidate.kind === 'benchmark' && r.candidate.id !== selectedId) ?? null;
}

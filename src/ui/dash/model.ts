// Pure view-model helpers for the ?view=three dashboard. Every value they return comes from
// Candidate, SimulationResult or Brief; nothing here invents a number.
import type { Brief, Candidate, PersonaId, Scenario, SimulationResult, TimeSlice, Weights } from '../../contracts';
import { SLICES } from '../../sim/params';
import { applyWeights } from '../ranking/applyWeights';

export const PERSONAS: { id: PersonaId; label: string; who: string; text: string; bar: string; border: string }[] = [
  { id: 'senior', label: 'Seniors', who: 'Oma Helga', text: 'text-senior', bar: 'bg-senior', border: 'border-senior' },
  { id: 'vendor', label: 'Vendors', who: 'Markus', text: 'text-vendor', bar: 'bg-vendor', border: 'border-vendor' },
  { id: 'commuter', label: 'Commuters', who: 'Lukas', text: 'text-commuter', bar: 'bg-commuter', border: 'border-commuter' },
  { id: 'retailer', label: 'Retail', who: 'Frau Weber', text: 'text-retailer', bar: 'bg-retailer', border: 'border-retailer' },
];

export const SLICE_IDS = Object.keys(SLICES) as TimeSlice[];

/** '05:30_DELIVERY' → { clock: '05:30', phase: 'Delivery' }, straight from the contract value. */
export function sliceParts(slice: TimeSlice): { clock: string; phase: string } {
  const [clock, phase = ''] = slice.split('_');
  return { clock, phase: phase.charAt(0) + phase.slice(1).toLowerCase() };
}

export const SCENARIO_LABEL: Record<Scenario, string> = {
  SUNNY_SAT: 'Sunny Saturday', RAINY_SAT: 'Rainy Saturday', CHRISTMAS_MARKET: 'Christmas market',
};

export const KIND_LABEL: Record<Candidate['kind'], string> = {
  square: 'Square', pedestrian: 'Pedestrian area', ground_floor: 'Ground floor', benchmark: 'Organizer benchmark',
};

/** §6 guard: a persona below this score flags the site as failing a stakeholder group. */
const FAIL_BELOW = 40;

/** The weakest persona when it fails the §6 guard, else null. */
export function failingPersona(r: SimulationResult | undefined): { id: PersonaId; score: number } | null {
  if (!r) return null;
  let worst: { id: PersonaId; score: number } | null = null;
  for (const p of PERSONAS) {
    const score = r.personas[p.id].score;
    if (score < FAIL_BELOW && (!worst || score < worst.score)) worst = { id: p.id, score };
  }
  return worst;
}

export interface Ranked { candidate: Candidate; result: SimulationResult; score: number; rank: number }

/** How many non-benchmark shortlisted sites sit beside the benchmarks in the list. */
const SHORTLIST_SIZE = 3;

/**
 * Benchmarks plus the top shortlisted sites, ordered by MarketScore. Only candidates with a
 * result for the active scenario are listed, since a rank needs one.
 */
export function rankCandidates(candidates: Candidate[], results: Record<string, SimulationResult>, weights: Weights): Ranked[] {
  const scored = candidates
    .filter((c) => results[c.id])
    .map((c) => ({ candidate: c, result: results[c.id], score: applyWeights(results[c.id].criteria, weights) }))
    .sort((a, b) => b.score - a.score)
    .map((r, i) => ({ ...r, rank: i + 1 }));
  const bench = scored.filter((r) => r.candidate.kind === 'benchmark');
  const top = scored.filter((r) => r.candidate.kind !== 'benchmark' && r.candidate.passedFilter).slice(0, SHORTLIST_SIZE);
  const keep = new Set([...bench, ...top]);
  return scored.filter((r) => keep.has(r));
}

/** Results of one scenario keyed by candidate id. */
export function resultsFor(all: Record<string, SimulationResult>, scenario: Scenario): Record<string, SimulationResult> {
  const out: Record<string, SimulationResult> = {};
  for (const r of Object.values(all)) if (r.scenario === scenario) out[r.candidateId] = r;
  return out;
}

/**
 * Sim-time window [from, to] in seconds that play/pause loops through for a slice.
 * The engine stamps trips in seconds of day, so the slice window from sim/params applies.
 * Fixture trips count seconds from their first departure instead; when no trip falls in the
 * slice window, the window falls back to the span the trips cover.
 */
export function sliceWindow(slice: TimeSlice, result: SimulationResult | null): [number, number] {
  const [from, to] = SLICES[slice];
  if (!result || result.trips.length === 0) return [from, to];
  let lo = Infinity, hi = -Infinity;
  for (const t of result.trips) for (const p of t.path) { lo = Math.min(lo, p[2]); hi = Math.max(hi, p[2]); }
  if (hi >= from && lo <= to) return [from, to];
  return hi > lo ? [lo, hi] : [from, to];
}

/** Brief line about a site: its `why` list when recommended, else the comparison that names it. */
export function briefLine(brief: Brief | null, c: Candidate | undefined): string | null {
  if (!brief || !c) return null;
  if (brief.recommended === c.id) return brief.why[0] ?? null;
  const cmp = brief.comparisons.find((x) => matchesSite(x.site, c));
  return cmp ? `Better at ${cmp.betterAt}; worse at ${cmp.worseAt}.` : null;
}

export function matchesSite(site: string, c: Candidate): boolean {
  const s = site.toLowerCase();
  return s === c.id.toLowerCase() || c.name.toLowerCase().includes(s) || s.includes(c.name.toLowerCase());
}

export type StallTone = 'hot' | 'even' | 'cold';

/** Stall shade relative to the mean exposure of the layout. */
export function stallTone(v: number, mean: number): StallTone {
  if (v > mean * 1.25) return 'hot';
  if (v < mean * 0.75) return 'cold';
  return 'even';
}

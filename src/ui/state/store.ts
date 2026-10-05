import { useSyncExternalStore } from 'react';
import type { Brief, Candidate, Scenario, SimulationResult, TimeSlice, Weights } from '../../contracts';

export const DEFAULT_WEIGHTS: Weights = {
  accessibility: 0.3, footfall: 0.25, fairness: 0.2, localBusiness: 0.15, walkability: 0.1,
};

/** Provenance of the live Claude output, shown beside the brief. */
export interface BriefMeta {
  source: 'claude' | 'cache' | 'cache-latest' | 'template';
  ms: number;
  /** "What changed and why" after a scenario or mitigation change. */
  delta?: string;
  mitigation?: { id: string; rationale: string; source: 'claude' | 'template' };
}

export interface UiState {
  candidates: Candidate[];
  /** Keyed by `${candidateId}:${scenario}`; use resultKey(). */
  results: Record<string, SimulationResult>;
  weights: Weights;
  scenario: Scenario;
  slice: TimeSlice;
  selectedId: string | null;
  compareIds: string[];
  brief: Brief | null;
  briefMeta: BriefMeta | null;
  loading: boolean;
  playing: boolean;
  timeSec: number;
}

export const resultKey = (candidateId: string, scenario: Scenario) => `${candidateId}:${scenario}`;

let state: UiState = {
  candidates: [], results: {}, weights: DEFAULT_WEIGHTS, scenario: 'SUNNY_SAT', slice: '11:30_PEAK',
  selectedId: null, compareIds: [], brief: null, briefMeta: null, loading: false, playing: false, timeSec: 0,
};
const listeners = new Set<() => void>();

export const getState = () => state;

export function setState(patch: Partial<UiState> | ((s: UiState) => Partial<UiState>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  listeners.forEach((l) => l());
}

export function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** Select a slice of state; return a stable value (primitive or existing object) to avoid re-renders. */
export function useStore<T>(selector: (s: UiState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

/** Results for the active scenario, keyed by candidate id. */
export function currentResults(s: UiState): Record<string, SimulationResult> {
  const out: Record<string, SimulationResult> = {};
  for (const r of Object.values(s.results)) if (r.scenario === s.scenario) out[r.candidateId] = r;
  return out;
}

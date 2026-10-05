// Scenario switch for the dashboard, same flow as WhatIfBar: run the shortlist for the new
// scenario, store the results, then switch. The live hook re-runs on the scenario change.
import type { Scenario, SimulationResult } from '../../contracts';
import { sim } from '../adapters';
import { ScenarioUnavailableError } from '../adapters/types';
import { getState, resultKey, setState } from '../state/store';

export const SCENARIOS: { id: Scenario; label: string }[] = [
  { id: 'SUNNY_SAT', label: 'Sunny' },
  { id: 'RAINY_SAT', label: 'Rainy' },
  { id: 'CHRISTMAS_MARKET', label: 'Christmas' },
];

/** Returns an error message, or null once the store holds the new scenario. */
export async function switchScenario(next: Scenario): Promise<string | null> {
  const { candidates, scenario } = getState();
  if (next === scenario) return null;
  const shortlist = candidates.filter((c) => c.passedFilter);
  const settled = await Promise.allSettled(shortlist.map((c) => sim.run(c.id, next, [], 42)));
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) return failed.reason instanceof ScenarioUnavailableError ? 'scenario not available offline' : 'simulation failed';
  const fresh = settled.map((r) => (r as PromiseFulfilledResult<SimulationResult>).value);
  setState((s) => {
    const results = { ...s.results };
    for (const r of fresh) results[resultKey(r.candidateId, r.scenario)] = r;
    return { results, scenario: next };
  });
  return null;
}

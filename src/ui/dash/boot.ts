import type { SimulationResult } from '../../contracts';
import { briefClient, sim } from '../adapters';
import { getState, resultKey, setState } from '../state/store';
import { rankCandidates, resultsFor } from './model';

/** Same boot as App.tsx: candidates, a result per shortlisted candidate for the scenario, then the brief. */
export async function bootDashboard() {
  setState({ loading: true });
  const candidates = await sim.candidates();
  const shortlist = candidates.filter((c) => c.passedFilter);
  const { scenario, weights } = getState();
  const settled = await Promise.allSettled(shortlist.map((c) => sim.run(c.id, scenario, [], 42)));
  const results: Record<string, SimulationResult> = {};
  for (const r of settled) if (r.status === 'fulfilled') results[resultKey(r.value.candidateId, r.value.scenario)] = r.value;
  const brief = await briefClient.brief({ candidates, results: Object.values(results), weights, scenario });
  const current = resultsFor(results, scenario);
  const selectedId = current[brief.recommended] ? brief.recommended
    : rankCandidates(candidates, current, weights)[0]?.candidate.id ?? null;
  setState({ candidates, results, brief, selectedId, loading: false });
}

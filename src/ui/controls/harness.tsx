import { createRoot } from 'react-dom/client';
import type { SimulationResult } from '../../contracts';
import { briefClient, sim } from '../adapters';
import { getState, resultKey, setState } from '../state/store';
import '../../index.css';
import SimOverlay from './SimOverlay';

async function boot() {
  setState({ loading: true });
  const candidates = await sim.candidates();
  const shortlist = candidates.filter((candidate) => candidate.passedFilter);
  const { scenario, weights } = getState();
  const runs = await Promise.allSettled(shortlist.map((candidate) => sim.run(candidate.id, scenario, [], 42)));
  const results: Record<string, SimulationResult> = {};
  for (const run of runs) {
    if (run.status === 'fulfilled') results[resultKey(run.value.candidateId, run.value.scenario)] = run.value;
  }
  const selectedId = shortlist.find((candidate) => results[resultKey(candidate.id, scenario)])?.id ?? null;
  if (!selectedId) throw new Error('No shortlisted candidate has an available fixture result.');
  const brief = await briefClient.brief({ candidates, results: Object.values(results), weights, scenario });
  setState({ candidates, results, brief, selectedId, loading: false, playing: true, timeSec: 0 });
}

const root = createRoot(document.getElementById('root')!);
boot().then(() => {
  root.render(<main className="relative h-screen w-screen bg-background text-foreground"><SimOverlay /></main>);
}).catch((error: unknown) => {
  setState({ loading: false, playing: false });
  console.error(error);
  root.render(<p role="alert" className="p-4 text-foreground">Simulation harness failed to load fixtures.</p>);
});

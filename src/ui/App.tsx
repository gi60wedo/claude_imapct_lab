import { useEffect } from 'react';
import Cockpit from './cockpit/Cockpit';
import SimOverlay from './controls/SimOverlay';
import RankingPanel from './ranking/RankingPanel';
import WhatIfBar from './whatif/WhatIfBar';
import { LIVE_BRIEF, briefClient, sim } from './adapters';
import { startLive } from './live/live';
import { getState, resultKey, setState } from './state/store';

async function boot() {
  setState({ loading: true });
  const candidates = await sim.candidates();
  const shortlist = candidates.filter((c) => c.passedFilter);
  const { scenario } = getState();
  const results = await Promise.allSettled(shortlist.map((c) => sim.run(c.id, scenario, [], 42)));
  const map: Record<string, import('../contracts').SimulationResult> = {};
  for (const r of results) if (r.status === 'fulfilled') map[resultKey(r.value.candidateId, r.value.scenario)] = r.value;
  // Live mode shows the map straight away; startLive() fetches the real brief afterwards.
  const brief = LIVE_BRIEF ? null : await briefClient.brief({ candidates, results: Object.values(map), weights: getState().weights, scenario });
  const first = Object.values(map)[0]?.candidateId ?? null;
  setState({ candidates, results: map, brief, selectedId: first, loading: false });
}

export default function App() {
  useEffect(() => {
    let stop: (() => void) | undefined;
    boot()
      .then(() => { if (LIVE_BRIEF) stop = startLive(); })
      .catch((e) => { console.error(e); setState({ loading: false }); });
    return () => stop?.();
  }, []);
  return (
    <div className="grid h-screen w-screen grid-cols-[1fr_380px] grid-rows-[auto_1fr_auto] bg-background text-foreground">
      <header className="col-span-2 flex items-center gap-4 border-b border-border px-4 py-2">
        <h1 className="text-lg font-semibold">UrbanTwin · Market-Sim</h1>
        <div className="flex-1" data-slot="whatif"><WhatIfBar /></div>
      </header>
      <main className="relative min-h-0" data-slot="map"><SimOverlay /></main>
      <aside className="row-span-2 min-h-0 overflow-y-auto border-l border-border" data-slot="side">
        <section data-slot="ranking"><RankingPanel /></section>
        <section data-slot="cockpit"><Cockpit /></section>
      </aside>
      <footer className="px-4 py-1 text-[11px] opacity-60">
        Datenquelle: Bayerische Vermessungsverwaltung – www.geodaten.bayern.de, CC BY 4.0 · © OpenStreetMap contributors · Destatis, Zensus 2022, dl-de/by-2-0 · VGN
      </footer>
    </div>
  );
}

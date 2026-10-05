import { Component, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { TimeSlice } from '../../contracts';
import { onClock } from '../live/clock';
import { EventFeed } from '../live/EventFeed';
import { LiveBar } from '../live/LiveBar';
import { useLiveSim } from '../live/useLiveSim';
import { setState, useStore } from '../state/store';
import CityThree, { type CameraMode, type Quality } from '../three/CityThree';
import { bootDashboard } from './boot';
import { CameraSwitch, CandidateList, ProfileCard, TopBar } from './left';
import { rankCandidates, resultsFor } from './model';
import { Constraints, PersonaCards, ScoreCard, StallGrid } from './right';
import { Card } from './ui';

const NO_MITIGATIONS: string[] = [];

class ViewBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { error: e instanceof Error ? e.message : String(e) }; }
  render() {
    if (this.state.error) return <div className="grid h-full place-items-center text-sm text-red-300" role="alert" data-testid="city-error">City view failed: {this.state.error}</div>;
    return this.props.children;
  }
}

export default function Dashboard() {
  const candidates = useStore((s) => s.candidates);
  const allResults = useStore((s) => s.results);
  const weights = useStore((s) => s.weights);
  const scenario = useStore((s) => s.scenario);
  const slice = useStore((s) => s.slice);
  const selectedId = useStore((s) => s.selectedId);
  const brief = useStore((s) => s.brief);
  const loading = useStore((s) => s.loading);
  const [cameraMode, setCameraMode] = useState<CameraMode>('perspective');
  const [heatmap, setHeatmap] = useState(true);
  const [quality, setQuality] = useState<Quality>('high');
  const [streets, setStreets] = useState(true);

  useEffect(() => { bootDashboard().catch((e) => { console.error(e); setState({ loading: false }); }); }, []);

  const results = useMemo(() => resultsFor(allResults, scenario), [allResults, scenario]);
  const ranked = useMemo(() => rankCandidates(candidates, results, weights), [candidates, results, weights]);
  const listed = useMemo(() => ranked.map((r) => r.candidate), [ranked]);
  const current = ranked.find((r) => r.candidate.id === selectedId);
  const candidate = candidates.find((c) => c.id === selectedId);
  const result = (selectedId && results[selectedId]) || null;

  // Live run for the selection: more trips than the ranking runs, a market-day clock, cross-fades.
  const live = useLiveSim({ candidateId: selectedId, scenario, mitigations: result?.mitigations ?? NO_MITIGATIONS, seed: result?.seed ?? 42 });
  const fallback = useMemo(() => result && onClock(result), [result]);
  const cityResult = live.view ?? fallback;

  const select = (id: string) => setState({ selectedId: id });
  const pickSlice = (s: TimeSlice) => setState({ slice: s });

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 flex-1 flex-col bg-[radial-gradient(ellipse_at_30%_40%,rgba(34,211,238,0.08),transparent_60%)]" data-testid="dashboard">
        <TopBar result={result} scenario={scenario} slice={slice} />
        <div className="grid min-h-0 flex-1 grid-cols-[1fr_520px]">
          <main className="relative min-h-0 overflow-hidden" data-slot="city">
            <div className="absolute inset-0">
              <ViewBoundary>
                <CityThree cameraMode={cameraMode} heatmap={heatmap} selectedId={selectedId}
                  candidates={listed} result={cityResult} timeSec={live.timeSec} slice={slice} onSelect={select}
                  quality={quality} streets={streets} />
              </ViewBoundary>
            </div>
            {/* The top row takes the height the profile card and time bar leave; the candidate
                list shrinks into it and scrolls, so the overlay never overflows the city view. */}
            <div className="pointer-events-none absolute inset-0 flex flex-col gap-3 p-4">
              <div className="flex min-h-0 flex-1 gap-4">
                <div className="flex min-h-0 flex-col">
                  <CandidateList ranked={ranked} selectedId={selectedId} brief={brief} scenario={scenario} onSelect={select} />
                </div>
                <div className="flex flex-1 flex-col items-center gap-3">
                  <div className="pointer-events-auto">
                    <CameraSwitch mode={cameraMode} heatmap={heatmap} onMode={setCameraMode} onHeatmap={() => setHeatmap((h) => !h)}
                      quality={quality} onQuality={() => setQuality((q) => (q === 'high' ? 'fast' : 'high'))}
                      streets={streets} onStreets={() => setStreets((s) => !s)} />
                  </div>
                  {loading && <Card className="pointer-events-auto px-4 py-2 text-sm text-cyan-300">Running the engine…</Card>}
                </div>
              </div>
              <div className="flex items-end justify-between gap-3">
                <div className="pointer-events-auto"><ProfileCard candidate={candidate} result={result} /></div>
                <div className="pointer-events-auto"><EventFeed result={live.result} timeSec={live.timeSec} /></div>
              </div>
              <div className="pointer-events-auto">
                <LiveBar live={live} slice={slice} scenario={scenario} ready={!loading && candidates.length > 0} onSlice={pickSlice} />
              </div>
            </div>
          </main>
          <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto border-l border-cyan-400/10 p-4" data-slot="side">
            <ScoreCard score={current?.score ?? null} rank={current?.rank ?? null} of={ranked.length} candidate={candidate} brief={brief} />
            {result && result.stallExposure.length > 0 && <StallGrid key={result.candidateId} result={result} />}
            <PersonaCards result={result} />
            <Constraints result={result} brief={brief} candidate={candidate} slice={slice} />
          </aside>
        </div>
      </div>
      <footer className="border-t border-border px-4 py-1 text-sm text-muted" data-testid="attribution">
        Datenquelle: Bayerische Vermessungsverwaltung – www.geodaten.bayern.de, CC BY 4.0 · © OpenStreetMap contributors · Destatis, Zensus 2022, dl-de/by-2-0 · VGN
      </footer>
    </div>
  );
}

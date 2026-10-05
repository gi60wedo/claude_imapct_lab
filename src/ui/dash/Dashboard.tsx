import { Component, Suspense, lazy, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { TimeSlice } from '../../contracts';
import { getState, setState, useStore } from '../state/store';
import { bootDashboard } from './boot';
import type { CameraMode, CityThreeComponent } from './cityThreeTypes';
import { CameraSwitch, CandidateList, ProfileCard, TimeBar, TopBar } from './left';
import { rankCandidates, resultsFor, sliceWindow } from './model';
import { Constraints, PersonaCards, ScoreCard, StallGrid } from './right';
import { Card } from './ui';

// The 3D agent owns src/ui/three/CityThree.tsx. The glob resolves to its real default export
// when the file exists and to nothing otherwise, so the dashboard builds either way.
const cityThreeModules = import.meta.glob<{ default: CityThreeComponent }>('../three/CityThree.tsx');
const loadCityThree = cityThreeModules['../three/CityThree.tsx'];
const CityThree = loadCityThree ? lazy(loadCityThree) : null;

/** Wall-clock seconds one pass through a slice window takes while playing. */
const LOOP_SEC = 30;

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
  const playing = useStore((s) => s.playing);
  const timeSec = useStore((s) => s.timeSec);
  const [cameraMode, setCameraMode] = useState<CameraMode>('perspective');
  const [heatmap, setHeatmap] = useState(true);

  useEffect(() => { bootDashboard().catch((e) => { console.error(e); setState({ loading: false }); }); }, []);

  const results = useMemo(() => resultsFor(allResults, scenario), [allResults, scenario]);
  const ranked = useMemo(() => rankCandidates(candidates, results, weights), [candidates, results, weights]);
  const listed = useMemo(() => ranked.map((r) => r.candidate), [ranked]);
  const current = ranked.find((r) => r.candidate.id === selectedId);
  const candidate = candidates.find((c) => c.id === selectedId);
  const result = (selectedId && results[selectedId]) || null;
  const [from, to] = useMemo(() => sliceWindow(slice, result), [slice, result]);

  // Keep timeSec inside the active window when the slice or the selected result changes.
  useEffect(() => {
    const t = getState().timeSec;
    if (t < from || t > to) setState({ timeSec: from });
  }, [from, to]);

  useEffect(() => {
    if (!playing) return;
    const speed = (to - from) / LOOP_SEC;
    let frame = 0;
    let previous: number | undefined;
    const tick = (now: number) => {
      if (previous !== undefined) {
        const t = getState().timeSec + ((now - previous) / 1000) * speed;
        setState({ timeSec: t > to || t < from ? from : t });
      }
      previous = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, from, to]);

  const select = (id: string) => setState({ selectedId: id });
  const pickSlice = (s: TimeSlice) => setState({ slice: s, timeSec: sliceWindow(s, result)[0] });

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 flex-1 flex-col bg-[radial-gradient(ellipse_at_30%_40%,rgba(34,211,238,0.08),transparent_60%)]" data-testid="dashboard">
        <TopBar result={result} scenario={scenario} slice={slice} />
        <div className="grid min-h-0 flex-1 grid-cols-[1fr_520px]">
          <main className="relative min-h-0 overflow-hidden" data-slot="city">
            <div className="absolute inset-0">
              <ViewBoundary>
                {CityThree ? (
                  <Suspense fallback={<div className="grid h-full place-items-center text-sm text-muted">Loading city…</div>}>
                    <CityThree cameraMode={cameraMode} heatmap={heatmap} selectedId={selectedId}
                      candidates={listed} result={result} timeSec={timeSec} onSelect={select} />
                  </Suspense>
                ) : (
                  <div className="grid h-full place-items-center text-sm text-muted">City view not built yet: src/ui/three/CityThree.tsx is missing</div>
                )}
              </ViewBoundary>
            </div>
            <div className="pointer-events-none absolute inset-0 flex flex-col gap-3 p-4">
              <div className="flex items-start gap-4">
                <div className="pointer-events-auto">
                  <CandidateList ranked={ranked} selectedId={selectedId} brief={brief} scenario={scenario} onSelect={select} />
                </div>
                <div className="pointer-events-auto mx-auto">
                  <CameraSwitch mode={cameraMode} heatmap={heatmap} onMode={setCameraMode} onHeatmap={() => setHeatmap((h) => !h)} />
                </div>
              </div>
              {loading && <Card className="pointer-events-auto self-center px-4 py-2 text-sm text-cyan-300">Running the engine…</Card>}
              <div className="flex-1" />
              <div className="pointer-events-auto self-start"><ProfileCard candidate={candidate} result={result} /></div>
              <div className="pointer-events-auto">
                <TimeBar slice={slice} timeSec={timeSec} playing={playing} result={result}
                  onSlice={pickSlice} onPlay={() => setState((s) => ({ playing: !s.playing }))} />
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

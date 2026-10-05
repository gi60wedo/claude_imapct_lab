// The ?view=three dashboard: the 3D city fills the window, and compact dark glass panels float
// over it. Left: the candidate list, the agent key and a corner event feed. Top centre: camera
// and layer switches. Right: the site details, collapsible to a slim rail. Bottom: the clock bar.
import { Component, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { TimeSlice } from '../../contracts';
import { AgentLegend } from '../live/AgentLegend';
import { onClock } from '../live/clock';
import { EventFeed } from '../live/EventFeed';
import { LiveBar } from '../live/LiveBar';
import { useLiveSim } from '../live/useLiveSim';
import { setState, useStore } from '../state/store';
import CityThree, { type AgentColors, type CameraMode, type Quality } from '../three/CityThree';
import { bootDashboard } from './boot';
import { CameraSwitch, CandidateList, ProfileCard, TopBar } from './left';
import { rankCandidates, resultsFor } from './model';
import { Constraints, PersonaCards, ScoreCard, StallGrid } from './right';
import { Card, CollapseButton, Label } from './ui';

const NO_MITIGATIONS: string[] = [];

class ViewBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { error: e instanceof Error ? e.message : String(e) }; }
  render() {
    if (this.state.error) return <div className="grid h-full place-items-center text-sm text-red-300" role="alert" data-testid="city-error">City view failed: {this.state.error}</div>;
    return this.props.children;
  }
}

/** Right column: the site details, or a slim rail with an expand button when collapsed. */
function SidePanel({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <aside data-slot="side" data-testid="side-panel" data-open={open}
      className={`pointer-events-auto flex min-h-0 shrink-0 flex-col gap-2 ${open ? 'w-[340px]' : 'w-9'}`}>
      {open ? (
        <div className="flex justify-end">
          <Card className="p-0.5"><CollapseButton open onToggle={() => setOpen(false)} testId="side-collapse" label="site details" direction="right" /></Card>
        </div>
      ) : (
        <Card className="flex flex-1 flex-col items-center gap-2 py-1.5">
          <CollapseButton open={false} onToggle={() => setOpen(true)} testId="side-collapse" label="site details" direction="right" />
          <Label className="[writing-mode:vertical-rl]">Site details</Label>
        </Card>
      )}
      {/* Hidden, not unmounted, so the stall pick survives a collapse. */}
      <div className={`${open ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-0.5`}>{children}</div>
    </aside>
  );
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
  // The surface overlay is opt-in: the default view is the plain grey street network.
  const [streets, setStreets] = useState(false);
  const [agentColors, setAgentColors] = useState<AgentColors>('persona');

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
    <div className="relative h-screen w-screen overflow-hidden bg-[#0b0b0c] text-zinc-100">
      <div className="absolute inset-0" data-testid="dashboard">
        <main className="absolute inset-0" data-slot="city">
          <ViewBoundary>
            <CityThree cameraMode={cameraMode} heatmap={heatmap} selectedId={selectedId}
              candidates={listed} result={cityResult} timeSec={live.timeSec} slice={slice} onSelect={select}
              quality={quality} streets={streets} agentColors={agentColors} />
          </ViewBoundary>
        </main>
        {/* The overlay passes pointer events through to the city except on the panels. */}
        <div className="pointer-events-none absolute inset-0 flex flex-col gap-2 p-2 pb-5">
          <TopBar result={result} scenario={scenario} slice={slice} />
          <div className="flex min-h-0 flex-1 gap-2">
            <div className="flex min-h-0 w-[272px] shrink-0 flex-col gap-2">
              <CandidateList ranked={ranked} selectedId={selectedId} brief={brief} scenario={scenario} onSelect={select} />
              <div className="min-h-0 flex-1" />
              <div className="pointer-events-auto">
                <AgentLegend result={live.result} view={cityResult} timeSec={live.timeSec} colors={agentColors} onColors={setAgentColors} />
              </div>
              <div className="pointer-events-auto"><EventFeed result={live.result} timeSec={live.timeSec} /></div>
            </div>
            <div className="flex min-w-0 flex-1 flex-col items-center gap-2">
              <div className="pointer-events-auto">
                <CameraSwitch mode={cameraMode} heatmap={heatmap} onMode={setCameraMode} onHeatmap={() => setHeatmap((h) => !h)}
                  quality={quality} onQuality={() => setQuality((q) => (q === 'high' ? 'fast' : 'high'))}
                  streets={streets} onStreets={() => setStreets((s) => !s)} />
              </div>
              {loading && <Card className="pointer-events-auto px-3 py-1 text-xs text-cyan-300">Running the engine…</Card>}
            </div>
            <SidePanel>
              <ScoreCard score={current?.score ?? null} rank={current?.rank ?? null} of={ranked.length} candidate={candidate} brief={brief} />
              <ProfileCard candidate={candidate} result={result} />
              {result && result.stallExposure.length > 0 && <StallGrid key={result.candidateId} result={result} />}
              <PersonaCards result={result} />
              <Constraints result={result} brief={brief} candidate={candidate} slice={slice} />
            </SidePanel>
          </div>
          <div className="pointer-events-auto">
            <LiveBar live={live} slice={slice} scenario={scenario} ready={!loading && candidates.length > 0} onSlice={pickSlice} />
          </div>
        </div>
      </div>
      <footer className="pointer-events-none absolute inset-x-0 bottom-0 truncate px-3 pb-0.5 text-[10px] text-zinc-500" data-testid="attribution">
        Datenquelle: Bayerische Vermessungsverwaltung – www.geodaten.bayern.de, CC BY 4.0 · © OpenStreetMap contributors · Destatis, Zensus 2022, dl-de/by-2-0 · VGN
      </footer>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import DeckGL from '@deck.gl/react';
import type { DeckGLRef } from '@deck.gl/react';
import { MapView } from '@deck.gl/core';
import type { PersonaId, TimeSlice } from '../../contracts';
import type { SimClient } from '../adapters/types';
import { getState, resultKey, setState, useStore } from '../state/store';
import type { SceneApi, SceneLayerId, SceneState, SceneViewState } from './types';
import {
  buildBollardLayer, buildBottleneckPulse, buildBuildingsLayer, buildCandidateLayer,
  buildHeatLayer, buildTerrainLayer, buildTripsLayer, loadSceneGeometry, prepareTrips,
} from './layers3d';

const views = [new MapView({ id: 'scene', repeat: false })];
const personas: readonly PersonaId[] = ['senior', 'vendor', 'commuter', 'retailer'];
const emptyHeat: [number, number, number][] = [];
const emptyBottlenecks = [] as NonNullable<SceneState['result']>['bySlice'][TimeSlice]['bottlenecks'];
const overviewView: SceneViewState = {
  longitude: 11.0780, latitude: 49.4525, zoom: 15, pitch: 45, bearing: -30,
};

/**
 * S1 standalone shell. Inject the existing SimClient; the director can supply
 * its approved SceneApi and the HUD can occupy children without coupling layers.
 * Mount hook for App.tsx (with a SceneView import):
 * if (new URLSearchParams(location.search).get('scene') === '1') return <SceneView simClient={sim} />;
 * Keep this branch after App's hooks. App's existing boot can populate the store.
 */
export default function SceneView({ simClient, sceneApi, children }: {
  simClient: SimClient;
  sceneApi?: SceneApi;
  children?: ReactNode;
}) {
  const store = useStore((value) => value);
  const deckRef = useRef<DeckGLRef>(null);
  const [geometry, setGeometry] = useState<Awaited<ReturnType<typeof loadSceneGeometry>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const [tMs, setTMs] = useState(0);
  const [frame, setFrame] = useState<SceneState | null>(sceneApi?.state ?? null);
  const [camera, setCamera] = useState(overviewView);
  const elapsed = useRef(0);
  const director = sceneApi ? frame ?? sceneApi.state : null;
  // App's independent boot may select its first ranked site after this mount.
  // Keep the Scene 1 target tied to the adapter's candidate id.
  const sceneCandidate = store.candidates.find((site) => site.id.toLowerCase() === 'lorenzkirche');
  const selected = director ? director.result?.candidateId : sceneCandidate?.id;
  const result = director ? director.result : selected ? store.results[resultKey(selected, store.scenario)] ?? null : null;
  const candidate = store.candidates.find((site) => site.id === (result?.candidateId ?? selected));
  const fixtureMode = new URLSearchParams(window.location.search).get('data') === 'fixtures';

  useEffect(() => {
    const abort = new AbortController();
    setReady(false);
    setError(null);
    loadSceneGeometry(abort.signal).then(setGeometry).catch((cause: unknown) => {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => abort.abort();
  }, [attempt]);

  useEffect(() => {
    if (sceneApi) return;
    let cancelled = false;
    async function bootScene() {
      setState({ loading: true });
      const candidates = await simClient.candidates();
      const site = candidates.find((entry) => entry.id.toLowerCase() === 'lorenzkirche');
      if (!site) throw new Error('Lorenzkirche is missing from the simulation candidates');
      const scenario = 'SUNNY_SAT';
      const cached = getState().results[resultKey(site.id, scenario)];
      const simulation = cached ?? await simClient.run(site.id, scenario, [], 42);
      if (cancelled) return;
      // TODO(subagent): contract needs a verified trip time base in fixture metadata.
      // The S1 preview uses the raw timestamps; the director owns the scene clock.
      const starts = simulation.trips.flatMap((trip) => trip.path.length ? [trip.path[0][2]] : []);
      const start = starts.length ? Math.min(...starts) : 0;
      setState((current) => ({
        candidates, selectedId: site.id, scenario, slice: '05:30_DELIVERY', loading: false,
        timeSec: start, playing: false,
        results: { ...current.results, [resultKey(site.id, scenario)]: simulation },
      }));
    }
    bootScene().catch((cause: unknown) => {
      if (!cancelled) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setState({ loading: false });
      }
    });
    return () => { cancelled = true; };
  }, [simClient, sceneApi, attempt]);

  // Wrap the approved API so recorder seek/step calls also publish a React frame.
  const publishedApi = useMemo<SceneApi | null>(() => sceneApi ? {
    step(dtMs) { const next = sceneApi.step(dtMs); setFrame(next); return next; },
    seek(time) { const next = sceneApi.seek(time); setFrame(next); return next; },
    play() { sceneApi.play(); setFrame(sceneApi.state); },
    pause() { sceneApi.pause(); setFrame(sceneApi.state); },
    async apply() { const next = await sceneApi.apply(); setFrame(next); return next; },
    get state() { return sceneApi.state; },
    get keyframes() { return sceneApi.keyframes; },
  } : null, [sceneApi]);

  useEffect(() => {
    if (!publishedApi) { setFrame(null); return; }
    setFrame(publishedApi.state);
    window.__scene = publishedApi;
    return () => { if (window.__scene === publishedApi) delete window.__scene; };
  }, [publishedApi]);

  useEffect(() => {
    let request = 0;
    let previous: number | null = null;
    const tick = (timestamp: number) => {
      const dt = previous === null ? 0 : Math.min(100, Math.max(0, timestamp - previous));
      previous = timestamp;
      if (publishedApi) {
        if (publishedApi.state.phase === 'playing') publishedApi.step(dt);
      } else if (getState().playing) {
        elapsed.current += dt;
        setTMs(elapsed.current);
        setState((current) => ({ timeSec: current.timeSec + dt / 1000 }));
      }
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [publishedApi]);

  const opacity = (id: SceneLayerId, fallback: number) => director?.layers[id]?.currentOpacity ?? fallback;
  const terrainOpacity = opacity('terrain', 1);
  const buildingsOpacity = opacity('buildings', 1);
  const candidateOpacity = opacity('candidateOutline', 1);
  const bollardOpacity = opacity('bollardMarkers', 1);
  const heatOpacity = opacity('heatmap', 0);
  const bottleneckConfig = director?.layers.bottlenecks;
  const heatConfig = director?.layers.heatmap;
  const tripConfig = director?.layers.trips;
  const slice = bottleneckConfig?.layer === 'bottlenecks' ? bottleneckConfig.slice : store.slice;
  const heatSlice = heatConfig?.layer === 'heatmap' ? heatConfig.slice : store.slice;
  const typesKey = bottleneckConfig?.layer === 'bottlenecks' ? bottleneckConfig.types?.join(',') ?? '' : '';
  const personasKey = tripConfig?.layer === 'trips' ? tripConfig.personas.join(',') : personas.join(',');
  const highlight = tripConfig?.layer === 'trips' && tripConfig.highlight
    ? director?.scope?.heroes[tripConfig.highlight]?.tripIndex : undefined;
  const pulsePhase = director ? bottleneckConfig?.pulseState?.phase ?? 0 : (tMs % 1600) / 1600;
  const simSec = director?.simSec ?? store.timeSec;
  const heat = result?.bySlice[heatSlice].heat ?? emptyHeat;
  const allBottlenecks = result?.bySlice[slice].bottlenecks ?? emptyBottlenecks;
  const bottlenecks = useMemo(() => typesKey ? allBottlenecks.filter((point) => typesKey.split(',').includes(point.type))
    : allBottlenecks, [allBottlenecks, typesKey]);
  const activePulses = useMemo(() => bottlenecks.map((_, index) => index), [bottlenecks]);
  const trips = useMemo(() => prepareTrips(result, personasKey.split(',') as PersonaId[]), [result, personasKey]);

  // None of these builders depend on the frame clock. Retain geometry and GPU attributes.
  const terrainLayer = useMemo(() => geometry ? buildTerrainLayer(geometry, terrainOpacity) : null, [geometry, terrainOpacity]);
  const buildingsLayer = useMemo(() => geometry ? buildBuildingsLayer(geometry.buildings, buildingsOpacity) : null, [geometry, buildingsOpacity]);
  const candidateLayer = useMemo(() => buildCandidateLayer(candidate, candidateOpacity), [candidate, candidateOpacity]);
  const bollardLayer = useMemo(() => buildBollardLayer(allBottlenecks, bollardOpacity), [allBottlenecks, bollardOpacity]);
  const heatLayer = useMemo(() => heatOpacity > 0 ? buildHeatLayer(heat, heatOpacity) : null, [heat, heatOpacity]);
  const tripsLayer = buildTripsLayer(trips, simSec, opacity('trips', 1), highlight);
  const pulseLayer = buildBottleneckPulse(bottlenecks, pulsePhase,
    director ? bottleneckConfig?.pulseState?.active ?? [] : activePulses, opacity('bottlenecks', 1));
  const layers = [terrainLayer, buildingsLayer, candidateLayer, heatLayer, bollardLayer, tripsLayer, pulseLayer];
  const clock = `${String(Math.floor(simSec / 3600)).padStart(2, '0')}:${String(Math.floor(simSec / 60) % 60).padStart(2, '0')}`;
  const playing = director ? director.phase === 'playing' : store.playing;
  const onError = useCallback((cause: Error) => { setError(cause.message); }, []);
  const onAfterRender = useCallback(() => {
    if (deckRef.current?.deck?.isInitialized && terrainLayer?.isLoaded && buildingsLayer?.isLoaded) setReady(true);
  }, [terrainLayer, buildingsLayer]);

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-background text-foreground"
      data-testid="scene-view" data-scene={director?.sceneId ?? '1'}
      data-ready={ready && Boolean(result) && !error} data-building-count={geometry?.buildings.length ?? 0}>
      {geometry && <DeckGL ref={deckRef} id="scene-deck" views={views} layers={layers}
        viewState={director?.viewState ?? camera} controller={!director}
        onViewStateChange={({ viewState }) => {
          if (!director && 'longitude' in viewState) setCamera(viewState as SceneViewState);
        }}
        onError={onError} onAfterRender={onAfterRender} />}
      <header className="pointer-events-none absolute left-6 top-6 rounded-xl border border-border bg-surface/90 px-5 py-4">
        <p className="text-lg text-muted">UrbanTwin · Market-Sim</p>
        <h1 className="text-2xl font-semibold">{candidate?.name ?? 'Lorenzkirche'}</h1>
        {result && <p className="mt-2 flex flex-wrap items-center gap-3 text-lg">
          <span data-bind="scene.simSec" data-format="clock">{clock}</span>
          <span data-bind="scenario">{result.scenario}</span>
          <span>Seed <span data-bind="seed">{result.seed}</span></span>
          {fixtureMode && <span className="rounded border border-border px-2 text-muted">fixture</span>}
        </p>}
      </header>
      {children}
      <div className="absolute bottom-14 left-6 flex items-center gap-3 rounded-xl border border-border bg-surface/90 p-3">
        <button type="button" className="rounded-lg border border-border px-4 py-2 text-lg hover:bg-background disabled:opacity-50"
          disabled={!result || Boolean(error)} onClick={() => {
            if (publishedApi) { if (playing) publishedApi.pause(); else publishedApi.play(); }
            else setState({ playing: !playing });
          }}>{playing ? 'Pause' : 'Play'}</button>
        <button type="button" className="rounded-lg border border-border px-4 py-2 text-lg hover:bg-background"
          onClick={() => setCamera(overviewView)} disabled={Boolean(director)}>Reset view</button>
      </div>
      {(error || director?.error) && <div role="alert" className="absolute inset-x-6 top-48 rounded-xl border border-vendor bg-surface p-5 text-lg">
        {error ?? director?.error}
        <button type="button" className="ml-4 rounded-lg border border-border px-4 py-2 hover:bg-background"
          onClick={() => setAttempt((current) => current + 1)}>Retry</button>
      </div>}
      {!error && !(ready && result) && <p role="status" className="absolute bottom-28 left-6 rounded-lg bg-surface px-4 py-3 text-lg">Loading scene…</p>}
      <footer className="pointer-events-none absolute inset-x-0 bottom-0 bg-background/90 px-6 py-3 text-sm text-muted">
        {geometry?.terrain.attribution ?? 'Datenquelle: Bayerische Vermessungsverwaltung, CC BY 4.0'} · © OpenStreetMap contributors · VGN
      </footer>
    </main>
  );
}

export { SceneView };

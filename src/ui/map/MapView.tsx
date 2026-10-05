import { useEffect, useMemo, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre resolves its worker relative to import.meta.url, which breaks under Vite's dep optimizer.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { Layer, PickingInfo } from '@deck.gl/core';
import type { Candidate } from '../../contracts';
import { currentResults, getState, setState, useStore } from '../state/store';
import { useBollards, useBuildings, useOrthoTiles } from './data';
import { rankCandidates } from './rank';
import { exposeTransform } from './maplibreCompat';
import { orthoLayers } from './layers/orthoLayers';
import { buildingsLayer } from './layers/buildingsLayer';
import { bollardsLayer } from './layers/bollardsLayer';
import { CANDIDATES_LAYER_ID, candidatesLayer } from './layers/candidatesLayer';

maplibregl.setWorkerUrl(maplibreWorkerUrl);

const STYLE: maplibregl.StyleSpecification = {
  version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#111' } }],
};

declare global {
  interface Window { __deck?: MapboxOverlay }
}

interface Hover { x: number; y: number; candidate: Candidate }

export interface MapViewProps {
  /** Simulation layers (trips, heat, bottlenecks…) drawn above the base layers. */
  extraLayers?: Layer[];
}

export default function MapView({ extraLayers }: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  const candidates = useStore((s) => s.candidates);
  const results = useStore((s) => s.results);
  const scenario = useStore((s) => s.scenario);
  const weights = useStore((s) => s.weights);
  const selectedId = useStore((s) => s.selectedId);

  const tiles = useOrthoTiles();
  const buildings = useBuildings();
  const bollards = useBollards();

  const ranks = useMemo(
    () => rankCandidates(candidates, currentResults({ ...getState(), results, scenario }), weights),
    [candidates, results, scenario, weights],
  );

  // Static layers depend only on their data, so weight changes reuse them as-is.
  const ortho = useMemo(() => (tiles ? orthoLayers(tiles) : []), [tiles]);
  const buildingLayer = useMemo(() => (buildings ? buildingsLayer(buildings) : null), [buildings]);
  const bollardLayer = useMemo(() => (bollards ? bollardsLayer(bollards) : null), [bollards]);
  const candidateLayer = useMemo(() => candidatesLayer(candidates, ranks, selectedId), [candidates, ranks, selectedId]);

  const layers = useMemo(
    () => [...ortho, candidateLayer, buildingLayer, bollardLayer, ...(extraLayers ?? [])].filter((l): l is Layer => !!l),
    [ortho, candidateLayer, buildingLayer, bollardLayer, extraLayers],
  );

  useEffect(() => {
    const map = new maplibregl.Map({
      container: container.current!,
      style: STYLE,
      center: [11.0775, 49.4525],
      zoom: 16,
      pitch: 50,
      attributionControl: false,
    });
    exposeTransform(map);
    const overlay = new MapboxOverlay({
      interleaved: true,
      layers: [],
      onHover: (info: PickingInfo<Candidate>) => {
        const hit = info.layer?.id === CANDIDATES_LAYER_ID && info.object ? info.object : null;
        map.getCanvas().style.cursor = hit ? 'pointer' : '';
        setHover(hit ? { x: info.x, y: info.y, candidate: hit } : null);
      },
      onClick: (info: PickingInfo<Candidate>) => {
        if (info.layer?.id === CANDIDATES_LAYER_ID && info.object) setState({ selectedId: info.object.id });
      },
    });
    map.addControl(overlay);
    overlayRef.current = overlay;
    if (location.search.includes('e2e=1')) window.__deck = overlay;
    return () => {
      overlayRef.current = null;
      if (window.__deck === overlay) delete window.__deck;
      map.remove();
    };
  }, []);

  useEffect(() => { overlayRef.current?.setProps({ layers }); }, [layers]);

  const rank = hover && ranks.get(hover.candidate.id);
  return (
    <div className="absolute inset-0">
      {/* maplibre-gl.css forces position:relative on the container, so size it explicitly. */}
      <div ref={container} className="h-full w-full" data-testid="map" />
      {hover && (
        <div
          data-testid="map-tooltip"
          className="pointer-events-none absolute z-10 max-w-64 rounded border border-border bg-surface/95 px-2 py-1 text-xs text-foreground shadow-lg"
          style={{ left: hover.x + 12, top: hover.y + 12 }}
        >
          <div className="font-semibold">{hover.candidate.name}</div>
          {hover.candidate.passedFilter
            ? rank && <div className="text-muted">Rank {rank.rank + 1} of {rank.of} · MarketScore {rank.score.toFixed(1)}</div>
            : <div className="text-muted">Rejected: {hover.candidate.rejectReason}</div>}
        </div>
      )}
    </div>
  );
}

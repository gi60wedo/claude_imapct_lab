import { useEffect, useMemo, useState } from 'react';
import { TripsLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer } from '@deck.gl/layers';
import type { Bottleneck } from '../../contracts';
import MapView from '../map/MapView';
import { BOTTLENECKS_LAYER_ID, buildSimLayers } from '../map/simLayers';
import { startFps } from '../perf/fps';
import { resultKey, useStore } from '../state/store';
import TimeControls from './TimeControls';

export default function SimOverlay() {
  const selectedId = useStore((s) => s.selectedId);
  const scenario = useStore((s) => s.scenario);
  const result = useStore((s) => selectedId ? s.results[resultKey(selectedId, scenario)] : undefined);
  const slice = useStore((s) => s.slice);
  const timeSec = useStore((s) => s.timeSec);
  const [hover, setHover] = useState<Bottleneck | null>(null);

  useEffect(() => startFps(), []);
  useEffect(() => setHover(null), [result, slice]);

  const staticLayers = useMemo(() => {
    if (!result) return [];
    return buildSimLayers(result, slice, 0).map((layer) =>
      layer instanceof ScatterplotLayer && layer.id === BOTTLENECKS_LAYER_ID
        ? layer.clone({
            onHover: (info) => {
              setHover(info.object ?? null);
            },
          })
        : layer,
    );
  }, [result, slice]);
  const layers = useMemo(() => staticLayers.map((layer) =>
    layer instanceof TripsLayer ? layer.clone({ currentTime: timeSec }) : layer,
  ), [staticLayers, timeSec]);

  return (
    <div className="absolute inset-0" data-testid="sim-overlay">
      <MapView extraLayers={layers} />
      {hover && (
        <div
          role="tooltip"
          data-testid="bottleneck-tooltip"
          className="pointer-events-none absolute left-4 top-4 z-20 max-w-64 rounded border border-border bg-surface/95 px-2 py-1 text-xs text-foreground shadow-lg"
        >
          <div>{hover.cause}</div>
          <div className="text-muted">{hover.time}</div>
        </div>
      )}
      <div className="absolute bottom-4 left-4 z-10">
        <TimeControls />
      </div>
    </div>
  );
}

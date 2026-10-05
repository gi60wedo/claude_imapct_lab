import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import { TripsLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer } from '@deck.gl/layers';
import type { Bottleneck, PersonaId, SimulationResult, TimeSlice } from '../../contracts';

export const TRIPS_LAYER_ID = 'sim-trips';
export const BOTTLENECKS_LAYER_ID = 'sim-bottlenecks';
export const KIOSKS_LAYER_ID = 'sim-kiosks';

const PERSONA_COLORS: Record<PersonaId, [number, number, number]> = {
  senior: [139, 92, 246],
  vendor: [249, 115, 22],
  commuter: [59, 130, 246],
  retailer: [156, 163, 175],
};

/** Keep result-owned arrays intact so updating currentTime never rebuilds GPU attributes. */
export function buildSimLayers(result: SimulationResult, slice: TimeSlice, timeSec: number) {
  const { heat, bottlenecks } = result.bySlice[slice];
  // TODO(subagent): contract needs trip time slice; reuse the shared trips for each slice.
  const trips = new TripsLayer<SimulationResult['trips'][number]>({
    id: TRIPS_LAYER_ID,
    data: result.trips,
    getPath: (trip) => trip.path.map(([lng, lat]): [number, number] => [lng, lat]),
    getTimestamps: (trip) => trip.path.map((point) => point[2]),
    getColor: (trip) => PERSONA_COLORS[trip.persona],
    positionFormat: 'XY',
    widthUnits: 'pixels',
    getWidth: 3,
    trailLength: 120,
    currentTime: timeSec,
  });
  const exposure = new HeatmapLayer<SimulationResult['bySlice'][TimeSlice]['heat'][number]>({
    id: 'sim-heat',
    data: heat,
    getPosition: (point) => [point[0], point[1]],
    getWeight: (point) => point[2],
    radiusPixels: 35,
    opacity: 0.35,
  });
  const markers = new ScatterplotLayer<Bottleneck>({
    id: BOTTLENECKS_LAYER_ID,
    data: bottlenecks,
    getPosition: (point) => [point.lng, point.lat],
    getRadius: (point) => 4 + Math.max(0, point.severity) * 16,
    radiusUnits: 'meters',
    radiusMinPixels: 5,
    getFillColor: PERSONA_COLORS.vendor,
    opacity: 0.8,
    pickable: true,
    autoHighlight: true,
  });
  // TODO(subagent): contract needs kiosk coordinates; use the three most severe bottlenecks.
  const kiosks = result.mitigations.length ? [new ScatterplotLayer<Bottleneck>({
    id: KIOSKS_LAYER_ID,
    data: [...bottlenecks].sort((a, b) => b.severity - a.severity).slice(0, 3),
    getPosition: (point) => [point.lng, point.lat],
    getRadius: 7,
    radiusUnits: 'pixels',
    filled: false,
    stroked: true,
    lineWidthUnits: 'pixels',
    getLineWidth: 3,
    getLineColor: PERSONA_COLORS.senior,
  })] : [];
  return [exposure, trips, markers, ...kiosks];
}

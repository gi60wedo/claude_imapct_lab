import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import { TripsLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer } from '@deck.gl/layers';
import type { Bottleneck, PersonaId, SimulationResult, TimeSlice } from '../../contracts';
import { SLICES } from '../../sim/params';

export const TRIPS_LAYER_ID = 'sim-trips';
export const BOTTLENECKS_LAYER_ID = 'sim-bottlenecks';
export const KIOSKS_LAYER_ID = 'sim-kiosks';

const PERSONA_COLORS: Record<PersonaId, [number, number, number]> = {
  senior: [139, 92, 246],
  vendor: [249, 115, 22],
  commuter: [59, 130, 246],
  retailer: [156, 163, 175],
};

type Trip = SimulationResult['trips'][number];

/** Length of a slice's playback clock, from the engine's slice window. */
export const sliceDurationSec = (slice: TimeSlice) => SLICES[slice][1] - SLICES[slice][0];

/**
 * Trips shown in a slice, with timestamps relative to the slice start so they match the playback clock.
 * The engine stamps trips in seconds since midnight; fixture trips are already slice-relative and pass through.
 */
export function sliceTrips(trips: Trip[], slice: TimeSlice): Trip[] {
  const clockOfDay = trips.some((trip) => trip.path.some((point) => point[2] >= SLICES['05:30_DELIVERY'][0]));
  if (!clockOfDay) return trips;
  const [from, to] = SLICES[slice];
  return trips
    .filter((trip) => trip.path.length > 0 && trip.path[0][2] < to && trip.path[trip.path.length - 1][2] > from)
    .map((trip) => ({ ...trip, path: trip.path.map(([lng, lat, t]): [number, number, number] => [lng, lat, t - from]) }));
}

/** Kiosk positions: the engine's own coordinates, else (text-only fixture mitigations) the three worst bottlenecks. */
function kioskPoints(result: SimulationResult, bottlenecks: Bottleneck[]): [number, number][] {
  if (result.kiosks) return result.kiosks;
  return [...bottlenecks].sort((a, b) => b.severity - a.severity).slice(0, 3).map((b) => [b.lng, b.lat]);
}

/** Keep result-owned arrays intact so updating currentTime never rebuilds GPU attributes. */
export function buildSimLayers(result: SimulationResult, slice: TimeSlice, timeSec: number) {
  const { heat, bottlenecks } = result.bySlice[slice];
  const trips = new TripsLayer<Trip>({
    id: TRIPS_LAYER_ID,
    data: sliceTrips(result.trips, slice),
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
  const kioskData = result.mitigations.length ? kioskPoints(result, bottlenecks) : [];
  const kiosks = kioskData.length ? [new ScatterplotLayer<[number, number]>({
    id: KIOSKS_LAYER_ID,
    data: kioskData,
    getPosition: (point) => point,
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

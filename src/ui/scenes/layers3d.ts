import { _TerrainExtension as TerrainExtension } from '@deck.gl/extensions';
import { TerrainLayer, TripsLayer } from '@deck.gl/geo-layers';
import { PolygonLayer, ScatterplotLayer } from '@deck.gl/layers';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import { TerrainLoader } from '@loaders.gl/terrain';
import type { Bottleneck, Candidate, PersonaId, SimulationResult } from '../../contracts';

// TODO(subagent): contract needs terrain metadata and buildings3d asset schemas.
// TODO(subagent): scene types need terrain and buildings in SceneAssets.
// Keep these asset-only shapes local until the approved API includes geometry.
interface TerrainMetadata {
  bounds: [number, number, number, number];
  baseElevation: number;
  elevationDecoder: { rScaler: number; gScaler: number; bScaler: number; offset: number };
  elevation?: { url: string };
  texture?: { url: string };
  attribution?: string;
}

interface Building {
  id: string;
  polygon: [number, number, number][] | [number, number, number][][];
  h: number;
  roof: string;
}

const draped = { extensions: [new TerrainExtension()], terrainDrawMode: 'drape' as const };
const colors: Record<PersonaId, [number, number, number]> = {
  senior: [139, 92, 246], vendor: [249, 115, 22],
  commuter: [59, 130, 246], retailer: [156, 163, 175],
};
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function assetUrl(url: string) {
  const resolved = new URL(url, window.location.href);
  if (resolved.origin !== window.location.origin || !resolved.pathname.startsWith('/data/')) {
    throw new Error('Scene geometry must use local /data/ assets');
  }
  return resolved.href;
}

async function json(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(assetUrl(url), { signal });
  if (!response.ok) throw new Error(`Scene asset ${url}: HTTP ${response.status}`);
  return response.json();
}

/** Geometry is fetched once per mount; simulation data comes from the injected SimClient. */
export async function loadSceneGeometry(signal?: AbortSignal) {
  const [metadata, buildingAsset] = await Promise.all([
    json('/data/terrain/terrain.json', signal), json('/data/buildings3d.json', signal),
  ]);
  const terrain = metadata as TerrainMetadata;
  if (!terrain || !Array.isArray(terrain.bounds) || terrain.bounds.length !== 4 ||
      !terrain.bounds.every(finite) || terrain.bounds[0] >= terrain.bounds[2] ||
      terrain.bounds[1] >= terrain.bounds[3] || !finite(terrain.baseElevation) ||
      !terrain.elevationDecoder ||
      !['rScaler', 'gScaler', 'bScaler', 'offset'].every((key) =>
        finite(terrain.elevationDecoder[key as keyof TerrainMetadata['elevationDecoder']]))) {
    throw new Error('Invalid terrain metadata');
  }
  const envelope = buildingAsset as { baseElevation: number; buildings: unknown };
  const footprints = Array.isArray(buildingAsset) ? buildingAsset : envelope?.buildings;
  if (!Array.isArray(buildingAsset) &&
      (!finite(envelope?.baseElevation) || envelope.baseElevation !== terrain.baseElevation)) {
    throw new Error('Buildings and terrain must use the same baseElevation');
  }
  const validRing = (ring: unknown): boolean => Array.isArray(ring) && ring.length >= 3 &&
    ring.every((point) => Array.isArray(point) && point.length === 3 && point.every(finite));
  const validPolygon = (polygon: unknown): boolean => validRing(polygon) ||
    (Array.isArray(polygon) && polygon.length > 0 && polygon.every(validRing));
  if (!Array.isArray(footprints) || !footprints.length || !footprints.every((building: Building) =>
    building && typeof building.id === 'string' && finite(building.h) && building.h >= 0 &&
    validPolygon(building.polygon))) {
    throw new Error('Invalid buildings3d geometry');
  }
  return {
    terrain,
    buildings: footprints as Building[],
    elevationUrl: assetUrl(terrain.elevation?.url ?? '/data/terrain/elevation.png'),
    textureUrl: assetUrl(terrain.texture?.url ?? '/data/terrain/texture.jpg'),
  };
}

export function buildTerrainLayer(geometry: Awaited<ReturnType<typeof loadSceneGeometry>>, opacity = 1) {
  return new TerrainLayer({
    id: 'scene-terrain', elevationData: geometry.elevationUrl, texture: geometry.textureUrl,
    bounds: geometry.terrain.bounds, elevationDecoder: geometry.terrain.elevationDecoder,
    operation: 'terrain+draw', opacity, visible: opacity > 0, meshMaxError: 2,
    // TerrainLayer defaults to a worker-only loader. Supply its main-thread parser
    // explicitly so disabling workers keeps both mesh parsing and texture loading local.
    loaders: [TerrainLoader], loadOptions: { worker: false }, material: false,
  });
}

export function buildBuildingsLayer(buildings: Awaited<ReturnType<typeof loadSceneGeometry>>['buildings'], opacity = 1) {
  return new PolygonLayer<Building>({
    id: 'scene-buildings', data: buildings, extruded: true, stroked: false,
    // zBase is already relative to terrain.baseElevation; preserve it exactly once.
    getPolygon: (building) => building.polygon, getElevation: (building) => building.h,
    getFillColor: [156, 163, 175], material: { ambient: 0.6, diffuse: 0.7, shininess: 16 },
    opacity, visible: opacity > 0, pickable: false,
  });
}

export function buildCandidateLayer(candidate: Candidate | undefined, opacity = 1) {
  return new PolygonLayer<Candidate, typeof draped>({
    id: 'scene-candidate', data: candidate ? [candidate] : [], ...draped,
    getPolygon: (site) => site.polygon, filled: false, stroked: true,
    getLineColor: [248, 250, 252], getLineWidth: 3, lineWidthUnits: 'pixels',
    opacity, visible: opacity > 0,
  });
}

/** Split time from position once. path[i][2] is tSec, never building altitude. */
export function prepareTrips(result: SimulationResult | null, personas: readonly PersonaId[]) {
  return (result?.trips ?? []).flatMap((trip, tripIndex) =>
    personas.includes(trip.persona) && trip.path.length > 1 ? [{
      tripIndex, persona: trip.persona,
      positions: trip.path.map(([lng, lat]) => [lng, lat] as [number, number]),
      timestamps: trip.path.map((point) => point[2]),
    }] : []);
}

export function buildTripsLayer(
  trips: ReturnType<typeof prepareTrips>, simSec: number, opacity = 1, highlightIndex?: number,
) {
  return new TripsLayer<(typeof trips)[number], typeof draped>({
    id: 'scene-trips', data: trips, ...draped, getPath: (trip) => trip.positions,
    getTimestamps: (trip) => trip.timestamps, getColor: (trip) => colors[trip.persona],
    getWidth: (trip) => trip.tripIndex === highlightIndex ? 6 : 3,
    updateTriggers: { getWidth: highlightIndex }, widthUnits: 'pixels',
    currentTime: simSec, trailLength: 120, fadeTrail: true, capRounded: true, jointRounded: true,
    opacity, visible: opacity > 0,
  });
}

export function buildBollardLayer(bottlenecks: Bottleneck[], opacity = 1) {
  return new ScatterplotLayer<Bottleneck, typeof draped>({
    id: 'scene-bollards', data: bottlenecks.filter((point) => point.type === 'BOLLARD_BLOCKAGE'),
    ...draped, getPosition: (point) => [point.lng, point.lat], getRadius: 4,
    getFillColor: colors.vendor, getLineColor: [248, 250, 252], stroked: true,
    lineWidthMinPixels: 1, radiusMinPixels: 4, opacity, visible: opacity > 0,
  });
}

export function buildBottleneckPulse(
  bottlenecks: Bottleneck[], phase: number, active: readonly number[], opacity = 1,
) {
  return new ScatterplotLayer<Bottleneck, typeof draped>({
    id: 'scene-bottleneck-pulse', data: bottlenecks, ...draped,
    getPosition: (point) => [point.lng, point.lat], filled: false, stroked: true,
    getRadius: (point, { index }) => active.includes(index) ? 6 + phase * 18 * point.severity : 6,
    getLineColor: [249, 115, 22], lineWidthMinPixels: 2,
    opacity: opacity * (1 - phase), visible: opacity > 0,
    updateTriggers: { getRadius: [phase, active] },
  });
}

export function buildHeatLayer(heat: SimulationResult['bySlice'][keyof SimulationResult['bySlice']]['heat'], opacity = 1) {
  return new HeatmapLayer<(typeof heat)[number], typeof draped>({
    id: 'scene-heat', data: heat, ...draped,
    getPosition: (point) => [point[0], point[1]], getWeight: (point) => point[2],
    radiusPixels: 30, opacity, visible: opacity > 0,
  });
}

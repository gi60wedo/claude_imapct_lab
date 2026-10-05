// Footway overlay from the walking graph: thin lines draped on the terrain, coloured by surface.
// Source: public/data/graph.json (nodes [{lng, lat, z}], edges [{a, b, len, slope, surface, foot}])
// when present, else the engine graph in public/data/world.json (surface smooth/cobble/rough).
import { Color } from 'three';
import { assetUrl, type CityModel } from './city';
import { project, sampleElevation, type LngLat } from './geometry';
import { SURFACES, surfaceClass, type SurfaceClassId } from './style';

interface GraphNode { lng: number; lat: number }
interface GraphEdge { a: number; b: number; surface?: string | null; foot?: boolean; walk?: boolean }
export interface WalkGraph { nodes: GraphNode[]; edges: GraphEdge[] }

export interface StreetOverlay {
  /** Line-segment pairs in world axes, y = terrain elevation (scaled by the lift at render time). */
  positions: Float32Array;
  colors: Float32Array;
  /** Surface classes that occur in the drawn edges, in legend order. */
  present: SurfaceClassId[];
  source: 'graph.json' | 'world.json';
}

/** Vertex spacing along each edge, metres, so lines follow the terrain between nodes. */
const STEP_M = 5;
/** Lines float this far above the terrain to avoid z-fighting with the ground. */
export const STREET_LIFT_M = 0.8;

/** Footway edges with both ends inside the terrain bounds. */
export function footways(graph: WalkGraph, bounds: readonly [number, number, number, number]): GraphEdge[] {
  const [west, south, east, north] = bounds;
  const inside = (node: GraphNode | undefined) => !!node && node.lng >= west && node.lng <= east && node.lat >= south && node.lat <= north;
  return graph.edges.filter((edge) => (edge.foot ?? edge.walk ?? true) && inside(graph.nodes[edge.a]) && inside(graph.nodes[edge.b]));
}

export function buildStreetOverlay(city: CityModel, graph: WalkGraph, source: StreetOverlay['source']): StreetOverlay {
  const edges = footways(graph, city.raster.bounds);
  const palette = new Map(SURFACES.map((s) => [s.id, new Color(s.color)]));
  const positions: number[] = [], colors: number[] = [];
  const seen = new Set<SurfaceClassId>();
  for (const edge of edges) {
    const a = graph.nodes[edge.a], b = graph.nodes[edge.b];
    const cls = surfaceClass(edge.surface);
    seen.add(cls);
    const color = palette.get(cls)!;
    const [ax, an] = project([a.lng, a.lat], city.frame), [bx, bn] = project([b.lng, b.lat], city.frame);
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bn - an) / STEP_M));
    let previous: [number, number, number] | null = null;
    for (let k = 0; k <= steps; k++) {
      const f = k / steps;
      const point: LngLat = [a.lng + (b.lng - a.lng) * f, a.lat + (b.lat - a.lat) * f];
      const current: [number, number, number] = [ax + (bx - ax) * f, sampleElevation(point[0], point[1], city.raster), -(an + (bn - an) * f)];
      if (previous) {
        positions.push(...previous, ...current);
        colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
      }
      previous = current;
    }
  }
  return {
    positions: new Float32Array(positions), colors: new Float32Array(colors),
    present: SURFACES.map((s) => s.id).filter((id) => seen.has(id)), source,
  };
}

async function fetchGraph(url: string): Promise<WalkGraph | null> {
  try {
    const response = await fetch(url);
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) return null;
    const json = await response.json() as Partial<WalkGraph> & { graph?: WalkGraph };
    const graph = json.graph ?? json;
    return Array.isArray(graph.nodes) && Array.isArray(graph.edges) ? graph as WalkGraph : null;
  } catch {
    return null;
  }
}

let cached: Promise<StreetOverlay | null> | null = null;

/** Loads the walking graph once, after the city, and builds the overlay geometry. */
export function getStreets(city: CityModel): Promise<StreetOverlay | null> {
  cached ??= (async () => {
    const own = await fetchGraph(assetUrl('/data/graph.json'));
    if (own) return buildStreetOverlay(city, own, 'graph.json');
    const world = await fetchGraph(assetUrl('/data/world.json'));
    return world ? buildStreetOverlay(city, world, 'world.json') : null;
  })().catch(() => null);
  return cached;
}

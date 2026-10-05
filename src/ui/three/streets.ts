// Street network from the walking graph, draped on the terrain. Two layers share one fetch:
// - roads: lit grey ribbons, always drawn, metres wide by road class (major roads widest), asphalt
//   on vehicle roads and lighter paving on pedestrian ways and plazas;
// - overlay: thin lines in greys by surface (sett lighter and dashed, asphalt darker), behind the
//   Streets toggle.
// Source: public/data/graph.json (nodes [{lng, lat, z}], edges [{a, b, len, slope, surface, foot, hw}])
// when present, else the engine graph in public/data/world.json (surface smooth/cobble/rough).
import { Color } from 'three';
import { assetUrl, type CityModel } from './city';
import { project, sampleElevation, type LngLat } from './geometry';
import { ASPHALT_ROADS, ROAD_ORDER, roadClass, ROADS, SURFACES, surfaceClass, type SurfaceClassId } from './style';

interface GraphNode { lng: number; lat: number }
interface GraphEdge {
  a: number; b: number; surface?: string | null; foot?: boolean; walk?: boolean;
  hw?: string | null; vehicle?: boolean; vehicleAllowed?: boolean;
}
export interface WalkGraph { nodes: GraphNode[]; edges: GraphEdge[] }

export interface LineSet {
  /** Line-segment pairs in world axes, y = terrain elevation (scaled by the lift at render time). */
  positions: Float32Array;
  colors: Float32Array;
}

export interface StreetOverlay {
  /** Solid surface lines. */
  solid: LineSet;
  /** Dashed surface lines (cobble / sett). */
  dashed: LineSet;
  /** Surface classes that occur in the drawn edges, in legend order. */
  present: SurfaceClassId[];
  source: 'graph.json' | 'world.json';
}

export interface RoadMesh {
  /** Indexed triangle strip per edge, world axes, y = terrain elevation. */
  positions: Float32Array;
  colors: Float32Array;
  /** 1 for paved pedestrian ways and plazas (sett pattern), 0 for asphalt roads, per vertex. */
  paved: Float32Array;
  index: Uint32Array;
}

export interface Streets { roads: RoadMesh; overlay: StreetOverlay }

/** Vertex spacing along each edge, metres, so lines follow the terrain between nodes. */
const STEP_M = 5;
/** Lines float this far above the terrain to avoid z-fighting with the ground. */
export const STREET_LIFT_M = 0.8;
/** Road ribbons sit just under the surface lines. */
export const ROAD_LIFT_M = 0.6;

/** Footway edges with both ends inside the terrain bounds. */
export function footways(graph: WalkGraph, bounds: readonly [number, number, number, number]): GraphEdge[] {
  const [west, south, east, north] = bounds;
  const inside = (node: GraphNode | undefined) => !!node && node.lng >= west && node.lng <= east && node.lat >= south && node.lat <= north;
  return graph.edges.filter((edge) => (edge.foot ?? edge.walk ?? true) && inside(graph.nodes[edge.a]) && inside(graph.nodes[edge.b]));
}

/** Edges with both ends inside the terrain bounds, any mode. */
function insideEdges(graph: WalkGraph, bounds: readonly [number, number, number, number]): GraphEdge[] {
  const [west, south, east, north] = bounds;
  const inside = (node: GraphNode | undefined) => !!node && node.lng >= west && node.lng <= east && node.lat >= south && node.lat <= north;
  return graph.edges.filter((edge) => inside(graph.nodes[edge.a]) && inside(graph.nodes[edge.b]));
}

/** Points every STEP_M metres along an edge: (east, north, elevation) per sample. */
function samples(city: CityModel, a: GraphNode, b: GraphNode): [number, number, number][] {
  const [ax, an] = project([a.lng, a.lat], city.frame), [bx, bn] = project([b.lng, b.lat], city.frame);
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bn - an) / STEP_M));
  const out: [number, number, number][] = [];
  for (let k = 0; k <= steps; k++) {
    const f = k / steps;
    const point: LngLat = [a.lng + (b.lng - a.lng) * f, a.lat + (b.lat - a.lat) * f];
    out.push([ax + (bx - ax) * f, an + (bn - an) * f, sampleElevation(point[0], point[1], city.raster)]);
  }
  return out;
}

export function buildStreetOverlay(city: CityModel, graph: WalkGraph, source: StreetOverlay['source']): StreetOverlay {
  const edges = footways(graph, city.raster.bounds);
  const style = new Map(SURFACES.map((s) => [s.id, { color: new Color(s.color), dashed: s.dashed }]));
  const solid = { positions: [] as number[], colors: [] as number[] };
  const dashed = { positions: [] as number[], colors: [] as number[] };
  const seen = new Set<SurfaceClassId>();
  for (const edge of edges) {
    const cls = surfaceClass(edge.surface);
    seen.add(cls);
    const { color, dashed: isDashed } = style.get(cls)!;
    const target = isDashed ? dashed : solid;
    let previous: [number, number, number] | null = null;
    for (const [east, north, y] of samples(city, graph.nodes[edge.a], graph.nodes[edge.b])) {
      const current: [number, number, number] = [east, y, -north];
      if (previous) {
        target.positions.push(...previous, ...current);
        target.colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
      }
      previous = current;
    }
  }
  const pack = (set: typeof solid): LineSet => ({ positions: new Float32Array(set.positions), colors: new Float32Array(set.colors) });
  return {
    solid: pack(solid), dashed: pack(dashed),
    present: SURFACES.map((s) => s.id).filter((id) => seen.has(id)), source,
  };
}

/**
 * Flat ribbons along every drawn edge, width and grey by road class, narrow classes first so
 * wider roads paint over them at junctions (the material draws in index order, no depth writes).
 */
export function buildRoads(city: CityModel, graph: WalkGraph): RoadMesh {
  const byClass = ROAD_ORDER.map((id) => ({ id, edges: [] as GraphEdge[] }));
  for (const edge of insideEdges(graph, city.raster.bounds)) {
    const cls = roadClass(edge.hw, edge.vehicleAllowed ?? edge.vehicle);
    if (cls) byClass[ROAD_ORDER.indexOf(cls)].edges.push(edge);
  }
  const positions: number[] = [], colors: number[] = [], paved: number[] = [], index: number[] = [];
  for (const { id, edges } of byClass) {
    const { width, color: hex } = ROADS[id];
    const isPaved = ASPHALT_ROADS.includes(id) ? 0 : 1;
    const color = new Color(hex);
    const half = width / 2;
    for (const edge of edges) {
      const points = samples(city, graph.nodes[edge.a], graph.nodes[edge.b]);
      const [x0, n0] = points[0], [x1, n1] = points[points.length - 1];
      const length = Math.hypot(x1 - x0, n1 - n0);
      if (!(length > 0.01)) continue;
      // Perpendicular in the (east, north) plane; the ribbon extends half a width past each node
      // so consecutive edges overlap instead of leaving notches at bends.
      const ue = (x1 - x0) / length, un = (n1 - n0) / length;
      const pe = -un * half, pn = ue * half;
      const base = positions.length / 3;
      points.forEach(([east, north, y], k) => {
        const extend = k === 0 ? -half : k === points.length - 1 ? half : 0;
        const e = east + ue * extend, n = north + un * extend;
        positions.push(e + pe, y, -(n + pn), e - pe, y, -(n - pn));
        colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
        paved.push(isPaved, isPaved);
      });
      for (let k = 0; k < points.length - 1; k++) {
        const i = base + k * 2;
        index.push(i, i + 1, i + 2, i + 2, i + 1, i + 3);
      }
    }
  }
  return {
    positions: new Float32Array(positions), colors: new Float32Array(colors), paved: new Float32Array(paved),
    index: new Uint32Array(index),
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

let cached: Promise<Streets | null> | null = null;

/** Loads the walking graph once, after the city, and builds the road and overlay geometry. */
export function getStreets(city: CityModel): Promise<Streets | null> {
  cached ??= (async () => {
    const own = await fetchGraph(assetUrl('/data/graph.json'));
    const graph = own ?? await fetchGraph(assetUrl('/data/world.json'));
    if (!graph) return null;
    return { roads: buildRoads(city, graph), overlay: buildStreetOverlay(city, graph, own ? 'graph.json' : 'world.json') };
  })().catch(() => null);
  return cached;
}

// Street slope and surface around a site, from the role A walking graph in public/data/graph.json
// (nodes [{lng, lat, z}], edges [{a, b, len, slope, surface, foot, hw, ...}]). Every value here is
// a length-weighted aggregate of graph edges; nothing is typed in.
import { useEffect, useState } from 'react';
import type { Candidate } from '../../contracts';
import { LocalProjection } from '../../sim/geo';

export interface StreetNode { lng: number; lat: number; z?: number }
export interface StreetEdge {
  a: number; b: number; len: number; slope: number; foot?: boolean;
  surface?: string | null; hw?: string | null;
  steps?: boolean; bollard?: boolean; sheltered?: boolean; slopeSuspect?: boolean;
}
export interface StreetGraph { nodes: StreetNode[]; edges: StreetEdge[] }

export type SurfaceGroup = 'cobble' | 'paving' | 'asphalt' | 'other';

export const SURFACE_GROUPS: { id: SurfaceGroup; label: string; className: string }[] = [
  { id: 'cobble', label: 'Sett & cobblestone', className: 'bg-amber-300' },
  { id: 'paving', label: 'Paving stones', className: 'bg-cyan-300' },
  { id: 'asphalt', label: 'Asphalt', className: 'bg-zinc-400' },
  { id: 'other', label: 'Other / untagged', className: 'bg-zinc-600' },
];

/** Radius around the site centroid, metres. */
export const STREET_RADIUS_M = 200;
/** Quantile of the upper slope figure; the max is a capped DGM artefact and is never shown. */
export const SLOPE_QUANTILE = 0.9;

export interface StreetStats {
  /** Foot edges counted, and their total length in metres. */
  edges: number;
  lengthM: number;
  /**
   * Length-weighted mean and 90th-percentile grade as fractions (0.03 = 3 %). Steps and edges
   * flagged slopeSuspect (DGM artefacts capped at 25 %) are left out; null when none remain.
   */
  meanSlope: number | null;
  p90Slope: number | null;
  /** Length shares per surface group; they sum to 1 when lengthM > 0. */
  mix: Record<SurfaceGroup, number>;
  /** Edge counts of OSM steps, elevators and bollards in the radius. */
  steps: number;
  elevators: number;
  bollards: number;
  /** Length share of sheltered (covered or indoor) foot edges. */
  sheltered: number;
}

export function surfaceGroup(surface: string | null | undefined): SurfaceGroup {
  switch (surface) {
    case 'sett': case 'cobblestone': case 'unhewn_cobblestone': return 'cobble';
    case 'paving_stones': return 'paving';
    case 'asphalt': return 'asphalt';
    default: return 'other';
  }
}

/** Mean of the polygon's distinct vertices; a closing vertex that repeats the first is skipped. */
export function siteCentroid(polygon: [number, number][]): [number, number] | null {
  const n = polygon.length;
  if (n === 0) return null;
  const [fx, fy] = polygon[0];
  const [lx, ly] = polygon[n - 1];
  const pts = n > 1 && fx === lx && fy === ly ? polygon.slice(0, -1) : polygon;
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / pts.length, y / pts.length];
}

/** Smallest value whose cumulative weight reaches share q of the total. Values need not be sorted. */
export function weightedPercentile(values: { v: number; w: number }[], q: number): number | null {
  const items = values.filter((x) => x.w > 0).sort((a, b) => a.v - b.v);
  const total = items.reduce((s, x) => s + x.w, 0);
  if (total === 0) return null;
  let acc = 0;
  for (const x of items) {
    acc += x.w;
    if (acc >= q * total - 1e-9) return x.v;
  }
  return items[items.length - 1].v;
}

function segmentDistance(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Aggregates the foot edges that pass within `radiusM` of `center` ([lng, lat]). */
export function streetStats(graph: StreetGraph, center: [number, number], radiusM = STREET_RADIUS_M): StreetStats {
  const proj = new LocalProjection(center[0], center[1]);
  const mix: Record<SurfaceGroup, number> = { cobble: 0, paving: 0, asphalt: 0, other: 0 };
  const slopes: { v: number; w: number }[] = [];
  let edges = 0, lengthM = 0, slopeSum = 0, slopeLen = 0, steps = 0, elevators = 0, bollards = 0, shelteredM = 0;
  for (const e of graph.edges) {
    if (e.foot === false) continue;
    const na = graph.nodes[e.a], nb = graph.nodes[e.b];
    if (!na || !nb) continue;
    const [ax, ay] = proj.toXY(na.lng, na.lat);
    const [bx, by] = proj.toXY(nb.lng, nb.lat);
    if (segmentDistance(ax, ay, bx, by) > radiusM) continue;
    const len = Math.max(0, e.len);
    edges += 1;
    lengthM += len;
    mix[surfaceGroup(e.surface)] += len;
    if (e.sheltered) shelteredM += len;
    const isSteps = e.steps === true || e.hw === 'steps';
    if (isSteps) steps += 1;
    if (e.hw === 'elevator') elevators += 1;
    if (e.bollard) bollards += 1;
    if (!isSteps && !e.slopeSuspect && Number.isFinite(e.slope)) {
      const s = Math.abs(e.slope);
      slopeSum += s * len;
      slopeLen += len;
      slopes.push({ v: s, w: len });
    }
  }
  if (lengthM > 0) for (const k of Object.keys(mix) as SurfaceGroup[]) mix[k] /= lengthM;
  return {
    edges, lengthM, mix, steps, elevators, bollards,
    meanSlope: slopeLen > 0 ? slopeSum / slopeLen : null,
    p90Slope: weightedPercentile(slopes, SLOPE_QUANTILE),
    sheltered: lengthM > 0 ? shelteredM / lengthM : 0,
  };
}

/** The largest surface group by length, or null without edges. */
export function dominantSurface(s: StreetStats): SurfaceGroup | null {
  if (s.lengthM === 0) return null;
  return SURFACE_GROUPS.map((g) => g.id).reduce((best, id) => (s.mix[id] > s.mix[best] ? id : best));
}

let graphPromise: Promise<StreetGraph> | null = null;

/** Fetches public/data/graph.json once per page; a failure clears the cache so a later call retries. */
export function loadStreetGraph(): Promise<StreetGraph> {
  graphPromise ??= fetch(`${import.meta.env.BASE_URL}data/graph.json`)
    .then((r) => {
      if (!r.ok) throw new Error(`graph.json: HTTP ${r.status}`);
      return r.json() as Promise<StreetGraph>;
    })
    .catch((e: unknown) => { graphPromise = null; throw e; });
  return graphPromise;
}

const cache = new Map<string, StreetStats>();

/** Street stats around the candidate's centroid; null while the graph loads, when it fails, or with no candidate. */
export function useStreetStats(candidate: Candidate | undefined): StreetStats | null {
  const key = candidate?.id ?? null;
  const [state, setStats] = useState<{ key: string | null; stats: StreetStats | null }>(
    () => ({ key, stats: key ? cache.get(key) ?? null : null }));
  useEffect(() => {
    if (!candidate) return;
    const hit = cache.get(candidate.id);
    if (hit) { setStats({ key: candidate.id, stats: hit }); return; }
    const center = siteCentroid(candidate.polygon);
    if (!center) return;
    let stale = false;
    loadStreetGraph()
      .then((g) => {
        const stats = streetStats(g, center);
        cache.set(candidate.id, stats);
        if (!stale) setStats({ key: candidate.id, stats });
      })
      .catch((e: unknown) => console.warn('street stats unavailable:', e));
    return () => { stale = true; };
  }, [candidate]);
  return state.key === key ? state.stats : (key ? cache.get(key) ?? null : null);
}

/**
 * Hero rules and trip geometry for the scripted scenes. A hero is picked from
 * `result.trips` by rule, never by trip id. Pure functions only. Ties break by
 * the lowest trip index; distances are haversine metres on `[lng, lat]`.
 */

import type { SimulationResult } from '../../contracts';
import type { GraphNodeRole, HeroId, HeroPick, HeroRule, SceneAssets, SimSec } from './types';

export type LngLat = readonly [number, number];
export type Trip = SimulationResult['trips'][number];
type PathPoint = Trip['path'][number];

/** Fixed hero order, so iteration never depends on object key order. */
export const HERO_IDS: readonly HeroId[] = ['markus', 'helga', 'lukas'];

const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;

export function haversineM(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * RAD;
  const dLng = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Moves a point `metres` along a compass bearing (degrees clockwise from north). */
export function offsetLngLat(p: LngLat, bearingDeg: number, metres: number): [number, number] {
  const mPerDegLat = EARTH_RADIUS_M * RAD;
  const b = bearingDeg * RAD;
  return [
    p[0] + (metres * Math.sin(b)) / (mPerDegLat * Math.cos(p[1] * RAD)),
    p[1] + (metres * Math.cos(b)) / mPerDegLat,
  ];
}

/* ------------------------------------------------------------------------ */
/* Graph nodes and kiosks (scene assets outside the contract)                */
/* ------------------------------------------------------------------------ */

/**
 * Marker roles read from `graph.json` nodes.
 * TODO(subagent): scene types need `'bollard'` in `GraphNodeRole` for
 * `bollardMarkers`; it is accepted here as an extra role string.
 */
export type MarkerNodeRole = GraphNodeRole | 'bollard';

export interface GraphNode {
  id: string;
  lng: number;
  lat: number;
  role: string;
}

/**
 * Nodes of one role in file order. Accepts the proposed `{ id, lng, lat, role }[]`
 * schema, bare or under a `nodes` key. Malformed entries are skipped.
 */
export function graphNodesOf(assets: SceneAssets, role: MarkerNodeRole): GraphNode[] {
  const raw = assets.graphNodes;
  const list: unknown =
    Array.isArray(raw) ? raw : typeof raw === 'object' && raw !== null ? (raw as { nodes?: unknown }).nodes : undefined;
  if (!Array.isArray(list)) return [];
  const out: GraphNode[] = [];
  for (const n of list) {
    if (typeof n !== 'object' || n === null) continue;
    const { id, lng, lat, role: r } = n as Record<string, unknown>;
    if (r !== role || typeof lng !== 'number' || typeof lat !== 'number') continue;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    out.push({ id: String(id), lng, lat, role });
  }
  return out;
}

const KIOSK = /^kiosk:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/;

/**
 * Kiosk positions after a mitigation, in the order the engine lists them.
 * Q4 option A: the engine echoes kiosks in `mitigations` as `"kiosk:<lng>,<lat>"`.
 * TODO(subagent): contract needs Q4 decision; if B picks option B (`kiosks`),
 * this helper is the one place to switch.
 */
export function kioskPositions(result: SimulationResult): [number, number][] {
  const out: [number, number][] = [];
  for (const m of result.mitigations) {
    const hit = KIOSK.exec(m.trim());
    if (hit) out.push([Number(hit[1]), Number(hit[2])]);
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* Trip geometry                                                             */
/* ------------------------------------------------------------------------ */

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
const point = (p: PathPoint): LngLat => [p[0], p[1]];

export function tripStart(trip: Trip): SimSec | null {
  return trip.path.length ? trip.path[0][2] : null;
}

export function tripEnd(trip: Trip): SimSec | null {
  return trip.path.length ? trip.path[trip.path.length - 1][2] : null;
}

/**
 * Interpolated `[lng, lat]` at `simSec`. Outside the trip's time span it
 * returns the first or last point when `clamp` is set, else `null`.
 */
export function tripPositionAt(trip: Trip, simSec: SimSec, clamp: boolean): [number, number] | null {
  const path = trip.path;
  if (!path.length || !Number.isFinite(simSec)) return null;
  const first = path[0];
  const last = path[path.length - 1];
  if (simSec <= first[2]) return simSec === first[2] || clamp ? [first[0], first[1]] : null;
  if (simSec >= last[2]) return simSec === last[2] || clamp ? [last[0], last[1]] : null;
  for (let i = 1; i < path.length; i++) {
    const b = path[i];
    if (b[2] < simSec) continue;
    const a = path[i - 1];
    const f = b[2] === a[2] ? 1 : (simSec - a[2]) / (b[2] - a[2]);
    return [lerp(a[0], b[0], f), lerp(a[1], b[1], f)];
  }
  return [last[0], last[1]];
}

/**
 * Closest point to `p` on segment `a`–`b`, found in a local equirectangular
 * frame around `p`. The caller measures the distance with `haversineM`.
 */
function closestOnSegment(p: LngLat, a: LngLat, b: LngLat): LngLat {
  const k = Math.cos(p[1] * RAD);
  const ax = (a[0] - p[0]) * k;
  const ay = a[1] - p[1];
  const bx = (b[0] - p[0]) * k;
  const by = b[1] - p[1];
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const f = len2 === 0 ? 0 : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2));
  return [lerp(a[0], b[0], f), lerp(a[1], b[1], f)];
}

/** Smallest haversine distance from `p` to a polyline. `Infinity` for an empty line. */
export function distanceToPolylineM(line: readonly LngLat[], p: LngLat): number {
  if (line.length === 0) return Infinity;
  if (line.length === 1) return haversineM(line[0], p);
  let best = Infinity;
  for (let i = 1; i < line.length; i++) best = Math.min(best, haversineM(closestOnSegment(p, line[i - 1], line[i]), p));
  return best;
}

/**
 * The part of a trip's path inside the sim-time window `[t0, t1]`, with
 * interpolated end points. Empty when the window misses the trip.
 */
export function pathInWindow(trip: Trip, t0: SimSec, t1: SimSec): LngLat[] {
  const start = tripStart(trip);
  const end = tripEnd(trip);
  if (start === null || end === null || t1 < start || t0 > end || t1 < t0) return [];
  const from = Math.max(t0, start);
  const to = Math.min(t1, end);
  const out: LngLat[] = [tripPositionAt(trip, from, true)!];
  for (const p of trip.path) if (p[2] > from && p[2] < to) out.push(point(p));
  if (to > from) out.push(tripPositionAt(trip, to, true)!);
  return out;
}

/** True when the hero's position came within `withinM` of `p` at some sim time in `[t0, t1]`. */
export function passedWithin(trip: Trip, p: LngLat, withinM: number, t0: SimSec, t1: SimSec): boolean {
  return distanceToPolylineM(pathInWindow(trip, t0, t1), p) <= withinM;
}

/* ------------------------------------------------------------------------ */
/* Hero rules                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Q2 outcome, read defensively because the contract lacks it.
 * TODO(subagent): contract needs `outcome?: 'served' | 'dropped'` on trips (Q2).
 */
function tripOutcome(trip: Trip): unknown {
  return (trip as Trip & { outcome?: unknown }).outcome;
}

/** Index of the candidate with the lowest key; ties keep the lowest index. */
function argMin(indices: readonly number[], key: (i: number) => number): number | null {
  let best: number | null = null;
  let bestKey = Infinity;
  for (const i of indices) {
    const k = key(i);
    if (Number.isFinite(k) && k < bestKey) { best = i; bestKey = k; }
  }
  return best;
}

/** Applies one hero rule to a result. `null` when no trip qualifies. */
export function pickHero(rule: HeroRule, result: SimulationResult, assets: SceneAssets): HeroPick | null {
  const trips = result.trips;
  const candidates: number[] = [];
  trips.forEach((t, i) => { if (t.persona === rule.persona && t.path.length > 0) candidates.push(i); });
  const last = (i: number): LngLat => point(trips[i].path[trips[i].path.length - 1]);
  let index: number | null = null;

  switch (rule.pick) {
    case 'lastPointNearestBottleneck': {
      const b = result.bySlice[rule.slice]?.bottlenecks.find((x) => x.type === rule.type);
      if (!b) return null;
      index = argMin(candidates, (i) => haversineM(last(i), [b.lng, b.lat]));
      break;
    }
    case 'lastPointNearestNode': {
      const nodes = graphNodesOf(assets, rule.node);
      if (!nodes.length) return null;
      index = argMin(candidates, (i) => Math.min(...nodes.map((n) => haversineM(last(i), [n.lng, n.lat]))));
      break;
    }
    case 'earliestPassingNode': {
      const nodes = graphNodesOf(assets, rule.node);
      if (!nodes.length) return null;
      const passing = candidates.filter((i) => {
        const line = trips[i].path.map(point);
        return nodes.some((n) => distanceToPolylineM(line, [n.lng, n.lat]) <= rule.withinM);
      });
      index = argMin(passing, (i) => tripStart(trips[i])!);
      break;
    }
    case 'longestInWindow': {
      const [w0, w1] = rule.window;
      const inWindow = candidates.filter((i) => {
        const s = tripStart(trips[i])!;
        return s >= w0 && s <= w1;
      });
      const dropped = inWindow.filter((i) => tripOutcome(trips[i]) === 'dropped');
      const pool = dropped.length ? dropped : inWindow;
      index = argMin(pool, (i) => -(tripEnd(trips[i])! - tripStart(trips[i])!));
      break;
    }
  }
  return index === null ? null : { hero: rule.hero, tripIndex: index };
}

/** Picks every hero. Heroes without a rule map to `null`. */
export function pickHeroes(
  rules: readonly HeroRule[],
  result: SimulationResult,
  assets: SceneAssets,
): Record<HeroId, HeroPick | null> {
  const out = { markus: null, helga: null, lukas: null } as Record<HeroId, HeroPick | null>;
  for (const id of HERO_IDS) {
    const rule = rules.find((r) => r.hero === id);
    if (rule) out[id] = pickHero(rule, result, assets);
  }
  return out;
}

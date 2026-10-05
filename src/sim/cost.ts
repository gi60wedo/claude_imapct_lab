// Per-persona route cost (IMPLEMENTATION_PLAN.md §6): cost = length × M_surface × M_slope × M_rain.
import type { GraphEdge, GraphNode } from './world';

export type Profile = 'walker' | 'senior' | 'van';

export interface CostContext {
  rain: boolean;
  /** Edges closed in this scenario (e.g. Christkindlesmarkt stalls). */
  closedEdges?: Uint8Array;
  /** Extra walking cost per edge, e.g. crowds in the Christkindlesmarkt. */
  walkFactor?: Float32Array;
  /** Delivery-window mitigation: removable bollards are lowered for vans. */
  unlockRemovableBollards?: boolean;
  /** Route vans as if no barrier existed, to find which bollard blocks them. */
  ignoreBarriers?: boolean;
}

export const SENIOR_COBBLE = 2.5;
export const OTHER_COBBLE = 1.1;
export const SENIOR_ROUGH = 1.6;
export const RAIN_FACTOR = 1.3;
export const SENIOR_SLOPE_THRESHOLD = 0.06;
export const SENIOR_SLOPE_GAIN = 8;

export function surfaceFactor(e: GraphEdge, profile: Profile): number {
  if (e.surface === 'smooth') return 1;
  if (profile === 'senior') return e.surface === 'cobble' ? SENIOR_COBBLE : SENIOR_ROUGH;
  return OTHER_COBBLE;
}

export function slopeFactor(e: GraphEdge, profile: Profile): number {
  return profile === 'senior' ? 1 + SENIOR_SLOPE_GAIN * Math.max(0, e.slope - SENIOR_SLOPE_THRESHOLD) : 1;
}

/** Cost to traverse edge e (Infinity = forbidden). `forward` is true when travelling a → b. */
export function edgeCost(e: GraphEdge, edgeIndex: number, forward: boolean, profile: Profile, ctx: CostContext): number {
  if (ctx.closedEdges?.[edgeIndex]) return Infinity;
  if (profile === 'van') {
    if (!e.vehicle) return Infinity;
    if (e.oneway && !forward) return Infinity;
    return e.lengthM;
  }
  if (!e.walk) return Infinity;
  if (profile === 'senior' && e.steps) return Infinity;   // steps are a hard block; elevator edges stay open
  const rain = ctx.rain && !e.sheltered ? RAIN_FACTOR : 1;
  const crowd = ctx.walkFactor ? ctx.walkFactor[edgeIndex] || 1 : 1;
  return e.lengthM * surfaceFactor(e, profile) * slopeFactor(e, profile) * rain * crowd;
}

/** Whether a van may pass through this node. */
export function vanCanPass(node: GraphNode, ctx: CostContext): boolean {
  if (ctx.ignoreBarriers || !node.barrier) return true;
  return node.barrier === 'removable_bollard' && !!ctx.unlockRemovableBollards;
}

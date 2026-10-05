// Public API of the pedestrian & delivery twin (B). UI and server code import only from here.
import type { Candidate, SimulationResult } from '../contracts';
import { simulate, describeMitigation, type SimOptions } from './engine';
import { prepareWorld } from './prepare';
import type { World } from './world';

export type { SimOptions } from './engine';
export type { Mitigation, World, SimGraph, GraphNode, GraphEdge, Pois, PopulationCell, StationArrivals } from './world';
export { gini } from './metrics';
export { describeMitigation };

export interface Twin {
  run(candidate: Candidate, opts: SimOptions): SimulationResult;
}

/** Index the world once (graph, snapping, cached pools); every run after that reuses it. */
export function createTwin(world: World): Twin {
  const pw = prepareWorld(world);
  return { run: (candidate, opts) => simulate(pw, candidate, opts) };
}

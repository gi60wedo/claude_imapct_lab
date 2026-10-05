import type { Brief, Candidate, Scenario, SimulationResult, Weights } from '../../contracts';

/** Optional run settings; clients that cannot honour one ignore it. */
export interface RunOptions {
  /**
   * Sampled trips in the result (engine default 100). Asking for trips marks a live run: the worker client
   * then simulates every modelled person (LIVE_SCALE) and returns every agent (LIVE_TRIP_CAP).
   */
  maxTrips?: number;
  /** Share of modelled people simulated as agents (engine default 0.25; live runs 1). */
  scale?: number;
}

export interface SimClient {
  candidates(): Promise<Candidate[]>;
  run(candidateId: string, scenario: Scenario, mitigations: string[], seed: number, opts?: RunOptions): Promise<SimulationResult>;
}

export interface BriefInput {
  candidates: Candidate[];
  results: SimulationResult[];
  weights: Weights;
  scenario: Scenario;
}

export interface BriefClient {
  brief(input: BriefInput): Promise<Brief>;
}

export class ScenarioUnavailableError extends Error {}

import type { Brief, Candidate, Scenario, SimulationResult, Weights } from '../../contracts';

/** Optional run settings; clients that cannot honour one ignore it. */
export interface RunOptions {
  /** Sampled trips in the result (engine default 100). The live view asks for more. */
  maxTrips?: number;
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

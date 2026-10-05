import type { Brief, Candidate, Scenario, SimulationResult, Weights } from '../../contracts';

export interface SimClient {
  candidates(): Promise<Candidate[]>;
  run(candidateId: string, scenario: Scenario, mitigations: string[], seed: number): Promise<SimulationResult>;
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

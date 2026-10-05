import type { Brief, Candidate, Scenario, SimulationResult } from '../../contracts';
import { ScenarioUnavailableError, type BriefClient, type SimClient } from './types';

const BASE = '/data/fixtures';
const getJson = async <T>(url: string): Promise<T> => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json() as Promise<T>;
};

/**
 * Fixture-backed clients. Files live in public/data/fixtures/ (copied from src/ui/__fixtures__).
 * run() ignores RunOptions: each fixture carries the trips it was generated with.
 */
export const fixtureSim: SimClient = {
  candidates: () => getJson<Candidate[]>(`${BASE}/candidates.json`),
  async run(candidateId: string, scenario: Scenario, mitigations: string[]) {
    try {
      const r = await getJson<SimulationResult>(`${BASE}/result-${candidateId}-${scenario}.json`);
      return { ...r, mitigations };
    } catch {
      throw new ScenarioUnavailableError(`${scenario} not available offline for ${candidateId}`);
    }
  },
};

export const fixtureBrief: BriefClient = {
  brief: () => getJson<Brief>(`${BASE}/brief.json`),
};

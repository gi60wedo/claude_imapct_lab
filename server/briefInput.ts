import type { Candidate, PersonaId, Scenario, SimulationResult, Weights } from '../src/contracts';
import { PERSONA_GUARD_THRESHOLD, PERSONA_IDS, WEIGHT_KEYS, normalizeWeights, rankSites } from '../src/score/score';
import { extractNumbers } from './numberCheck';

/** What the client posts to /api/brief. Mirrors `BriefInput` in src/ui/adapters/types.ts. */
export interface BriefRequest {
  candidates: Candidate[];
  results: SimulationResult[];
  weights: Weights;
  scenario: Scenario;
  mitigations?: string[];
}

export interface SitePayload {
  id: string;
  name: string;
  kind: string;
  rank: number;
  marketScore: number;
  consensus: number;
  failsStakeholderGroup: boolean;
  failedPersonas: PersonaId[];
  criteria: Weights;
  personas: Record<PersonaId, { score: number; served: number; droppedOut: number; topFriction: string }>;
  mitigations: string[];
}

/** The only facts Claude sees. Every number in a brief must trace back to this object. */
export interface BriefPayload {
  scenario: Scenario;
  weightsPct: Record<keyof Weights, number>;
  ranking: SitePayload[];
  rejected: { name: string; reason: string }[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function buildPayload(req: BriefRequest): BriefPayload {
  const names = new Map(req.candidates.map((c) => [c.id, c]));
  const weights = normalizeWeights(req.weights);
  const ranking = rankSites(req.results, weights).map((s, i): SitePayload => {
    const c = names.get(s.candidateId);
    return {
      id: s.candidateId,
      name: c?.name ?? s.candidateId,
      kind: c?.kind ?? 'benchmark',
      rank: i + 1,
      marketScore: r1(s.marketScore),
      consensus: r1(s.consensus),
      failsStakeholderGroup: s.failsStakeholderGroup,
      failedPersonas: s.failedPersonas,
      criteria: Object.fromEntries(WEIGHT_KEYS.map((k) => [k, Math.round(s.result.criteria[k])])) as unknown as Weights,
      personas: Object.fromEntries(PERSONA_IDS.map((p) => {
        const x = s.result.personas[p];
        return [p, { score: Math.round(x.score), served: Math.round(x.served), droppedOut: Math.round(x.droppedOut), topFriction: x.topFriction }];
      })) as SitePayload['personas'],
      mitigations: s.result.mitigations,
    };
  });
  return {
    scenario: req.scenario,
    weightsPct: Object.fromEntries(WEIGHT_KEYS.map((k) => [k, Math.round(weights[k] * 100)])) as Record<keyof Weights, number>,
    ranking,
    rejected: req.candidates.filter((c) => !c.passedFilter).map((c) => ({ name: c.name, reason: c.rejectReason ?? 'filtered' })),
  };
}

/** Every numeric fact in the payload, plus pairwise gaps a writer may legitimately quote ("12 points ahead"). */
export function allowedNumbers(p: BriefPayload, extra: number[] = []): number[] {
  const out: number[] = [...extra, PERSONA_GUARD_THRESHOLD, p.ranking.length, p.rejected.length, ...Object.values(p.weightsPct)];
  for (const s of p.ranking) {
    out.push(s.rank, s.marketScore, s.consensus, ...Object.values(s.criteria), ...s.mitigations.flatMap(extractNumbers), ...extractNumbers(s.name));
    for (const x of Object.values(s.personas)) out.push(x.score, x.served, x.droppedOut, ...extractNumbers(x.topFriction));
  }
  for (const r of p.rejected) out.push(...extractNumbers(r.name), ...extractNumbers(r.reason));
  for (let i = 0; i < p.ranking.length; i++) {
    for (let j = i + 1; j < p.ranking.length; j++) {
      const a = p.ranking[i], b = p.ranking[j];
      out.push(Math.abs(a.marketScore - b.marketScore), Math.abs(a.consensus - b.consensus));
      for (const k of WEIGHT_KEYS) out.push(Math.abs(a.criteria[k] - b.criteria[k]));
      for (const id of PERSONA_IDS) out.push(Math.abs(a.personas[id].score - b.personas[id].score));
    }
  }
  return out;
}

import type { Brief, PersonaId } from '../../contracts';
import { fixtureBrief } from './fixtures';
import type { BriefClient, BriefInput } from './types';

/** Request shape of the Part D server (server/briefInput.ts). */
export type ServerRequest = BriefInput;

export interface BriefResponse { brief: Brief; source: 'claude' | 'cache' | 'cache-latest' | 'template'; ms: number; warning?: string }
export interface MitigationResponse {
  mitigation: { id: string; kind: string; persona: PersonaId; count: number; window: string; rationale: string };
  source: 'claude' | 'template';
}
export interface DeltaResponse { summary: string; source: 'claude' | 'template' }
export type VerdictsResponse = Record<PersonaId, { verdict: string; source: 'claude' | 'template' }>;

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json() as Promise<T>;
}

export const fetchBrief = (req: ServerRequest) => post<BriefResponse>('/api/brief', req);
export const fetchMitigation = (request: ServerRequest, candidateId: string) => post<MitigationResponse>('/api/mitigation', { request, candidateId });
export const fetchVerdicts = (request: ServerRequest, candidateId: string) => post<VerdictsResponse>('/api/verdicts', { request, candidateId });
export const fetchDelta = (before: ServerRequest, after: ServerRequest) => post<DeltaResponse>('/api/delta', { before, after });

/** Live brief from the Part D server; if it is unreachable the UI keeps working on the fixture brief. */
export const httpBrief: BriefClient = {
  async brief(input: BriefInput): Promise<Brief> {
    try {
      return (await fetchBrief(input)).brief;
    } catch (e) {
      console.warn('[brief] server unavailable, using fixture brief', e);
      return fixtureBrief.brief(input);
    }
  },
};

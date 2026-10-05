import { fetchBrief, fetchDelta, fetchMitigation, fetchVerdicts, type ServerRequest } from '../adapters/http';
import { sim } from '../adapters';
import { currentResults, getState, resultKey, setState, subscribe, type UiState } from '../state/store';

/** Engine output for the active scenario, in the shape the Part D server expects. */
export function buildRequest(s: UiState = getState()): ServerRequest {
  return { candidates: s.candidates, results: Object.values(currentResults(s)), weights: s.weights, scenario: s.scenario };
}

const briefSig = (s: UiState) =>
  JSON.stringify([s.scenario, s.weights, Object.values(currentResults(s)).map((r) => [r.candidateId, r.mitigations])]);
/** Weights alone don't change what happened in the simulation, so only scenario/mitigation changes get a "what changed" line. */
const worldSig = (s: UiState) =>
  JSON.stringify([s.scenario, Object.values(currentResults(s)).map((r) => [r.candidateId, r.mitigations])]);

const DEBOUNCE_MS = 700;

/**
 * Keeps the brief, the "what changed" line and the selected site's persona verdicts in sync with the store.
 * Weight drags are debounced; stale responses are dropped. Returns an unsubscribe function.
 */
export function startLive(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastBriefSig = briefSig(getState());
  let lastWorld = worldSig(getState());
  let lastRequest: ServerRequest | null = getState().candidates.length ? buildRequest() : null;
  let epoch = 0;
  const verdictsFor = new Set<string>();

  async function refreshBrief() {
    const mine = ++epoch;
    const s = getState();
    if (s.candidates.length === 0) return;
    const request = buildRequest(s);
    const world = worldSig(s);
    const before = lastRequest;
    const worldChanged = world !== lastWorld;
    lastRequest = request;
    lastWorld = world;
    try {
      const [res, delta] = await Promise.all([
        fetchBrief(request),
        worldChanged && before ? fetchDelta(before, request).catch(() => null) : Promise.resolve(null),
      ]);
      if (mine !== epoch) return;
      setState((cur) => ({
        brief: res.brief,
        briefMeta: { source: res.source, ms: res.ms, delta: delta?.summary ?? (worldChanged ? undefined : cur.briefMeta?.delta), mitigation: cur.briefMeta?.mitigation },
      }));
    } catch (e) {
      console.warn('[live] brief refresh failed, keeping previous brief', e);
    }
  }

  async function loadVerdicts() {
    const s = getState();
    const id = s.selectedId;
    const result = id ? currentResults(s)[id] : undefined;
    if (!id || !result || result.personas.senior.verdict) return;
    const key = `${resultKey(id, s.scenario)}|${result.mitigations.join(',')}`;
    if (verdictsFor.has(key)) return;
    verdictsFor.add(key);
    try {
      const v = await fetchVerdicts(buildRequest(s), id);
      setState((cur) => {
        const k = resultKey(id, s.scenario);
        const r = cur.results[k];
        if (!r || r.mitigations.join(',') !== result.mitigations.join(',')) return {};
        const personas = Object.fromEntries(
          (Object.keys(r.personas) as (keyof typeof r.personas)[]).map((p) => [p, { ...r.personas[p], verdict: v[p]?.verdict }]),
        ) as typeof r.personas;
        return { results: { ...cur.results, [k]: { ...r, personas } } };
      });
    } catch (e) {
      verdictsFor.delete(key);
      console.warn('[live] verdicts failed', e);
    }
  }

  const stop = subscribe(() => {
    const s = getState();
    const sig = briefSig(s);
    if (sig !== lastBriefSig) {
      lastBriefSig = sig;
      clearTimeout(timer);
      timer = setTimeout(refreshBrief, DEBOUNCE_MS);
    }
    void loadVerdicts();
  });
  void refreshBrief();
  void loadVerdicts();
  return () => { stop(); clearTimeout(timer); epoch++; };
}

/** Propose → simulate → judge: Claude proposes, the engine re-runs, and the subscription re-briefs. */
export async function applyLiveMitigation(candidateId: string): Promise<void> {
  const s = getState();
  const result = currentResults(s)[candidateId];
  if (!result) throw new Error('no result for ' + candidateId);
  const { mitigation, source } = await fetchMitigation(buildRequest(s), candidateId);
  const next = await sim.run(candidateId, s.scenario, [...result.mitigations, mitigation.id], result.seed);
  setState((cur) => ({
    results: { ...cur.results, [resultKey(next.candidateId, next.scenario)]: next },
    briefMeta: { source: cur.briefMeta?.source ?? 'claude', ms: cur.briefMeta?.ms ?? 0, delta: cur.briefMeta?.delta, mitigation: { id: mitigation.id, rationale: mitigation.rationale, source } },
  }));
}

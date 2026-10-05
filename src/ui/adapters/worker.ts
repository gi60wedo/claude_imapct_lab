import type { Candidate, Scenario, SimulationResult } from '../../contracts';
import type { SimOptions, World } from '../../sim';
import type { WorkerRequest, WorkerResponse } from '../../sim/worker';
import { fixtureSim } from './fixtures';
import { toMitigation } from './mitigations';
import type { RunOptions, SimClient } from './types';

/** Live runs simulate every modelled person, not the engine's default quarter. */
export const LIVE_SCALE = 1;
/**
 * Trip cap for live runs, high enough that every agent comes back. A scale-1 run on public/data/world.json
 * moves at most a few thousand agents (src/sim/__tests__/scale.test.ts prints the counts).
 */
export const LIVE_TRIP_CAP = 100_000;

/**
 * Engine options for one run. A caller that asks for trips (the live view) or sets a scale gets a live run:
 * scale 1 unless it names one, and every agent up to LIVE_TRIP_CAP. Other callers keep the engine defaults.
 */
export function liveOptions(run: RunOptions): Pick<SimOptions, 'scale' | 'maxTrips'> {
  if (run.maxTrips === undefined && run.scale === undefined) return {};
  return { scale: run.scale ?? LIVE_SCALE, maxTrips: Math.max(run.maxTrips ?? 0, LIVE_TRIP_CAP) };
}

const getJson = async <T>(url: string): Promise<T> => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json() as Promise<T>;
};

/**
 * Live SimClient backed by B's engine in a Web Worker.
 * Candidates come from Part A (/data/candidates.json), else the fixture list, whose three benchmarks
 * take the engine's surveyed polygons from /data/benchmarks.json.
 */
export function workerSim(): SimClient {
  const worker = new Worker(new URL('../../sim/worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, { resolve: (r: SimulationResult) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let readyResolve: () => void;
  let readyReject: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => { readyResolve = res; readyReject = rej; });

  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const msg = ev.data;
    if (msg.type === 'ready') return readyResolve();
    if (msg.type === 'error' && msg.id === undefined) return readyReject(new Error(msg.message));
    const p = pending.get(msg.id!);
    if (!p) return;
    pending.delete(msg.id!);
    if (msg.type === 'result') p.resolve(msg.result);
    else p.reject(new Error(msg.message));
  };
  getJson<World>('/data/world.json')
    .then((world) => worker.postMessage({ type: 'init', world } satisfies WorkerRequest))
    .catch((e: Error) => readyReject(e));

  let candidates: Promise<Candidate[]> | null = null;
  /** UI id → engine benchmark id; the engine keys loading points by its own ids. */
  const engineIds = new Map<string, string>();
  const loadCandidates = () => (candidates ??= getJson<{ candidates: Candidate[] }>('/data/candidates.json')
    .then((f) => f.candidates)          // Part A's discovered candidates; ids match the engine's benchmark ids
    .catch(() => fixtureCandidates()));
  const fixtureCandidates = () => Promise.all([
    fixtureSim.candidates(),
    getJson<Candidate[]>('/data/benchmarks.json'),
  ]).then(([list, bench]) => {
    const byId = new Map(bench.map((b) => [b.id.toUpperCase(), b]));
    return list.map((c) => {
      const b = byId.get(c.id);
      if (b) engineIds.set(c.id, b.id);
      return b ? { ...c, polygon: b.polygon, areaM2: b.areaM2 } : c;
    });
  });

  return {
    candidates: loadCandidates,
    async run(candidateId: string, scenario: Scenario, mitigations: string[], seed: number, run: RunOptions = {}) {
      const site = (await loadCandidates()).find((c) => c.id === candidateId);
      if (!site) throw new Error(`unknown candidate ${candidateId}`);
      await ready;
      const opts: SimOptions = {
        scenario, seed,
        mitigations: mitigations.map((m) => toMitigation(m, site)).filter((m) => m !== null),
        ...liveOptions(run),
      };
      const id = nextId++;
      const candidate = { ...site, id: engineIds.get(site.id) ?? site.id };
      const result = await new Promise<SimulationResult>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ type: 'run', id, candidate, opts } satisfies WorkerRequest);
      });
      return { ...result, candidateId: site.id };
    },
  };
}

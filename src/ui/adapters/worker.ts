import type { Candidate, Scenario, SimulationResult } from '../../contracts';
import type { SimOptions, World } from '../../sim';
import type { WorkerRequest, WorkerResponse } from '../../sim/worker';
import { fixtureSim } from './fixtures';
import { toMitigation } from './mitigations';
import type { SimClient } from './types';

const getJson = async <T>(url: string): Promise<T> => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json() as Promise<T>;
};

/**
 * Live SimClient backed by B's engine in a Web Worker.
 * Candidates come from the fixture list (A's discovery output later); the three benchmarks
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
  const loadCandidates = () => (candidates ??= Promise.all([
    fixtureSim.candidates(),
    getJson<Candidate[]>('/data/benchmarks.json'),
  ]).then(([list, bench]) => {
    const byId = new Map(bench.map((b) => [b.id.toUpperCase(), b]));
    return list.map((c) => {
      const b = byId.get(c.id);
      return b ? { ...c, polygon: b.polygon, areaM2: b.areaM2 } : c;
    });
  }));

  return {
    candidates: loadCandidates,
    async run(candidateId: string, scenario: Scenario, mitigations: string[], seed: number) {
      const site = (await loadCandidates()).find((c) => c.id === candidateId);
      if (!site) throw new Error(`unknown candidate ${candidateId}`);
      await ready;
      const opts: SimOptions = {
        scenario, seed,
        mitigations: mitigations.map((m) => toMitigation(m, site)).filter((m) => m !== null),
      };
      const id = nextId++;
      return new Promise<SimulationResult>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ type: 'run', id, candidate: site, opts } satisfies WorkerRequest);
      });
    },
  };
}

// Web Worker entry. In the UI (C): new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' })
// Messages: { type: 'init', world } once, then { type: 'run', id, candidate, opts }. Replies carry the same id.
import type { Candidate, SimulationResult } from '../contracts';
import { createTwin, type SimOptions, type Twin, type World } from './index';

export type WorkerRequest =
  | { type: 'init'; world: World }
  | { type: 'run'; id: number; candidate: Candidate; opts: SimOptions };

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'result'; id: number; result: SimulationResult; ms: number }
  | { type: 'error'; id?: number; message: string };

let twin: Twin | null = null;
const post = (msg: WorkerResponse) => (self as unknown as Worker).postMessage(msg);

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      twin = createTwin(msg.world);
      post({ type: 'ready' });
    } else if (msg.type === 'run') {
      if (!twin) throw new Error('worker not initialised: send { type: "init", world } first');
      const t = performance.now();
      const result = twin.run(msg.candidate, msg.opts);
      post({ type: 'result', id: msg.id, result, ms: performance.now() - t });
    }
  } catch (e) {
    post({ type: 'error', id: msg.type === 'run' ? msg.id : undefined, message: e instanceof Error ? e.message : String(e) });
  }
};

// @vitest-environment node
// The live run the worker client sends: scale 1 and every agent. Times it the way the worker does
// (twin.run inside src/sim/worker.ts, then postMessage's structured clone) on a fresh twin.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Candidate, Scenario, SimulationResult } from '../../contracts';
import { createTwin, type World } from '../../sim';
import { LIVE_MAX_TRIPS } from '../live/clock';
import { LIVE_SCALE, LIVE_TRIP_CAP, liveOptions } from './worker';

const read = <T>(path: string) => JSON.parse(readFileSync(`${process.cwd()}/${path}`, 'utf8')) as T;

describe('liveOptions', () => {
  it('keeps the engine defaults for callers that ask for no trips', () => {
    expect(liveOptions({})).toEqual({});
  });

  it('runs the live view at scale 1 with every agent', () => {
    expect(liveOptions({ maxTrips: LIVE_MAX_TRIPS })).toEqual({ scale: LIVE_SCALE, maxTrips: LIVE_TRIP_CAP });
    expect(LIVE_SCALE).toBe(1);
    expect(liveOptions({ scale: 0.5 })).toEqual({ scale: 0.5, maxTrips: LIVE_TRIP_CAP });
  });
});

describe('live run in the worker path', () => {
  it('returns every agent at scale 1 in under 1.5 s per run (median of 3)', () => {
    const twin = createTwin(read<World>('public/data/world.json'));
    const bench = read<Candidate[]>('public/data/benchmarks.json');
    const fixtures = new Map(read<Candidate[]>('public/data/fixtures/candidates.json').map((c) => [c.id, c]));
    const sites = bench.map((b) => ({ ...fixtures.get(b.id.toUpperCase())!, polygon: b.polygon, areaM2: b.areaM2 }));
    const opts = liveOptions({ maxTrips: LIVE_MAX_TRIPS });
    const rows: string[] = [];
    let worst = 0;
    for (const scenario of ['SUNNY_SAT', 'RAINY_SAT', 'CHRISTMAS_MARKET'] as Scenario[]) {
      for (const site of sites) {
        // The first run of a scenario builds its scale-1 pool, as the worker's first run does.
        const times: { run: number; clone: number }[] = [];
        let result!: SimulationResult;
        for (let k = 0; k < 3; k++) {
          const t = performance.now();
          result = twin.run(site, { scenario, seed: 42, mitigations: [], ...opts });
          const run = performance.now() - t;
          structuredClone(result);
          times.push({ run, clone: performance.now() - t - run });
        }
        const total = times.map((x) => x.run + x.clone);
        const median = [...total].sort((a, b) => a - b)[1];
        worst = Math.max(worst, median);
        const all = twin.run(site, { scenario, seed: 42, mitigations: [], scale: 1, maxTrips: Infinity });
        expect(result.trips.length).toBe(all.trips.length);
        expect(result.trips.length).toBeLessThan(LIVE_TRIP_CAP);
        const vertices = result.trips.reduce((n, x) => n + x.path.length, 0);
        rows.push(`${site.id.padEnd(13)} ${scenario.padEnd(16)} ${String(result.trips.length).padStart(5)} trips, ` +
          `${String(vertices).padStart(6)} vertices, ${(JSON.stringify(result).length / 1e6).toFixed(1).padStart(4)} MB JSON | ` +
          `first ${times[0].run.toFixed(0).padStart(4)} + ${times[0].clone.toFixed(0).padStart(3)} ms, ` +
          `median run+clone ${median.toFixed(0).padStart(4)} ms`);
      }
    }
    process.stderr.write(`scale ${LIVE_SCALE} worker path (run = twin.run, clone = postMessage's structured clone):\n` +
      `${rows.join('\n')}\nworst median ${worst.toFixed(0)} ms\n`);
    expect(worst).toBeLessThan(1500);
  }, 120_000);
});

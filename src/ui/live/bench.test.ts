// Engine run size for the live view: how long simulate takes per maxTrips on the real world.
// Opt in with BENCH=1 (npx vitest run src/ui/live/bench.test.ts); it loads the 2.7 MB world.
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import type { Candidate } from '../../contracts';
import { createTwin, type World } from '../../sim';
import { LIVE_MAX_TRIPS } from './clock';

const SIZES = [100, 300, 1000, 2000];

test.skipIf(!process.env.BENCH)('simulate time per maxTrips on public/data/world.json', () => {
  const world = JSON.parse(readFileSync(`${process.cwd()}/public/data/world.json`, 'utf8')) as World;
  const sites = JSON.parse(readFileSync(`${process.cwd()}/public/data/benchmarks.json`, 'utf8')) as Candidate[];
  const twin = createTwin(world);
  twin.run(sites[0], { scenario: 'SUNNY_SAT', seed: 42 }); // warm the JIT and the cached pools
  const rows: string[] = [];
  for (const site of sites) {
    for (const maxTrips of SIZES) {
      const t = performance.now();
      const r = twin.run(site, { scenario: 'SUNNY_SAT', seed: 42, maxTrips });
      const ms = performance.now() - t;
      const ts = r.trips.flatMap((x) => x.path.map((p) => p[2]));
      rows.push(`${site.id.padEnd(14)} maxTrips ${String(maxTrips).padStart(4)} → ${String(r.trips.length).padStart(4)} trips, ` +
        `${ms.toFixed(0).padStart(5)} ms, t ${Math.min(...ts)}–${Math.max(...ts)} s`);
      if (maxTrips === LIVE_MAX_TRIPS) expect(ms).toBeLessThan(1500);
    }
  }
  process.stderr.write(`${rows.join('\n')}\n`);
}, 120_000);

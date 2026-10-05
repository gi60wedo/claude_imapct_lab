// Dev-only: runs the three benchmarks × scenarios on real data and prints a comparison table.
// Usage: npm run sim:report [-- --seed 7]
import type { Scenario } from '../../contracts';
import { createTwin } from '../index';
import { benchmarkCandidates } from './benchmarks';
import { buildOsmWorld } from './osmWorld';

const seedArg = process.argv.indexOf('--seed');
const seed = seedArg > 0 ? Number(process.argv[seedArg + 1]) : 42;

let t = performance.now();
const world = buildOsmWorld();
console.log(`world: ${world.graph.nodes.length} nodes, ${world.graph.edges.length} edges, ` +
  `${world.population.length} Zensus cells, ${world.stations.length} stations, ${world.pois.vanEntries.length} van entries ` +
  `(${Math.round(performance.now() - t)} ms)`);
const twin = createTwin(world);
const sites = benchmarkCandidates(world);

for (const scenario of ['SUNNY_SAT', 'RAINY_SAT', 'CHRISTMAS_MARKET'] as Scenario[]) {
  console.log(`\n── ${scenario} (seed ${seed}) ──`);
  for (const site of sites) {
    t = performance.now();
    const r = twin.run(site, { scenario, seed });
    const ms = Math.round(performance.now() - t);
    const c = r.criteria;
    console.log(`${site.name.padEnd(30)} ${ms} ms  access ${c.accessibility}  footfall ${c.footfall}  fair ${c.fairness}  ` +
      `local ${c.localBusiness}  walk ${c.walkability}`);
    for (const [id, p] of Object.entries(r.personas)) {
      console.log(`   ${id.padEnd(9)} ${String(p.score).padStart(5)}  served ${p.served}  dropped ${p.droppedOut}  · ${p.topFriction}`);
    }
    const b = r.bySlice['11:30_PEAK'].bottlenecks[0] ?? r.bySlice['05:30_DELIVERY'].bottlenecks[0];
    if (b) console.log(`   bottleneck ${b.type} ${b.severity} ${b.time} · ${b.cause}`);
  }
}

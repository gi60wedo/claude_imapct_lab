// Dev-only: writes the browser inputs for the live Web Worker adapter.
// Usage: npm run sim:export-world  → public/data/world.json, public/data/benchmarks.json
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { benchmarkCandidates } from './benchmarks';
import { buildOsmWorld, REPO } from './osmWorld';

const round = (v: unknown): unknown =>
  typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e6) / 1e6
    : Array.isArray(v) ? v.map(round)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)]))
    : v;

const world = buildOsmWorld();
const out = resolve(REPO, 'public/data');
writeFileSync(resolve(out, 'world.json'), JSON.stringify(round(world)));
writeFileSync(resolve(out, 'benchmarks.json'), JSON.stringify(round(benchmarkCandidates(world)), null, 1));
console.log(`world.json: ${world.graph.nodes.length} nodes, ${world.graph.edges.length} edges, ${world.stations.length} stations`);

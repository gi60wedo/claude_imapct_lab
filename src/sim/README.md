# src/sim: Pedestrian & Delivery Twin (B)

Pure TypeScript, seeded and deterministic. Runs in a Web Worker in the browser and in Node for tests.

```bash
npm test                 # Vitest: unit tests on a synthetic grid plus integration on datasets/
npm run sim:report       # 3 benchmarks × 3 scenarios on real Nuremberg data, printed as a table
npm run sim:dev-data     # re-extract Saturday U-Bahn/tram arrivals from the GTFS zip (needs unzip)
```

## API

```ts
import { createTwin } from './sim';
const twin = createTwin(world);                        // index the graph once
const result = twin.run(candidate, { scenario: 'RAINY_SAT', seed: 42, mitigations: [...] });   // SimulationResult
```

**C (UI):** use `worker.ts`. Post `{ type: 'init', world }` once, then `{ type: 'run', id, candidate, opts }`. Replies are `{ type: 'result', id, result, ms }`.

**D (Claude):** `propose_mitigation` should return a `Mitigation` from `world.ts`. Pass it in `opts.mitigations`, rerun, and compare. The engine echoes each mitigation's `label` in `result.mitigations`.

```ts
{ kind: 'kiosk', lng, lat, label? }                    // express stall: commuters 4 min, seniors served there
{ kind: 'delivery_window', unlockRemovableBollards: true }
{ kind: 'loading_point', lng, lat }                    // extra van loading node, must be ≤ 80 m from the stalls
{ kind: 'stall_layout', layout: 'loop' | 'cluster' }   // loop spreads visitors → fairness
```

**A (prep):** the engine reads a `World` (`world.ts`): graph nodes and edges with `walk`, `vehicle`, `oneway`, `steps`, `surface`, `sheltered`, `slope` and `widthM`, plus POIs, Zensus cells and GTFS station arrivals. `dev/osmWorld.ts` builds the same shape from `datasets/` and documents the OSM rules. The main gaps for `prep/` to fill:
- `slope` comes only from OSM `incline` tags. Replace it with DGM1 slope per edge.
- The Kaufhof polygon in `dev/benchmarks.ts` is approximate. Replace it with the LoD2 outline.

## Model in one paragraph

Agent pools come from data. Seniors and residents come from the Zensus 100 m grid, using its 65+ share. Lunch commuters and passers come from Saturday GTFS U-Bahn arrivals, and tourists from OSM attractions and hotels. Vans start at ring-road entries at 05:30. For each site, multi-source Dijkstra runs from the site's entrances with the §6 cost functions (cobble ×2.5, slope, rain ×1.3, steps blocked for seniors, vans only on vehicle-legal edges, stopped by bollards). Each agent then decides whether to come using the §2/§6 budgets and drop-off formulas. Trips are ticked every 30 s through the three time slices, producing heat, crowding density, elevator load and cobblestone exposure. Every constant is in `params.ts`, for the Method slide.

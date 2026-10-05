// A 12 × 12 street grid (25 m blocks) with known frictions, small enough to reason about by hand.
//
//   y=11 ┌──────────────────────── Alpha U-Bahn (10,10), elevator (9,9)
//        │        steps (5,8)–(5,9)
//   y=6  ├══vehicle row══B══════════[ EAST square 8..10 × 5..7 ]   B = removable bollard at (3,6)
//        │   cobbles in columns 3–4
//   y=0  ╞══vehicle ring══ [WEST site 1..2 × 1..2] Beta U-Bahn (1,1)  van entry (0,0)
import type { Candidate } from '../../contracts';
import type { GraphEdge, GraphNode, LngLat, World } from '../world';

export const LNG0 = 11.07;
export const LAT0 = 49.45;
const DX = 25 / 72420;
const DY = 25 / 111195;
const N = 12;

export const at = (i: number, j: number): LngLat => [LNG0 + i * DX, LAT0 + j * DY];
export const id = (i: number, j: number) => j * N + i;

function rect(i0: number, j0: number, i1: number, j1: number): [number, number][] {
  const pad = 0.4;
  return [at(i0 - pad, j0 - pad), at(i1 + pad, j0 - pad), at(i1 + pad, j1 + pad), at(i0 - pad, j1 + pad)];
}

export function gridWorld(): World {
  const nodes: GraphNode[] = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const [lng, lat] = at(i, j);
    nodes.push({ lng, lat });
  }
  nodes[id(3, 6)].barrier = 'removable_bollard';
  nodes[id(9, 9)].elevator = true;

  const edges: GraphEdge[] = [];
  const add = (a: number, b: number, vehicle: boolean, extra: Partial<GraphEdge> = {}) =>
    edges.push({ a, b, lengthM: 25, slope: 0, steps: false, surface: 'smooth', sheltered: false, walk: true,
                 vehicle, oneway: false, widthM: 3, ...extra });
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const cobble = i === 3 || i === 4 ? { surface: 'cobble' as const } : {};
    if (i + 1 < N) add(id(i, j), id(i + 1, j), j === 0 || j === 6, { ...cobble, name: `Row ${j}` });
    if (j + 1 < N) {
      const steps = i === 5 && j === 8 ? { steps: true } : {};
      add(id(i, j), id(i, j + 1), i === 0, { ...cobble, ...steps, name: `Column ${i}` });
    }
  }

  const arrivals = Array.from({ length: 126 }, (_, k) => 5 * 3600 + k * 300);   // every 5 min, 05:00–15:30
  return {
    graph: { nodes, edges },
    pois: {
      subwayEntrances: [{ lng: at(10, 10)[0], lat: at(10, 10)[1], station: 'Alpha' },
                        { lng: at(1, 1)[0], lat: at(1, 1)[1], station: 'Beta' }],
      elevators: [at(9, 9)],
      stops: [{ lng: at(2, 3)[0], lat: at(2, 3)[1], name: 'Tram West', mode: 'tram' }],
      shops: [at(3, 1), at(4, 2), at(7, 6), at(7, 5), at(11, 6), at(6, 9)],
      attractions: [at(6, 10), at(5, 4)],
      vanEntries: [at(0, 0)],
    },
    population: [
      { lng: at(2, 9)[0], lat: at(2, 9)[1], pop: 600, share65: 0.3 },
      { lng: at(9, 2)[0], lat: at(9, 2)[1], pop: 600, share65: 0.2 },
      { lng: at(6, 6)[0], lat: at(6, 6)[1], pop: 400, share65: 0.25 },
    ],
    stations: [
      { name: 'Alpha', lng: at(10, 10)[0], lat: at(10, 10)[1], mode: 'subway', arrivals },
      { name: 'Beta', lng: at(1, 1)[0], lat: at(1, 1)[1], mode: 'subway', arrivals },
    ],
    christmasMarket: rect(1, 1, 2, 2),
  };
}

const indicators: Candidate['indicators'] = {
  transitScore: 0, walkScore: 0, population800m: 0, retailPoi400m: 0, attractions400m: 0, deliveryAccess: false, vanDistM: 0,
};

export const EAST: Candidate = { id: 'east', name: 'East square', kind: 'square', polygon: rect(8, 5, 10, 7),
                                 areaM2: 4000, indicators, passedFilter: true };
export const WEST: Candidate = { id: 'west', name: 'West hall', kind: 'ground_floor', polygon: rect(1, 1, 2, 2),
                                 areaM2: 2000, indicators, passedFilter: true };

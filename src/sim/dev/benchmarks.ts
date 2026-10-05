// Dev-only fixtures for the three organizer sites until A's candidates.json lands.
// Indicators are A's job and left empty here; the twin only reads id, kind, polygon and areaM2.
import type { Candidate } from '../../contracts';
import { LocalProjection, polygonArea } from '../geo';
import type { World } from '../world';

const emptyIndicators: Candidate['indicators'] = {
  transitScore: 0, walkScore: 0, population800m: 0, retailPoi400m: 0, attractions400m: 0, deliveryAccess: false, vanDistM: 0,
};

/** Explicit development loading locations, supplementary to OSM loading tags.
 * Coordinates use street-side graph nodes.
 */
export const BENCHMARK_LOADING_POINTS: NonNullable<World['loadingPoints']> = {
  // Existing market delivery access at the square's north-west Waaggasse edge.
  hauptmarkt: [[11.0768662, 49.454408]],
  // Kaufhof: no entry. The Peuntgasse dock point was placed for the old approximate footprint and lies ~150 m
  // from the LoD2 building (limit 80 m), so Kaufhof uses the baseline nearest vehicle-legal node until A confirms its dock.
  // No designated unloading inside the pedestrian plaza behind the bollards.
  lorenzkirche: [],
};

function candidate(id: string, name: string, kind: Candidate['kind'], polygon: [number, number][]): Candidate {
  const proj = new LocalProjection(polygon[0][0], polygon[0][1]);
  const areaM2 = Math.round(polygonArea(polygon.map(([lng, lat]) => proj.toXY(lng, lat))));
  return { id, name, kind, polygon, areaM2, indicators: emptyIndicators, passedFilter: true };
}

export function benchmarkCandidates(world: World): Candidate[] {
  return [
    // OSM way 136698909 (place=square), the same outline the Christkindlesmarkt occupies.
    candidate('hauptmarkt', 'Hauptmarkt (baseline)', 'square', world.christmasMarket),
    // Lorenzer Platz: west forecourt and south side of St. Lorenz, traced from OSM ways 316484911 and 144721691.
    candidate('lorenzkirche', 'St. Lorenzkirche plaza', 'pedestrian', [
      [11.0775, 49.4505], [11.0800, 49.4505], [11.0800, 49.45078], [11.07795, 49.45078],
      [11.07795, 49.4515], [11.0775, 49.4515],
    ]),
    // LoD2 building "Königstraße 42,44,46,48,50,52" (3,843 m², 26.9 m). OSM way 144721687 tags it
    // disused:shop=department_store, and tenants inside are described as the former Kaufhof building.
    candidate('kaufhof', 'Former Kaufhof (ground floor)', 'ground_floor', [
      [11.078926, 49.449589], [11.078586, 49.449513], [11.078584, 49.449518], [11.07834, 49.449465], [11.078155, 49.449435],
      [11.078157, 49.44943], [11.078075, 49.449418], [11.078031, 49.449412], [11.078002, 49.449408], [11.077996, 49.449407],
      [11.077984, 49.44948], [11.077953, 49.449678], [11.07795, 49.4497], [11.077943, 49.449743], [11.077936, 49.449786],
      [11.077915, 49.449936], [11.077917, 49.449936], [11.077904, 49.450022], [11.077907, 49.450022], [11.078016, 49.450032],
      [11.078225, 49.450062], [11.078223, 49.450067], [11.078516, 49.450108], [11.078519, 49.450105], [11.078567, 49.450045],
      [11.078637, 49.449957], [11.07893, 49.44959],
    ]),
  ];
}

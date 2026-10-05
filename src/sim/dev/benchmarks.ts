// Dev-only fixtures for the three organizer sites until A's candidates.json lands.
// Indicators are A's job and left empty here; the twin only reads id, kind, polygon and areaM2.
import type { Candidate } from '../../contracts';
import { LocalProjection, polygonArea } from '../geo';
import type { World } from '../world';

const emptyIndicators: Candidate['indicators'] = {
  transitScore: 0, walkScore: 0, population800m: 0, retailPoi400m: 0, attractions400m: 0, deliveryAccess: false, vanDistM: 0,
};

/** Explicit development loading locations, supplementary to OSM loading tags.
 * Coordinates use street-side graph nodes; the Kaufhof footprint remains approximate.
 */
export const BENCHMARK_LOADING_POINTS: NonNullable<World['loadingPoints']> = {
  // Existing market delivery access at the square's north-west Waaggasse edge.
  hauptmarkt: [[11.0768662, 49.454408]],
  // Rear dock access via Peuntgasse, behind the store rather than its Königstraße frontage.
  kaufhof: [[11.0805479, 49.4489816]],
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
    // TODO(A): approximate footprint around the plan's 49.4490, 11.0800. Replace with the LoD2 outline.
    candidate('kaufhof', 'Former Kaufhof (ground floor)', 'ground_floor', [
      [11.079516, 49.448798], [11.080484, 49.448798], [11.080484, 49.449202], [11.079516, 49.449202],
    ]),
  ];
}

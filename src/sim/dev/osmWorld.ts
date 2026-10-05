// Dev-only: builds a World straight from datasets/ so B can run on real Nuremberg data before A's
// prep/ outputs exist. A's graph.json should match these rules (or improve them, e.g. DGM1 slope).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { centroid, distanceToPolygon, haversineM, LocalProjection, segmentWithinPolygon } from '../geo';
import type { GraphEdge, GraphNode, LngLat, PopulationCell, RoadCondition, StationArrivals, Surface, World } from '../world';
import { BENCHMARK_LOADING_POINTS } from './benchmarks';

export const REPO = resolve(import.meta.dirname, '../../..');
const OSM_PATH = resolve(REPO, 'datasets/osm/altstadt.json');
const ZENSUS_DIR = resolve(REPO, 'datasets/zensus');
export const STATIONS_PATH = resolve(import.meta.dirname, 'data/stations.dev.json');
export const ROAD_CONDITIONS_PATH = resolve(import.meta.dirname, 'data/road-conditions.dev.json');
export const WORLD_DATA_PATHS = [OSM_PATH, STATIONS_PATH,
  resolve(ZENSUS_DIR, 'nuernberg_population_100m.csv'), resolve(ZENSUS_DIR, 'nuernberg_share_65plus_100m.csv')];

/** Altstadt bbox from datasets/README.md (WGS84). */
export const BBOX = { minLat: 49.444, minLng: 11.065, maxLat: 49.461, maxLng: 11.092 };

interface OsmElement {
  type: 'node' | 'way' | 'relation'; id: number;
  lat?: number; lon?: number;
  nodes?: number[]; geometry?: { lat: number; lon: number }[];
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
  tags?: Record<string, string>;
}

const WALK_HIGHWAYS = new Set(['footway', 'path', 'pedestrian', 'living_street', 'residential', 'service', 'steps',
  'track', 'cycleway', 'primary', 'secondary', 'tertiary', 'unclassified', 'platform', 'corridor', 'elevator',
  'primary_link', 'secondary_link', 'tertiary_link']);
const ROAD_HIGHWAYS = new Set(['primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service',
  'primary_link', 'secondary_link', 'tertiary_link']);
const DEFAULT_WIDTH: Record<string, number> = { footway: 2.5, path: 2, pedestrian: 8, steps: 2, residential: 2, service: 1.5,
  primary: 3, secondary: 3, tertiary: 2.5, living_street: 4, platform: 3, corridor: 3, elevator: 1.5, cycleway: 2 };
const COBBLE = new Set(['sett', 'cobblestone', 'unhewn_cobblestone', 'cobblestone:flattened']);
const ROUGH = new Set(['gravel', 'fine_gravel', 'compacted', 'dirt', 'grass', 'ground', 'unpaved', 'pebblestone']);
const VAN_OK = /\b(yes|delivery|destination|designated|permissive)\b/;
const VAN_NO = new Set(['no', 'private', 'customers', 'agricultural', 'forestry', 'permit']);
const DELIVERY_TIME = 5.5;   // vans arrive at 05:30

/** Whether a 3.5 t delivery van may drive this way at 05:30, from OSM access tags. */
export function vanAllowed(t: Record<string, string>): boolean {
  for (const key of ['motor_vehicle:conditional', 'vehicle:conditional', 'access:conditional']) {
    const v = t[key];
    if (!v) continue;
    for (const part of v.split(';')) {
      const m = part.match(/^\s*([a-z;]+)\s*@\s*\(?\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
      if (!m) continue;
      const from = +m[2] + +m[3] / 60;
      const to = +m[4] + +m[5] / 60;
      const inside = from <= to ? DELIVERY_TIME >= from && DELIVERY_TIME < to : DELIVERY_TIME >= from || DELIVERY_TIME < to;
      if (inside) return VAN_OK.test(m[1]);
    }
  }
  const explicit = t.motor_vehicle ?? t.vehicle ?? t.access;
  if (explicit) {
    if (VAN_OK.test(explicit)) return ROAD_HIGHWAYS.has(t.highway) || t.highway === 'pedestrian';
    if (explicit.split(';').every((v) => VAN_NO.has(v))) return false;
  }
  return ROAD_HIGHWAYS.has(t.highway);
}

function walkAllowed(t: Record<string, string>): boolean {
  if (!WALK_HIGHWAYS.has(t.highway)) return false;
  if (t.foot === 'no' || t.foot === 'use_sidepath') return false;
  if ((t.access === 'private' || t.access === 'no') && !['yes', 'designated', 'permissive'].includes(t.foot ?? '')) return false;
  if (ROAD_HIGHWAYS.has(t.highway) && t.highway !== 'service' && t.sidewalk === 'no') return t.highway === 'residential' || t.highway === 'living_street';
  return true;
}

const POOR = new Set(['bad', 'very_bad', 'horrible', 'very_horrible', 'impassable']);

function surfaceOf(t: Record<string, string>): Surface {
  const s = t.surface ?? '';
  if (COBBLE.has(s)) return 'cobble';
  if (ROUGH.has(s) || POOR.has(t.smoothness ?? '')) return 'rough';   // badly maintained paving counts as rough
  return 'smooth';
}

function slopeOf(t: Record<string, string>): number {
  const m = t.incline?.match(/^-?(\d+(?:\.\d+)?)\s*%$/);
  return m ? +m[1] / 100 : 0;   // TODO(A): replace with DGM1 slope per edge
}

function widthOf(t: Record<string, string>): number {
  const w = parseFloat(t.width ?? t['est_width'] ?? '');
  return Number.isFinite(w) && w > 0 ? w : DEFAULT_WIDTH[t.highway] ?? 2;
}

export function buildOsmWorld(): World {
  const osm: { elements: OsmElement[] } = JSON.parse(readFileSync(OSM_PATH, 'utf8'));
  const tagged = new Map<number, Record<string, string>>();
  for (const e of osm.elements) if (e.type === 'node' && e.tags) tagged.set(e.id, e.tags);

  const nodes: GraphNode[] = [];
  const index = new Map<number, number>();
  const nodeIndex = (id: number, lat: number, lon: number) => {
    let i = index.get(id);
    if (i === undefined) {
      i = nodes.length;
      index.set(id, i);
      const n: GraphNode = { lng: lon, lat };
      const t = tagged.get(id);
      if (t?.barrier === 'bollard') n.barrier = t.bollard === 'removable' || t.bollard === 'foldable' ? 'removable_bollard' : 'bollard';
      else if (t && ['gate', 'lift_gate', 'swing_gate', 'chain'].includes(t.barrier)) n.barrier = 'gate';
      if (t?.highway === 'elevator') n.elevator = true;
      if (t && (['yes', 'designated'].includes(t.loading ?? '') || t.amenity === 'loading_dock' ||
        t.parking === 'loading' || t.parking_space === 'loading')) n.loadingPoint = true;
      nodes.push(n);
    }
    return i;
  };

  const edges: GraphEdge[] = [];
  let virtualId = -1;
  for (const w of osm.elements) {
    const t = w.tags;
    if (w.type !== 'way' || !t?.highway || !w.nodes || !w.geometry || w.geometry.length !== w.nodes.length) continue;
    const walk = walkAllowed(t);
    const vehicle = vanAllowed(t);
    if (!walk && !vehicle) continue;
    const reversed = t.oneway === '-1';
    const oneway = t.oneway === 'yes' || t.oneway === '1' || t.oneway === '-1' || t.junction === 'roundabout';
    const base = {
      slope: slopeOf(t), steps: t.highway === 'steps', surface: surfaceOf(t),
      sheltered: t.covered === 'yes' || t.tunnel === 'yes' || t.tunnel === 'building_passage' || t.indoor === 'yes' || t.highway === 'corridor',
      walk, vehicle, oneway, widthM: widthOf(t), name: t.name,
    };
    const ids = w.nodes.map((id, k) => nodeIndex(id, w.geometry![k].lat, w.geometry![k].lon));
    for (let k = 0; k + 1 < ids.length; k++) {
      const [a, b] = reversed ? [ids[k + 1], ids[k]] : [ids[k], ids[k + 1]];
      if (a === b) continue;
      edges.push({ a, b, lengthM: haversineM(nodes[a].lng, nodes[a].lat, nodes[b].lng, nodes[b].lat), ...base });
    }
    // Area crossings must remain in the polygon, including on concave squares.
    const closed = w.nodes[0] === w.nodes[w.nodes.length - 1];
    if (closed && (t.area === 'yes' || t.highway === 'pedestrian') && walk) {
      const ring = ids.slice(0, -1);
      if (ring.length < 3) continue;
      const lng = ring.reduce((s, i) => s + nodes[i].lng, 0) / ring.length;
      const lat = ring.reduce((s, i) => s + nodes[i].lat, 0) / ring.length;
      const proj = new LocalProjection(lng, lat);
      const poly = ring.map((i) => proj.toXY(nodes[i].lng, nodes[i].lat));
      // If the arithmetic centre is outside, try local triangle centres until one is inside.
      const centres = [centroid(poly), ...poly.map((p, k) => centroid([
        poly[(k + poly.length - 1) % poly.length], p, poly[(k + 1) % poly.length],
      ]))];
      const centre = centres.find(([x, y]) => distanceToPolygon(x, y, poly) < 1e-7);
      if (!centre) continue; // The perimeter still permits safe travel on a degenerate area.
      const [cLng, cLat] = proj.toLngLat(...centre);
      let c = -1;
      for (let k = 0; k < ring.length; k++) {
        if (!segmentWithinPolygon(poly[k], centre, poly)) continue;
        if (c < 0) c = nodeIndex(virtualId--, cLat, cLng);
        const i = ring[k];
        edges.push({ a: i, b: c, lengthM: haversineM(nodes[i].lng, nodes[i].lat, cLng, cLat), ...base, vehicle: false, oneway: false, widthM: 6 });
      }
    }
  }

  // POIs
  const pt = (e: OsmElement): LngLat | null => {
    if (e.lat !== undefined && e.lon !== undefined) return [e.lon, e.lat];
    if (e.bounds) return [(e.bounds.minlon + e.bounds.maxlon) / 2, (e.bounds.minlat + e.bounds.maxlat) / 2];
    return null;
  };
  const pois: World['pois'] = { subwayEntrances: [], elevators: [], stops: [], shops: [], attractions: [], vanEntries: [] };
  for (const e of osm.elements) {
    const t = e.tags;
    const p = t && pt(e);
    if (!t || !p) continue;
    if (t.railway === 'subway_entrance') pois.subwayEntrances.push({ lng: p[0], lat: p[1], station: '' });
    if (t.highway === 'elevator') pois.elevators.push(p);
    if (e.type === 'node' && t.railway === 'tram_stop') pois.stops.push({ lng: p[0], lat: p[1], name: t.name ?? '', mode: 'tram' });
    if (e.type === 'node' && t.highway === 'bus_stop') pois.stops.push({ lng: p[0], lat: p[1], name: t.name ?? '', mode: 'bus' });
    if (e.type === 'node' && t.railway === 'station' && t.train === 'yes') pois.stops.push({ lng: p[0], lat: p[1], name: t.name ?? '', mode: 'sbahn' });
    if (e.type === 'node' && t.name === 'Zentraler Busbahnhof') pois.stops.push({ lng: p[0], lat: p[1], name: t.name, mode: 'bus' });
    if (t.shop) pois.shops.push(p);
    if (['attraction', 'museum', 'gallery', 'viewpoint', 'hotel', 'hostel', 'guest_house'].includes(t.tourism ?? '')) pois.attractions.push(p);
  }
  pois.vanEntries = vanEntries(nodes, edges);

  const hauptmarkt = osm.elements.find((e) => e.type === 'way' && e.id === 136698909);
  const christmasMarket: LngLat[] = hauptmarkt?.geometry?.map((g) => [g.lon, g.lat]) ?? [];

  // OSM names entrances after the street they open onto, so match them to the nearest GTFS station instead.
  const stations = loadStations();
  const subway = stations.filter((s) => s.mode === 'subway');
  pois.subwayEntrances = pois.subwayEntrances.flatMap((en) => {
    let best: StationArrivals | null = null, bestD = 300;
    for (const s of subway) {
      const d = haversineM(en.lng, en.lat, s.lng, s.lat);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best ? [{ ...en, station: best.name }] : [];
  });

  return { graph: { nodes, edges }, pois, population: loadZensus(), stations, christmasMarket,
    loadingPoints: BENCHMARK_LOADING_POINTS, roadConditions: loadRoadConditions() };
}

/** Vans enter where major roads cross the study-area boundary; one entry per 300 m cluster. */
function vanEntries(nodes: GraphNode[], edges: GraphEdge[]): LngLat[] {
  const major = new Set<number>();
  for (const e of edges) if (e.vehicle && e.widthM >= 2.5) { major.add(e.a); major.add(e.b); }
  const margin = 0.0012;
  const out: LngLat[] = [];
  for (const i of major) {
    const n = nodes[i];
    const nearEdge = n.lat - BBOX.minLat < margin || BBOX.maxLat - n.lat < margin * 0.7 ||
                     n.lng - BBOX.minLng < margin * 1.5 || BBOX.maxLng - n.lng < margin * 1.5;
    if (!nearEdge) continue;
    if (out.some(([lng, lat]) => haversineM(lng, lat, n.lng, n.lat) < 300)) continue;
    out.push([n.lng, n.lat]);
  }
  return out;
}

export const normalizeStation = (name: string) => name.replace(/^Nürnberg\s+/, '').replace(/\s*\(.*\)$/, '').trim();

/** Current roadworks researched from city and news sources (see the file's sources), if present. */
function loadRoadConditions(): RoadCondition[] {
  if (!existsSync(ROAD_CONDITIONS_PATH)) return [];
  return (JSON.parse(readFileSync(ROAD_CONDITIONS_PATH, 'utf8')) as { items: RoadCondition[] }).items;
}

function loadStations(): StationArrivals[] {
  try {
    return JSON.parse(readFileSync(STATIONS_PATH, 'utf8'));
  } catch {
    throw new Error(`Missing ${STATIONS_PATH}. Run "npm run sim:dev-data" once to extract U-Bahn arrivals from the GTFS feed.`);
  }
}

// ── Zensus 2022 100 m grid (EPSG:3035) ─────────────────────────────────────────

function readCsv(name: string): Map<string, string[]> {
  const rows = readFileSync(resolve(ZENSUS_DIR, name), 'utf8').split(/\r?\n/).slice(1);
  const out = new Map<string, string[]>();
  for (const r of rows) {
    if (!r) continue;
    const cols = r.split(',');
    out.set(cols[0], cols);
  }
  return out;
}

function loadZensus(): PopulationCell[] {
  const pop = readCsv('nuernberg_population_100m.csv');
  const share = readCsv('nuernberg_share_65plus_100m.csv');
  const cells: PopulationCell[] = [];
  const pad = 0.01;
  for (const [id, cols] of pop) {
    const n = Number(cols[3]);
    if (!Number.isFinite(n) || n <= 0) continue;
    const [lng, lat] = laeaToWgs84(Number(cols[1]), Number(cols[2]));
    if (lat < BBOX.minLat - pad || lat > BBOX.maxLat + pad || lng < BBOX.minLng - pad || lng > BBOX.maxLng + pad) continue;
    const s = Number(share.get(id)?.[3]);
    cells.push({ lng, lat, pop: n, share65: Number.isFinite(s) && share.get(id)?.[3] !== '' ? s / 100 : 0.2 });
  }
  return cells;
}

/** Inverse Lambert Azimuthal Equal Area (EPSG:3035, GRS80), per IOGP guidance note 7-2. */
export function laeaToWgs84(E: number, N: number): LngLat {
  const a = 6378137, e2 = 0.00669438002290, e = Math.sqrt(e2);
  const lat0 = (52 * Math.PI) / 180, lon0 = (10 * Math.PI) / 180;
  const q = (phi: number) => {
    const s = Math.sin(phi);
    return (1 - e2) * (s / (1 - e2 * s * s) - (1 / (2 * e)) * Math.log((1 - e * s) / (1 + e * s)));
  };
  const qP = q(Math.PI / 2), q0 = q(lat0);
  const beta0 = Math.asin(q0 / qP);
  const Rq = a * Math.sqrt(qP / 2);
  const D = (a * (Math.cos(lat0) / Math.sqrt(1 - e2 * Math.sin(lat0) ** 2))) / (Rq * Math.cos(beta0));
  const X = E - 4321000, Y = N - 3210000;
  const rho = Math.hypot(X / D, D * Y);
  const C = 2 * Math.asin(rho / (2 * Rq));
  const betaP = Math.asin(Math.cos(C) * Math.sin(beta0) + (D * Y * Math.sin(C) * Math.cos(beta0)) / rho);
  const lon = lon0 + Math.atan2(X * Math.sin(C), D * rho * Math.cos(beta0) * Math.cos(C) - D * D * Y * Math.sin(beta0) * Math.sin(C));
  const lat = betaP + (e2 / 3 + (31 * e2 ** 2) / 180 + (517 * e2 ** 3) / 5040) * Math.sin(2 * betaP)
    + ((23 * e2 ** 2) / 360 + (251 * e2 ** 3) / 3780) * Math.sin(4 * betaP)
    + ((761 * e2 ** 3) / 45360) * Math.sin(6 * betaP);
  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI];
}

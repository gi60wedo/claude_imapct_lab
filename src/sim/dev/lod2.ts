// Dev-only: building footprints and heights from the LDBV LoD2 CityGML tiles in datasets/lod2/, for the viewer's 3D layer.
// Cached in sim-viz/.cache/buildings.json (gitignored); the cache is rebuilt when a .gml file is newer.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BBOX, REPO } from './osmWorld';

const LOD2_DIR = resolve(REPO, 'datasets/lod2');
const CACHE = resolve(REPO, 'sim-viz/.cache/buildings.json');
const PAD = 0.002;

/** A building's ground footprint. `ring` is [lng, lat] rounded to 6 decimals, open (first point not repeated). */
export interface Building { ring: [number, number][]; h: number; fn: string; addr?: string; areaM2: number }

/** Inverse transverse Mercator (Krüger series, Karney 2011) for EPSG:25832, UTM 32N on GRS80. E 500000 N 5000000 → 9°, 45.1535°. */
export function utm32ToWgs84(E: number, N: number): [number, number] {
  const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996, lon0 = 9;
  const n = f / (2 - f);
  const A = (a / (1 + n)) * (1 + n ** 2 / 4 + n ** 4 / 64);
  const beta = [
    n / 2 - (2 / 3) * n ** 2 + (37 / 96) * n ** 3,
    (1 / 48) * n ** 2 + (1 / 15) * n ** 3,
    (17 / 480) * n ** 3,
  ];
  const xi = N / (k0 * A);
  const eta = (E - 500000) / (k0 * A);
  let xiP = xi, etaP = eta;
  for (let j = 1; j <= 3; j++) {
    xiP -= beta[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etaP -= beta[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xiP) / Math.cosh(etaP));
  const delta = [
    2 * n - (2 / 3) * n ** 2 - 2 * n ** 3,
    (7 / 3) * n ** 2 - (8 / 5) * n ** 3,
    (56 / 15) * n ** 3,
  ];
  let lat = chi;
  for (let j = 1; j <= 3; j++) lat += delta[j - 1] * Math.sin(2 * j * chi);
  const lon = lon0 * Math.PI / 180 + Math.atan2(Math.sinh(etaP), Math.cos(xiP));
  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI];
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

function shoelace(xy: number[]): number {
  let s = 0;
  for (let i = 0, n = xy.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    s += xy[2 * i] * xy[2 * j + 1] - xy[2 * j] * xy[2 * i + 1];
  }
  return Math.abs(s / 2);
}

function parseFile(path: string, out: Building[]) {
  const s = readFileSync(path, 'utf8');
  let i = 0;
  for (;;) {
    const start = s.indexOf('<bldg:Building ', i);
    if (start < 0) break;
    const end = s.indexOf('</bldg:Building>', start);
    i = end + 16;
    const block = s.slice(start, end);
    const g0 = block.indexOf('<bldg:GroundSurface');
    if (g0 < 0) continue;
    const ground = block.slice(g0, block.indexOf('</bldg:GroundSurface>', g0));
    // Largest polygon of the ground surface, in UTM metres (z dropped)
    let best: number[] = [], bestArea = 0;
    for (const m of ground.matchAll(/<gml:posList[^>]*>([^<]+)<\/gml:posList>/g)) {
      const v = m[1].trim().split(/\s+/).map(Number);
      const xy: number[] = [];
      for (let k = 0; k + 2 < v.length; k += 3) xy.push(v[k], v[k + 1]);
      if (xy.length >= 4 && xy[0] === xy[xy.length - 2] && xy[1] === xy[xy.length - 1]) xy.length -= 2;
      const area = shoelace(xy);
      if (area > bestArea) { bestArea = area; best = xy; }
    }
    if (best.length < 6) continue;
    const ring: [number, number][] = [];
    let cLng = 0, cLat = 0;
    for (let k = 0; k < best.length; k += 2) {
      const [lng, lat] = utm32ToWgs84(best[k], best[k + 1]);
      ring.push([r6(lng), r6(lat)]);
      cLng += lng; cLat += lat;
    }
    cLng /= ring.length; cLat /= ring.length;
    if (cLat < BBOX.minLat - PAD || cLat > BBOX.maxLat + PAD || cLng < BBOX.minLng - PAD || cLng > BBOX.maxLng + PAD) continue;
    const h = Number(block.match(/<bldg:measuredHeight[^>]*>([^<]+)</)?.[1] ?? 0);
    const fn = block.match(/<bldg:function>([^<]+)</)?.[1] ?? '';
    const addr = [...block.matchAll(/<xAL:ThoroughfareName>([^<]+)</g)].map((m) => m[1].trim()).join(' / ') || undefined;
    out.push({ ring, h: Math.round(h * 10) / 10, fn, ...(addr ? { addr } : {}), areaM2: Math.round(bestArea) });
  }
}

export function loadBuildings(): Building[] {
  const files = readdirSync(LOD2_DIR).filter((f) => f.endsWith('.gml')).map((f) => resolve(LOD2_DIR, f));
  const newest = Math.max(...files.map((f) => statSync(f).mtimeMs));
  if (existsSync(CACHE) && statSync(CACHE).mtimeMs > newest) return JSON.parse(readFileSync(CACHE, 'utf8'));
  const out: Building[] = [];
  for (const f of files) parseFile(f, out);
  mkdirSync(resolve(CACHE, '..'), { recursive: true });
  const json = JSON.stringify(out);
  writeFileSync(CACHE, json);
  console.log(`LoD2: ${out.length} buildings → ${CACHE} (${(json.length / 1e6).toFixed(1)} MB)`);
  return out;
}

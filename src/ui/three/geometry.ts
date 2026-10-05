import { BufferGeometry, ExtrudeGeometry, Path, Shape } from 'three';

export type LngLat = readonly [number, number];
export type Bounds = readonly [number, number, number, number];
export interface LocalFrame {
  origin: LngLat;
  eastPerDegree: number;
  northPerDegree: number;
}

/** WGS84 tangent-plane scales at the origin; coordinates are metres east/north. */
export function createLocalFrame(origin: LngLat): LocalFrame {
  const radians = Math.PI / 180;
  const latitude = origin[1] * radians;
  const eccentricitySquared = 6.69437999014e-3;
  const denominator = 1 - eccentricitySquared * Math.sin(latitude) ** 2;
  return {
    origin,
    eastPerDegree: radians * 6378137 * Math.cos(latitude) / Math.sqrt(denominator),
    northPerDegree: radians * 6378137 * (1 - eccentricitySquared) / denominator ** 1.5,
  };
}

export function project([lng, lat]: LngLat, frame: LocalFrame): [number, number] {
  return [(lng - frame.origin[0]) * frame.eastPerDegree, (lat - frame.origin[1]) * frame.northPerDegree];
}

export function unproject([east, north]: LngLat, frame: LocalFrame): [number, number] {
  return [frame.origin[0] + east / frame.eastPerDegree, frame.origin[1] + north / frame.northPerDegree];
}

export interface ElevationDecoder { rScaler: number; gScaler: number; bScaler: number; offset: number }
export const TERRARIUM: ElevationDecoder = { rScaler: 256, gScaler: 1, bScaler: 1 / 256, offset: -32768 };

/** The shipped PNG already encodes elevation minus baseElevation. Do not subtract twice. */
export function decodeTerrarium(r: number, g: number, b: number, decoder = TERRARIUM): number {
  return r * decoder.rScaler + g * decoder.gScaler + b * decoder.bScaler + decoder.offset;
}

export interface ElevationRaster {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  bounds: Bounds;
  decoder: ElevationDecoder;
}

/** Loader-vertex pixels use i/width and j/height, with the last border duplicated. */
export function sampleElevation(lng: number, lat: number, raster: ElevationRaster): number {
  const [west, south, east, north] = raster.bounds;
  const x = Math.max(0, Math.min(raster.width - 1, (lng - west) / (east - west) * raster.width));
  const y = Math.max(0, Math.min(raster.height - 1, (north - lat) / (north - south) * raster.height));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, raster.width - 1), y1 = Math.min(y0 + 1, raster.height - 1);
  const at = (col: number, row: number) => {
    const i = (row * raster.width + col) * 4;
    return decodeTerrarium(raster.pixels[i], raster.pixels[i + 1], raster.pixels[i + 2], raster.decoder);
  };
  const fx = x - x0, fy = y - y0;
  return (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy)
    + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
}

export function openRing<T extends LngLat>(ring: readonly T[]): T[] {
  const first = ring[0], last = ring[ring.length - 1];
  return first && last && first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : [...ring];
}

export function footprintShape(rings: readonly (readonly LngLat[])[], frame: LocalFrame): Shape {
  const shape = new Shape();
  rings.forEach((ring, index) => {
    const path = index === 0 ? shape : new Path();
    openRing(ring).forEach((point, i) => {
      const [east, north] = project(point, frame);
      if (i === 0) path.moveTo(east, north); else path.lineTo(east, north);
    });
    path.closePath();
    if (index !== 0) shape.holes.push(path);
  });
  return shape;
}

/**
 * Prism from zBase to zBase + h in world axes: x east, y up, z = −north. The shape is extruded
 * along +z and then rotated, so (east, north, depth) becomes (east, depth, −north).
 */
export function extrudeFootprint(rings: readonly (readonly LngLat[])[], zBase: number, h: number,
  frame: LocalFrame): BufferGeometry | null {
  if (!rings.length || openRing(rings[0]).length < 3 || !(h > 0) || !Number.isFinite(zBase)) return null;
  const geometry = new ExtrudeGeometry(footprintShape(rings, frame), { depth: h, bevelEnabled: false });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, zBase, 0);
  geometry.deleteAttribute('uv');
  const positions = geometry.getAttribute('position');
  if (!positions || positions.count === 0 || !Array.from(positions.array as ArrayLike<number>).every(Number.isFinite)) {
    geometry.dispose();
    return null;
  }
  return geometry;
}

/** Local-frame world position (x east, z −north) for a lng/lat. */
export function toWorld(point: LngLat, frame: LocalFrame, y = 0): [number, number, number] {
  const [east, north] = project(point, frame);
  return [east, y, -north];
}

/** Cyan → amber → red ramp for a normalised 0–1 intensity. */
export function heatColor(t: number): [number, number, number] {
  const cyan = [0.13, 0.83, 0.93], amber = [0.98, 0.75, 0.14], red = [0.94, 0.27, 0.27];
  const v = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  const [a, b, f] = v < 0.5 ? [cyan, amber, v / 0.5] : [amber, red, (v - 0.5) / 0.5];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export function ringCenter(ring: readonly LngLat[]): [number, number] {
  const points = openRing(ring);
  if (!points.length) throw new Error('A footprint must have vertices');
  return [points.reduce((sum, p) => sum + p[0], 0) / points.length,
    points.reduce((sum, p) => sum + p[1], 0) / points.length];
}

export function pointInRing(x: number, y: number, ring: readonly LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Illustrative positions only: the contract supplies exposure slots, but no stall coordinates. */
export function stallGrid(ring: readonly LngLat[], count: number): [number, number][] {
  if (count <= 0 || ring.length < 3) return [];
  const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
  const west = Math.min(...xs), east = Math.max(...xs), south = Math.min(...ys), north = Math.max(...ys);
  if (east <= west || north <= south) return [];
  let cells: [number, number][] = [];
  let spacing = Math.sqrt((east - west) * (north - south) / count);
  for (let attempt = 0; attempt < 10; attempt++) {
    cells = [];
    for (let y = south + spacing / 2; y < north; y += spacing) {
      for (let x = west + spacing / 2; x < east; x += spacing) {
        if (pointInRing(x, y, ring)) cells.push([x, y]);
      }
    }
    if (cells.length >= count) return Array.from({ length: count }, (_, i) => cells[Math.floor(i * cells.length / count)]);
    spacing *= 0.7;
  }
  return cells.slice(0, count);
}

export interface TripPoint { x: number; y: number; z: number; time: number }

/** Absolute timestamps are preserved. Trips disappear outside their recorded interval. */
export function sampleTrip(path: readonly TripPoint[], time: number): TripPoint | null {
  if (!path.length || time < path[0].time || time > path[path.length - 1].time) return null;
  let low = 0, high = path.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (path[mid].time < time) low = mid + 1; else high = mid;
  }
  const b = path[low], a = path[Math.max(0, low - 1)];
  const alpha = b.time === a.time ? 0 : (time - a.time) / (b.time - a.time);
  return { x: a.x + (b.x - a.x) * alpha, y: a.y + (b.y - a.y) * alpha,
    z: a.z + (b.z - a.z) * alpha, time };
}

/**
 * Unit (east, north) axis of steepest terrain rise across a point, sampled `step` metres to each
 * side. A side elevation looks perpendicular to it, so the slope shows in profile. The axis always
 * points east-ish, so the viewer faces north-ish; flat ground falls back to due east.
 */
export function slopeAxis(point: LngLat, raster: ElevationRaster, frame: LocalFrame, step = 40): [number, number] {
  const [lng, lat] = point;
  const dLng = step / frame.eastPerDegree, dLat = step / frame.northPerDegree;
  const east = sampleElevation(lng + dLng, lat, raster) - sampleElevation(lng - dLng, lat, raster);
  const north = sampleElevation(lng, lat + dLat, raster) - sampleElevation(lng, lat - dLat, raster);
  const length = Math.hypot(east, north);
  if (!(length > 1e-3)) return [1, 0];
  const sign = east < 0 || (east === 0 && north < 0) ? -1 : 1;
  return [(sign * east) / length, (sign * north) / length];
}

/** Viewing direction (east, north) for a viewer whose screen-right runs along `axis`. */
export function facing([east, north]: readonly [number, number]): [number, number] {
  return [-north, east];
}

import type { LngLat } from './world';

const R = 6371008.8;
const RAD = Math.PI / 180;

export function haversineM(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const dLat = (lat2 - lat1) * RAD;
  const dLng = (lng2 - lng1) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Equirectangular projection to metres around a reference latitude; accurate to <0.1 % across the Altstadt. */
export class LocalProjection {
  readonly kx: number;
  readonly ky = R * RAD;
  constructor(readonly lng0: number, readonly lat0: number) {
    this.kx = R * RAD * Math.cos(lat0 * RAD);
  }
  toXY(lng: number, lat: number): [number, number] {
    return [(lng - this.lng0) * this.kx, (lat - this.lat0) * this.ky];
  }
  toLngLat(x: number, y: number): LngLat {
    return [this.lng0 + x / this.kx, this.lat0 + y / this.ky];
  }
}

export function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Distance from a point to a polygon in metres; 0 inside. Polygon in local XY. */
export function distanceToPolygon(x: number, y: number, poly: [number, number][]): number {
  if (pointInPolygon(x, y, poly)) return 0;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    best = Math.min(best, segmentDistance(x, y, poly[j][0], poly[j][1], poly[i][0], poly[i][1]));
  }
  return best;
}

/** Check every interval between boundary intersections; midpoint alone misses concave excursions. */
export function segmentWithinPolygon(a: LngLat, b: LngLat, poly: LngLat[]): boolean {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const eps = 1e-7; // Polygon coordinates are local metres.
  if (distanceToPolygon(...a, poly) > eps || distanceToPolygon(...b, poly) > eps) return false;
  if (len2 < eps * eps) return true;
  const cuts = [0, 1];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const ex = q[0] - p[0], ey = q[1] - p[1];
    const px = p[0] - a[0], py = p[1] - a[1];
    const cross = dx * ey - dy * ex;
    if (Math.abs(cross) > eps) {
      const t = (px * ey - py * ex) / cross;
      const u = (px * dy - py * dx) / cross;
      if (t > 0 && t < 1 && u >= -eps && u <= 1 + eps) cuts.push(t);
    } else if (Math.abs(px * dy - py * dx) <= eps) {
      // Collinear boundary segments contribute their endpoints too.
      for (const v of [p, q]) {
        const t = ((v[0] - a[0]) * dx + (v[1] - a[1]) * dy) / len2;
        if (t > 0 && t < 1) cuts.push(t);
      }
    }
  }
  cuts.sort((x, y) => x - y);
  return cuts.slice(1).every((t, k) => {
    const mid = (cuts[k] + t) / 2;
    return distanceToPolygon(a[0] + mid * dx, a[1] + mid * dy, poly) <= eps;
  });
}

export function polygonArea(poly: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  return Math.abs(a / 2);
}

export function centroid(poly: [number, number][]): [number, number] {
  let x = 0;
  let y = 0;
  for (const p of poly) { x += p[0]; y += p[1]; }
  return [x / poly.length, y / poly.length];
}

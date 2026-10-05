import { describe, expect, it } from 'vitest';
import terrain from '../../../public/data/terrain/terrain.json';
import { cameraPreset } from './camera';
import {
  createLocalFrame, decodeTerrarium, extrudeFootprint, footprintShape, heatColor, openRing, project,
  sampleElevation, sampleTrip, stallGrid, TERRARIUM, toWorld, unproject, type ElevationRaster, type LngLat,
} from './geometry';

const ORIGIN: LngLat = [11.0786, 49.4526];
const frame = createLocalFrame(ORIGIN);

/** Inverse Terrarium encode, used only to build synthetic rasters. */
function encode(metres: number): [number, number, number] {
  const v = metres + 32768;
  const r = Math.floor(v / 256), g = Math.floor(v - r * 256), b = Math.round((v - r * 256 - g) * 256);
  return [r, g, b];
}

describe('local tangent-plane projection', () => {
  it('maps the origin to (0, 0)', () => {
    expect(project(ORIGIN, frame)).toEqual([0, 0]);
  });

  it('uses WGS84 metre scales at Nuremberg latitude', () => {
    // At ~49.45° N one degree is ~72.5 km east and ~111.2 km north.
    expect(frame.eastPerDegree).toBeGreaterThan(72_400);
    expect(frame.eastPerDegree).toBeLessThan(72_600);
    expect(frame.northPerDegree).toBeGreaterThan(111_150);
    expect(frame.northPerDegree).toBeLessThan(111_250);
  });

  it('puts east at +x and north at +y, with unproject as the exact inverse', () => {
    const point: LngLat = [11.0774, 49.4539];
    const [east, north] = project(point, frame);
    expect(east).toBeLessThan(0);
    expect(north).toBeGreaterThan(0);
    const [lng, lat] = unproject([east, north], frame);
    expect(lng).toBeCloseTo(point[0], 10);
    expect(lat).toBeCloseTo(point[1], 10);
  });

  it('matches the terrain source extent in metres (2.1 km UTM tile)', () => {
    const [w, s, e, n] = terrain.bounds;
    const local = createLocalFrame([(w + e) / 2, (s + n) / 2]);
    const [x0, y0] = project([w, s], local), [x1, y1] = project([e, n], local);
    // The lng/lat bounds envelope a UTM 32N square rotated by the grid convergence
    // γ ≈ (λ − 9°)·sin φ, so each side grows to w·cos γ + h·sin γ.
    const gamma = ((w + e) / 2 - 9) * Math.PI / 180 * Math.sin((s + n) / 2 * Math.PI / 180);
    const sourceWidth = terrain.sourceBounds[2] - terrain.sourceBounds[0];
    const sourceHeight = terrain.sourceBounds[3] - terrain.sourceBounds[1];
    const envelopeWidth = sourceWidth * Math.cos(gamma) + sourceHeight * Math.sin(gamma);
    const envelopeHeight = sourceHeight * Math.cos(gamma) + sourceWidth * Math.sin(gamma);
    expect(Math.abs(x1 - x0 - envelopeWidth) / envelopeWidth).toBeLessThan(0.002);
    expect(Math.abs(y1 - y0 - envelopeHeight) / envelopeHeight).toBeLessThan(0.002);
  });

  it('maps north to −z in world coordinates', () => {
    const [x, y, z] = toWorld([ORIGIN[0], ORIGIN[1] + 0.001], frame, 7);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBe(7);
    expect(z).toBeCloseTo(-111.2, 0);
  });
});

describe('Terrarium decode', () => {
  it('decodes (R*256 + G + B/256) − 32768', () => {
    expect(decodeTerrarium(128, 0, 0)).toBe(0);
    expect(decodeTerrarium(128, 17, 128)).toBe(17.5);
    expect(decodeTerrarium(127, 255, 0)).toBe(-1);
  });

  it('agrees with the decoder shipped in terrain.json', () => {
    const shipped = terrain.elevationDecoder;
    expect(shipped).toEqual(TERRARIUM);
    for (const metres of [0, 5.25, 21.95703125, -3.5]) {
      expect(decodeTerrarium(...encode(metres), shipped)).toBeCloseTo(metres, 2);
    }
  });

  it('samples a raster bilinearly, north row first', () => {
    // 2×2: north row 10 m, 20 m; south row 30 m, 40 m.
    const heights = [10, 20, 30, 40];
    const pixels = new Uint8ClampedArray(heights.flatMap((h) => [...encode(h), 255]));
    const raster: ElevationRaster = { pixels, width: 2, height: 2, bounds: [0, 0, 2, 2], decoder: TERRARIUM };
    expect(sampleElevation(0, 2, raster)).toBeCloseTo(10, 3);      // north-west vertex
    expect(sampleElevation(1, 2, raster)).toBeCloseTo(20, 3);      // north, second column
    expect(sampleElevation(0, 1, raster)).toBeCloseTo(30, 3);      // second row
    expect(sampleElevation(0.5, 1.5, raster)).toBeCloseTo(25, 3);  // centre of the four
    expect(sampleElevation(-5, 9, raster)).toBeCloseTo(10, 3);     // clamped outside bounds
  });
});

describe('footprints', () => {
  const square = (half: number): LngLat[] => {
    const d = half / frame.eastPerDegree, dn = half / frame.northPerDegree;
    return [[ORIGIN[0] - d, ORIGIN[1] - dn], [ORIGIN[0] + d, ORIGIN[1] - dn],
      [ORIGIN[0] + d, ORIGIN[1] + dn], [ORIGIN[0] - d, ORIGIN[1] + dn], [ORIGIN[0] - d, ORIGIN[1] - dn]];
  };

  it('drops the closing vertex of a closed ring', () => {
    expect(openRing(square(5))).toHaveLength(4);
  });

  it('keeps courtyard holes', () => {
    const shape = footprintShape([square(10), [...square(4)].reverse()], frame);
    expect(shape.holes).toHaveLength(1);
  });

  it('extrudes from zBase to zBase + h with north at −z', () => {
    const geometry = extrudeFootprint([square(10)], 17.5, 12, frame)!;
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    expect(box.min.y).toBeCloseTo(17.5, 4);
    expect(box.max.y).toBeCloseTo(29.5, 4);
    expect(box.min.x).toBeCloseTo(-10, 3);
    expect(box.max.z).toBeCloseTo(10, 3);
    expect(geometry.getAttribute('uv')).toBeUndefined();
  });

  it('rejects degenerate footprints', () => {
    expect(extrudeFootprint([square(10).slice(0, 2)], 0, 10, frame)).toBeNull();
    expect(extrudeFootprint([square(10)], 0, 0, frame)).toBeNull();
  });

  it('places exactly one stall per exposure slot inside the site', () => {
    const ring: [number, number][] = [[0, 0], [40, 0], [40, 20], [0, 20]];
    const cells = stallGrid(ring, 20);
    expect(cells).toHaveLength(20);
    for (const [x, y] of cells) {
      expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(40);
      expect(y).toBeGreaterThan(0); expect(y).toBeLessThan(20);
    }
    expect(stallGrid(ring, 0)).toEqual([]);
  });
});

describe('trip sampling and ramps', () => {
  const path = [{ x: 0, y: 0, z: 0, time: 10 }, { x: 10, y: 2, z: -4, time: 20 }];

  it('interpolates between timestamps and hides outside the interval', () => {
    expect(sampleTrip(path, 15)).toEqual({ x: 5, y: 1, z: -2, time: 15 });
    expect(sampleTrip(path, 9)).toBeNull();
    expect(sampleTrip(path, 21)).toBeNull();
  });

  it('ramps heat from cyan to red and clamps', () => {
    expect(heatColor(-1)).toEqual(heatColor(0));
    expect(heatColor(2)).toEqual(heatColor(1));
    const [r0, , b0] = heatColor(0), [r1, , b1] = heatColor(1);
    expect(b0).toBeGreaterThan(r0);
    expect(r1).toBeGreaterThan(b1);
  });

  it('frames every camera preset on the focus point', () => {
    for (const mode of ['perspective', 'side', 'top'] as const) {
      const preset = cameraPreset(mode, [100, 5, -50]);
      expect(preset.target[0]).toBe(100);
      expect(preset.target[2]).toBe(-50);
      expect(preset.position[1]).toBeGreaterThan(preset.target[1]);
    }
    const side = cameraPreset('side', [0, 0, 0]), top = cameraPreset('top', [0, 0, 0]);
    expect(side.position[1]).toBeLessThan(cameraPreset('perspective', [0, 0, 0]).position[1]);
    expect(top.position[1]).toBeGreaterThan(1000 * Math.abs(top.position[2]));
  });
});

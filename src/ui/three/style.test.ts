import { describe, expect, it } from 'vitest';
import { samplePacked, trailLength } from './geometry';
import { eaveHeight, parseRoofs } from './roofs';
import { footways, type WalkGraph } from './streets';
import { easeInOutCubic, QUALITY, SUN, sunDirection, SURFACES, surfaceClass } from './style';

describe('camera easing', () => {
  it('eases in and out symmetrically and clamps to [0, 1]', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 9);
    expect(easeInOutCubic(-1)).toBe(0);
    expect(easeInOutCubic(2)).toBe(1);
    expect(easeInOutCubic(0.1)).toBeLessThan(0.1);
    expect(easeInOutCubic(0.9)).toBeGreaterThan(0.9);
    expect(easeInOutCubic(0.25) + easeInOutCubic(0.75)).toBeCloseTo(1, 9);
  });
});

describe('time-of-day light', () => {
  it('points the sun east at dawn, south at midday and south-west in the afternoon', () => {
    const [dawnX, dawnY] = sunDirection(SUN['05:30_DELIVERY']);
    const [, noonY, noonZ] = sunDirection(SUN['11:30_PEAK']);
    const [lullX, , lullZ] = sunDirection(SUN['15:00_LULL']);
    expect(dawnX).toBeGreaterThan(0.8);            // east is +x
    expect(noonZ).toBeGreaterThan(0.5);            // south is +z (north is −z)
    expect(lullX).toBeLessThan(0);
    expect(lullZ).toBeGreaterThan(0);
    expect(noonY).toBeGreaterThan(dawnY);          // midday sun stands highest
    for (const preset of Object.values(SUN)) expect(Math.hypot(...sunDirection(preset))).toBeCloseTo(1, 9);
  });

  it('keeps the fast tier cheaper than the high tier', () => {
    expect(QUALITY.fast.multisampling).toBe(0);
    expect(QUALITY.fast.ambientOcclusion).toBe(false);
    expect(QUALITY.fast.shadowMapSize).toBeLessThan(QUALITY.high.shadowMapSize);
    expect(QUALITY.fast.maxDpr).toBeLessThan(QUALITY.high.maxDpr);
  });
});

describe('street surfaces', () => {
  it('maps engine classes and OSM tags onto overlay classes', () => {
    expect(surfaceClass('cobble')).toBe('cobble');
    expect(surfaceClass('sett')).toBe('cobble');
    expect(surfaceClass('unhewn_cobblestone')).toBe('cobble');
    expect(surfaceClass('paving_stones')).toBe('paving');
    expect(surfaceClass('asphalt')).toBe('asphalt');
    expect(surfaceClass('smooth')).toBe('asphalt');
    expect(surfaceClass('unpaved')).toBe('rough');
    expect(surfaceClass('rough')).toBe('rough');
    expect(surfaceClass(undefined)).toBe('rough');
    expect(new Set(SURFACES.map((s) => s.id)).size).toBe(SURFACES.length);
  });

  it('keeps footway edges inside the terrain bounds, honouring foot and walk flags', () => {
    const graph: WalkGraph = {
      nodes: [{ lng: 1, lat: 1 }, { lng: 2, lat: 2 }, { lng: 9, lat: 9 }],
      edges: [
        { a: 0, b: 1, surface: 'cobble', walk: true },
        { a: 0, b: 1, surface: 'asphalt', walk: false },
        { a: 1, b: 0, surface: 'sett', foot: true },
        { a: 1, b: 2, surface: 'smooth' },
        { a: 0, b: 7 },
      ],
    };
    expect(footways(graph, [0, 0, 3, 3]).map((e) => e.surface)).toEqual(['cobble', 'sett']);
  });
});

describe('roofs3d parsing', () => {
  it('keeps whole finite triangles per building and finds the eave', () => {
    const roofs = parseRoofs({
      buildings: [
        { id: 'a', triangles: [0, 0, 10, 1, 0, 12, 0, 1, 11] },
        { id: 'b', triangles: [0, 0, 10, 1, 0] },
        { id: 'c', triangles: [0, 0, Number.NaN, 1, 0, 1, 0, 1, 1] },
        { triangles: [0, 0, 1, 1, 0, 1, 0, 1, 1] },
      ],
    });
    expect([...roofs.keys()]).toEqual(['a']);
    expect(eaveHeight(roofs.get('a')!)).toBe(10);
    expect(parseRoofs(null).size).toBe(0);
    expect(parseRoofs({ buildings: 'x' }).size).toBe(0);
  });
});

describe('scalable trip sampling', () => {
  const path = new Float32Array([0, 0, 0, 10, 10, 2, -4, 20, 10, 2, -14, 40]);

  it('interpolates in place between path points and hides outside the interval', () => {
    const out = new Float32Array(6);
    expect(samplePacked(path, 15, out, 3)).toBe(true);
    expect([...out.slice(3)]).toEqual([5, 1, -2]);
    expect(samplePacked(path, 30, out, 0)).toBe(true);
    expect(out[2]).toBeCloseTo(-9, 6);
    expect(samplePacked(path, 9, out, 0)).toBe(false);
    expect(samplePacked(path, 41, out, 0)).toBe(false);
    expect(samplePacked(new Float32Array(0), 0, out, 0)).toBe(false);
  });

  it('thins the ghost trail as trip counts grow toward thousands', () => {
    expect(trailLength(130)).toBeGreaterThan(trailLength(2000));
    expect(trailLength(2000) * 2000).toBeLessThanOrEqual(6000);
  });
});

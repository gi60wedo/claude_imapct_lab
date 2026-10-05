import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Candidate } from '../../contracts';
import {
  dominantSurface, siteCentroid, streetStats, surfaceGroup, weightedPercentile, type StreetGraph,
} from './streetStats';

// About 7.2 m per 0.0001° of longitude and 11.1 m per 0.0001° of latitude at Nuremberg.
const LNG0 = 11.077, LAT0 = 49.452;
const node = (dx: number, dy: number) => ({ lng: LNG0 + dx * 1e-4, lat: LAT0 + dy * 1e-4 });

const graph: StreetGraph = {
  nodes: [node(0, 0), node(1, 0), node(2, 0), node(0, 1), node(100, 0), node(101, 0), node(3, 0)],
  edges: [
    { a: 0, b: 1, len: 10, slope: 0.02, surface: 'sett', foot: true },
    { a: 1, b: 2, len: 30, slope: -0.04, surface: 'paving_stones', foot: true, sheltered: true },
    { a: 0, b: 3, len: 60, slope: 0.01, surface: 'asphalt', foot: true, bollard: true },
    // Not walkable: ignored.
    { a: 2, b: 6, len: 50, slope: 0.2, surface: 'asphalt', foot: false },
    // Steps and capped DGM artefacts count for length and surface but not for slope.
    { a: 2, b: 6, len: 5, slope: 0.4, surface: null, foot: true, hw: 'steps', steps: true },
    { a: 1, b: 6, len: 5, slope: 0.25, surface: 'cobblestone', foot: true, slopeSuspect: true },
    { a: 6, b: 2, len: 2, slope: 0, foot: true, hw: 'elevator' },
    // About 720 m east: outside the radius.
    { a: 4, b: 5, len: 7, slope: 0.1, surface: 'asphalt', foot: true },
  ],
};

describe('streetStats', () => {
  it('groups OSM surface tags', () => {
    expect(surfaceGroup('sett')).toBe('cobble');
    expect(surfaceGroup('unhewn_cobblestone')).toBe('cobble');
    expect(surfaceGroup('paving_stones')).toBe('paving');
    expect(surfaceGroup('asphalt')).toBe('asphalt');
    expect(surfaceGroup('compacted')).toBe('other');
    expect(surfaceGroup(null)).toBe('other');
  });

  it('takes the length-weighted percentile', () => {
    const v = [{ v: 3, w: 1 }, { v: 1, w: 8 }, { v: 2, w: 1 }];
    expect(weightedPercentile(v, 0.5)).toBe(1);
    expect(weightedPercentile(v, 0.9)).toBe(2);
    expect(weightedPercentile(v, 1)).toBe(3);
    expect(weightedPercentile([], 0.9)).toBeNull();
  });

  it('drops a repeated closing vertex from the centroid', () => {
    expect(siteCentroid([[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]])).toEqual([1, 1]);
    expect(siteCentroid([])).toBeNull();
  });

  it('aggregates foot edges within the radius', () => {
    const s = streetStats(graph, [LNG0, LAT0], 200);
    expect(s.edges).toBe(6);
    expect(s.lengthM).toBe(112);
    // Mean |slope| over the 102 m of plain edges, elevator included: (10·0.02 + 30·0.04 + 60·0.01 + 2·0) / 102.
    expect(s.meanSlope).toBeCloseTo(2 / 102, 10);
    // Sorted 0 (2 m), 0.01 (60 m), 0.02 (10 m), 0.04 (30 m): 90 % of 102 m is reached in the 0.04 group.
    expect(s.p90Slope).toBe(0.04);
    expect(s.mix.cobble).toBeCloseTo(15 / 112);
    expect(s.mix.paving).toBeCloseTo(30 / 112);
    expect(s.mix.asphalt).toBeCloseTo(60 / 112);
    expect(s.mix.other).toBeCloseTo(7 / 112);
    expect(Object.values(s.mix).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(s.sheltered).toBeCloseTo(30 / 112);
    expect([s.steps, s.elevators, s.bollards]).toEqual([1, 1, 1]);
    expect(dominantSurface(s)).toBe('asphalt');
  });

  it('counts an edge that passes the site even when both ends lie outside the radius', () => {
    const g: StreetGraph = { nodes: [node(-50, 0.5), node(50, 0.5)], edges: [{ a: 0, b: 1, len: 72, slope: 0.03, foot: true }] };
    expect(streetStats(g, [LNG0, LAT0], 20).edges).toBe(1);
    expect(streetStats(g, [LNG0, LAT0], 2).edges).toBe(0);
  });

  it('returns nulls and zero shares with no edges', () => {
    const s = streetStats({ nodes: [], edges: [] }, [LNG0, LAT0]);
    expect(s).toMatchObject({ edges: 0, lengthM: 0, meanSlope: null, p90Slope: null, sheltered: 0 });
    expect(dominantSurface(s)).toBeNull();
  });

  it('gives plausible Altstadt values for the benchmark sites on the real graph', () => {
    const real = JSON.parse(readFileSync(`${process.cwd()}/public/data/graph.json`, 'utf8')) as StreetGraph;
    const candidates = JSON.parse(readFileSync(`${process.cwd()}/public/data/fixtures/candidates.json`, 'utf8')) as Candidate[];
    const benchmarks = candidates.filter((c) => c.kind === 'benchmark');
    expect(benchmarks.length).toBeGreaterThan(0);
    for (const c of benchmarks) {
      const s = streetStats(real, siteCentroid(c.polygon)!);
      expect(s.edges, c.id).toBeGreaterThan(10);
      expect(s.meanSlope!, c.id).toBeGreaterThanOrEqual(0);
      expect(s.meanSlope!, c.id).toBeLessThan(0.25);
      expect(s.p90Slope!, c.id).toBeGreaterThanOrEqual(s.meanSlope!);
      expect(s.p90Slope!, c.id).toBeLessThanOrEqual(0.25);
    }
  });
});

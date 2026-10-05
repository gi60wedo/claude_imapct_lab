import { describe, expect, it } from 'vitest';
import { edgeCost, RAIN_FACTOR, SENIOR_COBBLE } from '../cost';
import { pathFrom, shortestPathsTo } from '../dijkstra';
import { gini } from '../metrics';
import { prepareWorld } from '../prepare';
import { fork, mulberry32 } from '../rng';
import type { GraphEdge } from '../world';
import { gridWorld, id } from './fixtures';

const edge = (over: Partial<GraphEdge> = {}): GraphEdge => ({
  a: 0, b: 1, lengthM: 100, slope: 0, steps: false, surface: 'smooth', sheltered: false, walk: true,
  vehicle: true, oneway: false, widthM: 3, ...over,
});

describe('rng', () => {
  it('reproduces the same sequence for the same seed', () => {
    const a = mulberry32(42), b = mulberry32(42);
    expect(Array.from({ length: 5 }, a)).toEqual(Array.from({ length: 5 }, b));
    expect(mulberry32(1)()).not.toEqual(mulberry32(2)());
  });
  it('forks independent streams by label', () => {
    expect(fork(42, 'x')()).toEqual(fork(42, 'x')());
    expect(fork(42, 'x')()).not.toEqual(fork(42, 'y')());
  });
});

describe('edge cost (§6)', () => {
  const ctx = { rain: false };
  it('blocks seniors on steps but not other walkers', () => {
    expect(edgeCost(edge({ steps: true }), 0, true, 'senior', ctx)).toBe(Infinity);
    expect(edgeCost(edge({ steps: true }), 0, true, 'walker', ctx)).toBe(100);
  });
  it('applies the cobblestone and slope multipliers for seniors', () => {
    expect(edgeCost(edge({ surface: 'cobble' }), 0, true, 'senior', ctx)).toBeCloseTo(100 * SENIOR_COBBLE);
    expect(edgeCost(edge({ surface: 'cobble' }), 0, true, 'walker', ctx)).toBeCloseTo(110);
    expect(edgeCost(edge({ slope: 0.1 }), 0, true, 'senior', ctx)).toBeCloseTo(100 * (1 + 8 * 0.04));
    expect(edgeCost(edge({ slope: 0.1 }), 0, true, 'walker', ctx)).toBe(100);
  });
  it('adds the rain factor only on unsheltered edges', () => {
    expect(edgeCost(edge(), 0, true, 'walker', { rain: true })).toBeCloseTo(100 * RAIN_FACTOR);
    expect(edgeCost(edge({ sheltered: true }), 0, true, 'walker', { rain: true })).toBe(100);
  });
  it('lets vans use only vehicle edges in the legal direction', () => {
    expect(edgeCost(edge({ vehicle: false }), 0, true, 'van', ctx)).toBe(Infinity);
    expect(edgeCost(edge({ oneway: true }), 0, false, 'van', ctx)).toBe(Infinity);
    expect(edgeCost(edge({ oneway: true }), 0, true, 'van', ctx)).toBe(100);
  });
});

describe('dijkstra on the grid', () => {
  const pw = prepareWorld(gridWorld());

  it('finds the Manhattan distance for walkers', () => {
    const sp = shortestPathsTo(pw.g, [id(11, 11)], 'walker', { rain: false });
    // Columns 3–4 are cobbled (×1.1), so the optimum avoids them where it can; 22 blocks of 25 m at least.
    expect(sp.dist[id(0, 0)]).toBeGreaterThanOrEqual(22 * 25);
    const p = pathFrom(sp, id(0, 0));
    expect(p.nodes[0]).toBe(id(0, 0));
    expect(p.nodes[p.nodes.length - 1]).toBe(id(11, 11));
  });

  it('routes seniors around the steps', () => {
    const walker = shortestPathsTo(pw.g, [id(5, 9)], 'walker', { rain: false });
    const senior = shortestPathsTo(pw.g, [id(5, 9)], 'senior', { rain: false });
    expect(walker.dist[id(5, 8)]).toBe(25);
    expect(senior.dist[id(5, 8)]).toBeGreaterThan(25);
    expect(pathFrom(senior, id(5, 8)).edges.some((k) => pw.world.graph.edges[k].steps)).toBe(false);
  });

  it('stops vans at a removable bollard unless the delivery window lowers it', () => {
    const target = [id(9, 6)];
    const closed = shortestPathsTo(pw.g, target, 'van', { rain: false });
    const open = shortestPathsTo(pw.g, target, 'van', { rain: false, unlockRemovableBollards: true });
    expect(closed.dist[id(0, 0)]).toBe(Infinity);
    expect(open.dist[id(0, 0)]).toBe((6 + 9) * 25);
  });
});

describe('gini', () => {
  it('is 0 for an even spread and approaches 1 when one slot takes everything', () => {
    expect(gini([5, 5, 5, 5])).toBe(0);
    expect(gini([0, 0, 0, 100])).toBeCloseTo(0.75);
    expect(gini([])).toBe(0);
  });
});

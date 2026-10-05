import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PersonaId, SimulationResult } from '../../contracts';
import {
  distanceToPolylineM,
  graphNodesOf,
  haversineM,
  kioskPositions,
  offsetLngLat,
  passedWithin,
  pickHero,
  pickHeroes,
  tripPositionAt,
} from './heroes';
import type { HeroRule, SceneAssets } from './types';

type Trip = SimulationResult['trips'][number];

const BASE: [number, number] = [11.08, 49.449];
/** A point `east` and `north` metres from BASE. */
const at = (east: number, north: number) => offsetLngLat(offsetLngLat(BASE, 90, east), 0, north);
const trip = (persona: PersonaId, pts: [number, number, number][]): Trip => ({
  persona,
  path: pts.map(([e, n, t]) => [...at(e, n), t] as [number, number, number]),
});

const ELEVATOR = at(100, 0);
const LOADING = at(-200, 50);
const BOLLARD = at(0, 300);

const assets: SceneAssets = {
  arrivals: null,
  graphNodes: {
    nodes: [
      { id: 'x', lng: 'bad', lat: 1, role: 'elevator' },
      { id: 'e1', lng: ELEVATOR[0], lat: ELEVATOR[1], role: 'elevator' },
      { id: 'l1', lng: LOADING[0], lat: LOADING[1], role: 'loading' },
    ],
  },
};

function makeResult(trips: Trip[]): SimulationResult {
  const p = { score: 1, served: 1, droppedOut: 0, topFriction: '' };
  return {
    candidateId: 'kaufhof', scenario: 'RAINY_SAT', seed: 7, mitigations: [],
    criteria: { accessibility: 0, footfall: 0, fairness: 0, localBusiness: 0, walkability: 0 },
    personas: { senior: p, vendor: p, commuter: p, retailer: p },
    bySlice: {
      '05:30_DELIVERY': {
        heat: [],
        bottlenecks: [
          { lng: at(0, -500)[0], lat: at(0, -500)[1], severity: 1, type: 'CROWDING', time: '05:40', cause: '' },
          { lng: BOLLARD[0], lat: BOLLARD[1], severity: 1, type: 'BOLLARD_BLOCKAGE', time: '05:34', cause: '' },
        ],
      },
      '11:30_PEAK': { heat: [], bottlenecks: [] },
      '15:00_LULL': { heat: [], bottlenecks: [] },
    },
    stallExposure: [],
    trips,
  };
}

describe('geometry', () => {
  it('measures haversine metres and offsets along a bearing', () => {
    expect(haversineM(BASE, offsetLngLat(BASE, 0, 100))).toBeCloseTo(100, 6);
    expect(haversineM(BASE, offsetLngLat(BASE, 135, 60))).toBeCloseTo(60, 3);
  });

  it('interpolates a trip position by sim time', () => {
    const t = trip('senior', [[0, 0, 100], [100, 0, 200], [100, 100, 300]]);
    expect(haversineM(tripPositionAt(t, 150, false)!, at(50, 0))).toBeLessThan(0.01);
    expect(haversineM(tripPositionAt(t, 250, false)!, at(100, 50))).toBeLessThan(0.01);
    expect(tripPositionAt(t, 50, false)).toBeNull();
    expect(tripPositionAt(t, 350, false)).toBeNull();
    expect(haversineM(tripPositionAt(t, 50, true)!, at(0, 0))).toBeLessThan(0.01);
    expect(haversineM(tripPositionAt(t, 350, true)!, at(100, 100))).toBeLessThan(0.01);
  });

  it('measures distance to a polyline segment, not only to its vertices', () => {
    expect(distanceToPolylineM([at(-100, 0), at(100, 0)], at(0, 20))).toBeCloseTo(20, 1);
  });

  it('checks proximity inside a sim-time window only', () => {
    const t = trip('senior', [[0, 0, 0], [200, 0, 200]]);
    expect(passedWithin(t, ELEVATOR, 5, 90, 110)).toBe(true);
    expect(passedWithin(t, ELEVATOR, 5, 0, 50)).toBe(false);
    expect(passedWithin(t, ELEVATOR, 5, 150, 200)).toBe(false);
    expect(passedWithin(t, ELEVATOR, 5, 300, 400)).toBe(false);
  });
});

describe('scene assets', () => {
  it('reads graph nodes of one role in file order and skips malformed entries', () => {
    expect(graphNodesOf(assets, 'elevator').map((n) => n.id)).toEqual(['e1']);
    expect(graphNodesOf(assets, 'loading').map((n) => n.id)).toEqual(['l1']);
    expect(graphNodesOf({ arrivals: null, graphNodes: null }, 'loading')).toEqual([]);
  });

  it('parses kiosk mitigations and ignores other entries', () => {
    const r = { ...makeResult([]), mitigations: ['delivery-window:05:00-06:30', 'kiosk:11.080100,49.449200', 'kiosk:x'] };
    expect(kioskPositions(r)).toEqual([[11.0801, 49.4492]]);
  });
});

describe('hero rules', () => {
  const markus: HeroRule = {
    hero: 'markus', persona: 'vendor', pick: 'lastPointNearestBottleneck', slice: '05:30_DELIVERY', type: 'BOLLARD_BLOCKAGE',
  };
  const helga: HeroRule = { hero: 'helga', persona: 'senior', pick: 'earliestPassingNode', node: 'elevator', withinM: 5 };
  const lukas: HeroRule = { hero: 'lukas', persona: 'commuter', pick: 'longestInWindow', window: [41400, 43200] };
  const loader: HeroRule = { hero: 'markus', persona: 'vendor', pick: 'lastPointNearestNode', node: 'loading' };

  const trips: Trip[] = [
    /* 0 */ trip('vendor', [[0, 0, 19800], [0, 200, 20000]]),
    /* 1 */ trip('vendor', [[0, 0, 19800], [0, 290, 20100]]),
    /* 2 */ trip('senior', [[0, 300, 290], [0, 290, 300]]), // nearest to the bollard, wrong persona
    /* 3 */ trip('senior', [[0, 0, 36000], [50, 0, 36100]]), // starts first, never reaches the elevator
    /* 4 */ trip('senior', [[0, 3, 36050], [200, 3, 36300]]), // passes 3 m from the elevator
    /* 5 */ trip('senior', [[0, 0, 36200], [200, 0, 36400]]), // passes later
    /* 6 */ trip('commuter', [[0, 0, 41400], [10, 0, 42000]]),
    /* 7 */ trip('commuter', [[0, 0, 41500], [10, 0, 42400]]),
    /* 8 */ trip('commuter', [[0, 0, 30000], [10, 0, 42400]]), // longest, starts outside the window
    /* 9 */ trip('vendor', [[0, 0, 19800], [-195, 45, 20100]]),
    /* 10 */ trip('vendor', []),
  ];
  const result = makeResult(trips);

  it('picks Markus by the bottleneck nearest his last point', () => {
    expect(pickHero(markus, result, assets)).toEqual({ hero: 'markus', tripIndex: 1 });
  });

  it('picks the vendor nearest the loading node', () => {
    expect(pickHero(loader, result, assets)).toEqual({ hero: 'markus', tripIndex: 9 });
  });

  it('picks Helga as the earliest senior passing an elevator', () => {
    expect(pickHero(helga, result, assets)).toEqual({ hero: 'helga', tripIndex: 4 });
    expect(pickHero({ ...helga, withinM: 1 }, result, assets)).toEqual({ hero: 'helga', tripIndex: 5 });
  });

  it('picks Lukas as the longest commuter trip starting in the window', () => {
    expect(pickHero(lukas, result, assets)).toEqual({ hero: 'lukas', tripIndex: 7 });
  });

  it('ranks dropped trips first when the engine reports an outcome (Q2)', () => {
    const withOutcome = makeResult(trips.map((t, i) => (i === 6 ? { ...t, outcome: 'dropped' } : t)) as Trip[]);
    expect(pickHero(lukas, withOutcome, assets)).toEqual({ hero: 'lukas', tripIndex: 6 });
  });

  it('breaks ties by the lowest trip index', () => {
    const twins = makeResult([trips[0], trips[1], trips[1], trips[6], trips[6]]);
    expect(pickHero(markus, twins, assets)?.tripIndex).toBe(1);
    expect(pickHero(lukas, twins, assets)?.tripIndex).toBe(3);
  });

  it('returns null when nothing qualifies', () => {
    expect(pickHero({ ...markus, type: 'ELEVATOR_CONGESTION' }, result, assets)).toBeNull();
    expect(pickHero(helga, result, { arrivals: null, graphNodes: [] })).toBeNull();
    expect(pickHero({ ...lukas, window: [0, 1] }, result, assets)).toBeNull();
    expect(pickHero({ ...markus, persona: 'retailer' }, result, assets)).toBeNull();
  });

  it('maps every hero and leaves heroes without a rule null', () => {
    expect(pickHeroes([lukas, helga], result, assets)).toEqual({
      markus: null,
      helga: { hero: 'helga', tripIndex: 4 },
      lukas: { hero: 'lukas', tripIndex: 7 },
    });
  });

  it('picks the same hero from the committed fixture on every call', () => {
    const fixture = JSON.parse(
      readFileSync(resolvePath(process.cwd(), 'public/data/fixtures/result-KAUFHOF-RAINY_SAT.json'), 'utf8'),
    ) as SimulationResult;
    const rule: HeroRule = { ...markus, type: 'CROWDING' };
    const pick = pickHero(rule, fixture, assets);
    expect(pick).not.toBeNull();
    expect(fixture.trips[pick!.tripIndex].persona).toBe('vendor');
    const b = fixture.bySlice['05:30_DELIVERY'].bottlenecks.find((x) => x.type === 'CROWDING')!;
    const lastOf = (t: Trip) => t.path[t.path.length - 1];
    const dist = (t: Trip) => haversineM([lastOf(t)[0], lastOf(t)[1]], [b.lng, b.lat]);
    const best = Math.min(...fixture.trips.filter((t) => t.persona === 'vendor').map(dist));
    expect(dist(fixture.trips[pick!.tripIndex])).toBe(best);
    expect(pickHero(rule, fixture, assets)).toEqual(pick);
  });
});

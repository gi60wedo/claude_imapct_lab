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
type LngLatPoint = [number, number];

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

/**
 * Scene 2 rules on the committed Kaufhof fixture. No `graph.json` nodes are
 * committed, so each test places elevator and loading nodes on points of the
 * fixture's own trips. Every fixture trip starts at the same origin. The
 * expected indices come from the fixture data and change only when it does.
 */
describe('hero rules on the Kaufhof RAINY_SAT fixture', () => {
  const fixture = JSON.parse(
    readFileSync(resolvePath(process.cwd(), 'public/data/fixtures/result-KAUFHOF-RAINY_SAT.json'), 'utf8'),
  ) as SimulationResult;
  const helga: HeroRule = { hero: 'helga', persona: 'senior', pick: 'earliestPassingNode', node: 'elevator', withinM: 5 };
  const lukas: HeroRule = { hero: 'lukas', persona: 'commuter', pick: 'longestInWindow', window: [41400, 43200] };
  const markus: HeroRule = { hero: 'markus', persona: 'vendor', pick: 'lastPointNearestNode', node: 'loading' };

  const nodes = (role: string, ...points: LngLatPoint[]): SceneAssets => ({
    arrivals: null,
    graphNodes: points.map(([lng, lat], i) => ({ id: `${role}${i}`, lng, lat, role })),
  });
  const firstPoint = (i: number): LngLatPoint => [fixture.trips[i].path[0][0], fixture.trips[i].path[0][1]];
  const lastPoint = (i: number): LngLatPoint => {
    const p = fixture.trips[i].path[fixture.trips[i].path.length - 1];
    return [p[0], p[1]];
  };
  const start = (i: number) => fixture.trips[i].path[0][2];
  const withExtra = (i: number): SimulationResult => ({ ...fixture, trips: [...fixture.trips, fixture.trips[i]] });

  it('picks Helga as the earliest-starting senior passing an elevator', () => {
    // Every senior passes the shared origin. Trip 88 starts first, though trip 7 is the lowest senior index.
    expect(pickHero(helga, fixture, nodes('elevator', firstPoint(88)))).toEqual({ hero: 'helga', tripIndex: 88 });
    expect(start(88)).toBeLessThan(start(7));
    // Seniors 65, 126 and 68 pass the end of trip 68. Trip 65 starts first.
    expect(pickHero(helga, fixture, nodes('elevator', lastPoint(68)))).toEqual({ hero: 'helga', tripIndex: 65 });
  });

  it('applies withinM as an inclusive radius on the fixture paths', () => {
    // Trip 88 passes 4.08 m from the end of trip 60; trip 64 runs through it and starts later.
    const elevator = nodes('elevator', lastPoint(60));
    expect(pickHero(helga, fixture, elevator)).toEqual({ hero: 'helga', tripIndex: 88 });
    expect(pickHero({ ...helga, withinM: 4 }, fixture, elevator)).toEqual({ hero: 'helga', tripIndex: 64 });
  });

  it('breaks a Helga start-time tie by the lowest trip index', () => {
    const twin = withExtra(65);
    expect(pickHero(helga, twin, nodes('elevator', lastPoint(68)))).toEqual({ hero: 'helga', tripIndex: 65 });
  });

  it('leaves Helga null without an elevator node or with none in reach', () => {
    expect(pickHero(helga, fixture, nodes('loading', lastPoint(68)))).toBeNull();
    expect(pickHero(helga, fixture, nodes('elevator', [11.2, 49.5]))).toBeNull();
  });

  it('picks loading-point Markus as the vendor ending nearest a loading node', () => {
    expect(pickHero(markus, fixture, nodes('loading', lastPoint(23)))).toEqual({ hero: 'markus', tripIndex: 23 });
    expect(fixture.trips[23].persona).toBe('vendor');
  });

  it('breaks a loading-point tie by the lowest trip index', () => {
    // Vendors 98 and 125 end on the same point.
    expect(lastPoint(125)).toEqual(lastPoint(98));
    expect(pickHero(markus, fixture, nodes('loading', lastPoint(125)))).toEqual({ hero: 'markus', tripIndex: 98 });
    // With two loading nodes, vendors 23, 98 and 125 all end on one.
    expect(pickHero(markus, fixture, nodes('loading', lastPoint(98), lastPoint(23)))).toEqual({ hero: 'markus', tripIndex: 23 });
  });

  it('leaves Markus null without a loading node or a matching bottleneck', () => {
    expect(pickHero(markus, fixture, nodes('elevator', lastPoint(23)))).toBeNull();
    expect(pickHero(markus, fixture, { arrivals: null, graphNodes: null })).toBeNull();
    const scene1: HeroRule = {
      hero: 'markus', persona: 'vendor', pick: 'lastPointNearestBottleneck', slice: '05:30_DELIVERY', type: 'BOLLARD_BLOCKAGE',
    };
    expect(fixture.bySlice['05:30_DELIVERY'].bottlenecks.some((b) => b.type === 'BOLLARD_BLOCKAGE')).toBe(false);
    expect(pickHero(scene1, fixture, nodes('loading', lastPoint(23)))).toBeNull();
  });

  it('leaves Lukas null when no commuter starts in the 11:30 window', () => {
    // The fixture's tSec runs from 0 and does not follow Q1, so no trip starts at 11:30.
    const commuters = fixture.trips.filter((t) => t.persona === 'commuter');
    expect(commuters.filter((t) => t.path[0][2] >= 41400 && t.path[0][2] <= 43200)).toEqual([]);
    expect(pickHero(lukas, fixture, nodes('elevator'))).toBeNull();
  });

  it('breaks a Lukas duration tie by the lowest trip index', () => {
    // Every fixture commuter trip lasts the same time.
    const durations = new Set(fixture.trips.filter((t) => t.persona === 'commuter').map((t) => t.path[t.path.length - 1][2] - t.path[0][2]));
    expect(durations.size).toBe(1);
    // Commuters 2, 13, 19 and 40 start inside [200, 300].
    expect(pickHero({ ...lukas, window: [200, 300] }, fixture, nodes('elevator'))).toEqual({ hero: 'lukas', tripIndex: 2 });
    expect(pickHero({ ...lukas, window: [0, 3600] }, fixture, nodes('elevator'))).toEqual({ hero: 'lukas', tripIndex: 1 });
  });

  it('maps all three scene 2 heroes from one asset set', () => {
    const assets2: SceneAssets = {
      arrivals: null,
      graphNodes: [
        { id: 'e0', lng: lastPoint(68)[0], lat: lastPoint(68)[1], role: 'elevator' },
        { id: 'l0', lng: lastPoint(125)[0], lat: lastPoint(125)[1], role: 'loading' },
      ],
    };
    const rules = [helga, { ...lukas, window: [200, 300] } as HeroRule, markus];
    expect(pickHeroes(rules, fixture, assets2)).toEqual({
      markus: { hero: 'markus', tripIndex: 98 },
      helga: { hero: 'helga', tripIndex: 65 },
      lukas: { hero: 'lukas', tripIndex: 2 },
    });
    expect(pickHeroes(rules, fixture, assets2)).toEqual(pickHeroes(rules, fixture, assets2));
  });
});

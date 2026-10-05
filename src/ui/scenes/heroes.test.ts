import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Bottleneck, PersonaId, SimulationResult, TimeSlice } from '../../contracts';
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
import type { HeroId, HeroRule, SceneAssets } from './types';

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

  it('picks Markus by every bottleneck type the committed fixture reports', () => {
    let checked = 0;
    for (const slice of SLICES) {
      for (const type of new Set(fixture.bySlice[slice].bottlenecks.map((b) => b.type))) {
        const rule: HeroRule = { ...markus, slice, type };
        const want = oracleNearestBottleneck(fixture, 'vendor', slice, type);
        if (want === undefined) continue;
        expect(pickHero(rule, fixture, assets), `${slice} ${type}`).toEqual(asPick('markus', want));
        expect(pickHero(rule, fixture, assets)).toEqual(pickHero(rule, fixture, assets));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------ */
/* Independent oracle for the fixture tests                                  */
/* ------------------------------------------------------------------------ */

/**
 * The oracle re-derives each hero rule from the raw trips without heroes.ts,
 * so the expected heroes follow the fixture when it is regenerated. A case is
 * `undefined` (skipped) when two keys sit so close that float detail could
 * flip the pick between the oracle and the implementation.
 */
const fixture = JSON.parse(
  readFileSync(resolvePath(process.cwd(), 'public/data/fixtures/result-KAUFHOF-RAINY_SAT.json'), 'utf8'),
) as SimulationResult;

const SLICES: readonly TimeSlice[] = ['05:30_DELIVERY', '11:30_PEAK', '15:00_LULL'];
const BOTTLENECK_TYPES: readonly Bottleneck['type'][] = ['BOLLARD_BLOCKAGE', 'COBBLESTONE_FRICTION', 'ELEVATOR_CONGESTION', 'CROWDING'];
const R_M = 6_371_008.8;
const DEG = Math.PI / 180;
const EPS_M = 1e-3;

const firstOf = (t: Trip): LngLatPoint => [t.path[0][0], t.path[0][1]];
const lastOf = (t: Trip): LngLatPoint => [t.path[t.path.length - 1][0], t.path[t.path.length - 1][1]];
const startOf = (t: Trip) => t.path[0][2];
const durationOf = (t: Trip) => t.path[t.path.length - 1][2] - t.path[0][2];
const asPick = (hero: HeroId, i: number | null) => (i === null ? null : { hero, tripIndex: i });

function oracleDistM(p: LngLatPoint, q: LngLatPoint): number {
  const s =
    Math.sin(((q[1] - p[1]) * DEG) / 2) ** 2 +
    Math.cos(p[1] * DEG) * Math.cos(q[1] * DEG) * Math.sin(((q[0] - p[0]) * DEG) / 2) ** 2;
  return 2 * R_M * Math.asin(Math.sqrt(s));
}

/** Distance from `p` to a trip's polyline, measured in a flat metre frame centred on `p`. */
function oraclePathDistM(t: Trip, p: LngLatPoint): number {
  const xy = t.path.map((q) => [(q[0] - p[0]) * DEG * R_M * Math.cos(p[1] * DEG), (q[1] - p[1]) * DEG * R_M]);
  if (xy.length === 1) return Math.hypot(xy[0][0], xy[0][1]);
  let best = Infinity;
  for (let i = 1; i < xy.length; i++) {
    const [ax, ay] = xy[i - 1];
    const dx = xy[i][0] - ax;
    const dy = xy[i][1] - ay;
    const len2 = dx * dx + dy * dy;
    const f = len2 === 0 ? 0 : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2));
    best = Math.min(best, Math.hypot(ax + f * dx, ay + f * dy));
  }
  return best;
}

/** Ascending indices of non-empty trips of one persona. */
const tripsOf = (r: SimulationResult, persona: PersonaId) =>
  r.trips.flatMap((t, i) => (t.persona === persona && t.path.length > 0 ? [i] : []));

/** Lowest index with the smallest key; `undefined` when another key lies within `eps` of it. */
function oracleArgMin(pool: number[], key: (i: number) => number, eps = EPS_M): number | null | undefined {
  if (!pool.length) return null;
  const keys = pool.map(key);
  const best = Math.min(...keys);
  if (keys.some((k) => k !== best && k - best <= eps)) return undefined;
  return pool[keys.indexOf(best)];
}

function oracleNearestBottleneck(r: SimulationResult, persona: PersonaId, slice: TimeSlice, type: Bottleneck['type']) {
  const b = r.bySlice[slice].bottlenecks.find((x) => x.type === type);
  if (!b) return null;
  return oracleArgMin(tripsOf(r, persona), (i) => oracleDistM(lastOf(r.trips[i]), [b.lng, b.lat]));
}

function oracleNearestNode(r: SimulationResult, persona: PersonaId, pts: LngLatPoint[]) {
  if (!pts.length) return null;
  return oracleArgMin(tripsOf(r, persona), (i) => Math.min(...pts.map((p) => oracleDistM(lastOf(r.trips[i]), p))));
}

/** Trips of `persona` passing within `withinM` of a point; `undefined` when one sits on the radius. */
function oraclePassing(r: SimulationResult, persona: PersonaId, pts: LngLatPoint[], withinM: number): number[] | undefined {
  const pool = tripsOf(r, persona);
  const d = pool.map((i) => Math.min(...pts.map((p) => oraclePathDistM(r.trips[i], p))));
  if (d.some((x) => x !== 0 && Math.abs(x - withinM) <= EPS_M)) return undefined;
  return pool.filter((_, k) => d[k] <= withinM);
}

function oracleEarliestPassing(r: SimulationResult, persona: PersonaId, pts: LngLatPoint[], withinM: number) {
  if (!pts.length) return null;
  const passing = oraclePassing(r, persona, pts, withinM);
  return passing && oracleArgMin(passing, (i) => startOf(r.trips[i]));
}

function oracleLongest(r: SimulationResult, persona: PersonaId, [w0, w1]: readonly [number, number]) {
  const pool = tripsOf(r, persona).filter((i) => startOf(r.trips[i]) >= w0 && startOf(r.trips[i]) <= w1);
  return oracleArgMin(pool, (i) => -durationOf(r.trips[i]));
}

/**
 * Scene 2 rules on the committed Kaufhof fixture. No `graph.json` nodes are
 * committed, so each test places elevator and loading nodes on points of the
 * fixture's own trips and compares every pick with the oracle above.
 */
describe('hero rules on the Kaufhof RAINY_SAT fixture', () => {
  const helga: HeroRule = { hero: 'helga', persona: 'senior', pick: 'earliestPassingNode', node: 'elevator', withinM: 5 };
  const lukas: HeroRule = { hero: 'lukas', persona: 'commuter', pick: 'longestInWindow', window: [41400, 43200] };
  const markus: HeroRule = { hero: 'markus', persona: 'vendor', pick: 'lastPointNearestNode', node: 'loading' };

  const nodes = (role: string, ...points: LngLatPoint[]): SceneAssets => ({
    arrivals: null,
    graphNodes: points.map(([lng, lat], i) => ({ id: `${role}${i}`, lng, lat, role })),
  });
  /** Node sites: every trip's first and last point. */
  const sites: LngLatPoint[] = fixture.trips.flatMap((t) => [firstOf(t), lastOf(t)]);
  const seniors = tripsOf(fixture, 'senior');
  const vendors = tripsOf(fixture, 'vendor');
  const commuters = tripsOf(fixture, 'commuter');
  /** The fixture with a copy of trip `i` placed first or last. */
  const withCopy = (i: number, at: 'first' | 'last'): SimulationResult => ({
    ...fixture,
    trips: at === 'first' ? [fixture.trips[i], ...fixture.trips] : [...fixture.trips, fixture.trips[i]],
  });

  it('has trips of every scene 2 persona', () => {
    expect(seniors.length).toBeGreaterThan(1);
    expect(vendors.length).toBeGreaterThan(1);
    expect(commuters.length).toBeGreaterThan(1);
  });

  it('picks Helga as the earliest-starting senior passing an elevator', () => {
    let checked = 0;
    let startBeatsIndex = 0;
    for (const p of sites) {
      const passing = oraclePassing(fixture, 'senior', [p], helga.withinM);
      const want = passing && oracleArgMin(passing, (i) => startOf(fixture.trips[i]));
      if (want === undefined) continue;
      expect(pickHero(helga, fixture, nodes('elevator', p)), `elevator at ${p}`).toEqual(asPick('helga', want));
      checked++;
      if (want !== null && want !== passing![0]) startBeatsIndex++;
    }
    expect(checked).toBeGreaterThan(sites.length / 2);
    // The fixture exercises start order: some picks are not the lowest passing index.
    expect(startBeatsIndex).toBeGreaterThan(0);
  });

  it('applies withinM as an inclusive radius on the fixture paths', () => {
    // A senior's own first point lies at 0 m, so a zero radius still admits it.
    const first = oracleArgMin(seniors, (i) => startOf(fixture.trips[i]))!;
    const origin = firstOf(fixture.trips[first]);
    expect(oracleEarliestPassing(fixture, 'senior', [origin], 0)).toBe(first);
    expect(pickHero({ ...helga, withinM: 0 }, fixture, nodes('elevator', origin))).toEqual(asPick('helga', first));

    // Growing the radius past one senior's distance swaps the pick to that senior.
    let checked = 0;
    for (const p of sites) {
      const d = seniors.map((i) => oraclePathDistM(fixture.trips[i], p));
      d.forEach((dk, k) => {
        if (dk < 1 || dk > 20 || d.some((x, j) => j !== k && Math.abs(x - dk) <= 0.5)) return;
        const wide = oracleEarliestPassing(fixture, 'senior', [p], dk + 0.25);
        const narrow = oracleEarliestPassing(fixture, 'senior', [p], dk - 0.25);
        if (wide !== seniors[k] || narrow === undefined) return;
        expect(pickHero({ ...helga, withinM: dk + 0.25 }, fixture, nodes('elevator', p))).toEqual(asPick('helga', wide));
        expect(pickHero({ ...helga, withinM: dk - 0.25 }, fixture, nodes('elevator', p))).toEqual(asPick('helga', narrow));
        checked++;
      });
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('breaks a Helga start-time tie by the lowest trip index', () => {
    const want = oracleArgMin(seniors, (i) => startOf(fixture.trips[i]))!;
    const origin = firstOf(fixture.trips[want]);
    // A copy of the winner ties on start time. The copy wins only when it has the lower index.
    expect(pickHero(helga, withCopy(want, 'last'), nodes('elevator', origin))).toEqual(asPick('helga', want));
    expect(pickHero(helga, withCopy(want, 'first'), nodes('elevator', origin))).toEqual(asPick('helga', 0));
  });

  it('leaves Helga null without an elevator node or with none in reach', () => {
    const far: LngLatPoint = [11.2, 49.5];
    expect(pickHero(helga, fixture, nodes('loading', ...sites.slice(0, 4)))).toBeNull();
    expect(oracleEarliestPassing(fixture, 'senior', [far], helga.withinM)).toBeNull();
    expect(pickHero(helga, fixture, nodes('elevator', far))).toBeNull();
  });

  it('picks loading-point Markus as the vendor ending nearest a loading node', () => {
    let checked = 0;
    sites.forEach((p, k) => {
      const q = sites[(k + 7) % sites.length];
      for (const pts of [[p], [p, q]]) {
        const want = oracleNearestNode(fixture, 'vendor', pts);
        if (want === undefined) continue;
        expect(pickHero(markus, fixture, nodes('loading', ...pts)), `loading at ${pts}`).toEqual(asPick('markus', want));
        checked++;
      }
    });
    expect(checked).toBeGreaterThan(sites.length);
  });

  it('breaks a loading-point tie by the lowest trip index', () => {
    // Vendors that end on one point tie at 0 m; the lowest of them wins.
    const byEnd = new Map<string, number[]>();
    for (const i of vendors) byEnd.set(String(lastOf(fixture.trips[i])), [...(byEnd.get(String(lastOf(fixture.trips[i]))) ?? []), i]);
    for (const group of byEnd.values()) {
      expect(pickHero(markus, fixture, nodes('loading', lastOf(fixture.trips[group[0]])))).toEqual(asPick('markus', group[0]));
    }
    // A copy of a vendor ties with it. The copy wins only when it has the lower index.
    const v = vendors[0];
    const end = lastOf(fixture.trips[v]);
    expect(pickHero(markus, withCopy(v, 'last'), nodes('loading', end))).toEqual(asPick('markus', byEnd.get(String(end))![0]));
    expect(pickHero(markus, withCopy(v, 'first'), nodes('loading', end))).toEqual(asPick('markus', 0));
  });

  it('leaves Markus null without a loading node or a matching bottleneck', () => {
    const end = lastOf(fixture.trips[vendors[0]]);
    expect(pickHero(markus, fixture, nodes('elevator', end))).toBeNull();
    expect(pickHero(markus, fixture, { arrivals: null, graphNodes: null })).toBeNull();
    const absent = SLICES.flatMap((slice) =>
      BOTTLENECK_TYPES.filter((type) => !fixture.bySlice[slice].bottlenecks.some((b) => b.type === type)).map((type) => ({ slice, type })),
    );
    expect(absent.length).toBeGreaterThan(0);
    for (const { slice, type } of absent) {
      const rule: HeroRule = { hero: 'markus', persona: 'vendor', pick: 'lastPointNearestBottleneck', slice, type };
      expect(pickHero(rule, fixture, nodes('loading', end)), `${slice} ${type}`).toBeNull();
    }
  });

  it('picks Lukas as the longest commuter trip starting in a window', () => {
    // The 11:30 window is in Q1 clock seconds. The oracle decides whether this fixture's time base reaches it.
    expect(pickHero(lukas, fixture, nodes('elevator'))).toEqual(asPick('lukas', oracleLongest(fixture, 'commuter', lukas.window)!));
    let checked = 0;
    for (const i of commuters) {
      const win = [startOf(fixture.trips[i]), startOf(fixture.trips[i]) + 300] as const;
      const want = oracleLongest(fixture, 'commuter', win);
      if (want === undefined) continue;
      expect(pickHero({ ...lukas, window: win }, fixture, nodes('elevator')), `window ${win}`).toEqual(asPick('lukas', want));
      checked++;
    }
    expect(checked).toBe(commuters.length);
    const after = Math.max(...fixture.trips.map((t) => startOf(t))) + 1;
    expect(pickHero({ ...lukas, window: [after, after + 3600] }, fixture, nodes('elevator'))).toBeNull();
  });

  it('breaks a Lukas duration tie by the lowest trip index', () => {
    const starts = commuters.map((i) => startOf(fixture.trips[i]));
    const win = [Math.min(...starts), Math.max(...starts)] as const;
    const want = oracleLongest(fixture, 'commuter', win)!;
    expect(pickHero({ ...lukas, window: win }, fixture, nodes('elevator'))).toEqual(asPick('lukas', want));
    // A copy of the winner ties on duration. The copy wins only when it has the lower index.
    expect(pickHero({ ...lukas, window: win }, withCopy(want, 'last'), nodes('elevator'))).toEqual(asPick('lukas', want));
    expect(pickHero({ ...lukas, window: win }, withCopy(want, 'first'), nodes('elevator'))).toEqual(asPick('lukas', 0));
  });

  it('maps all three scene 2 heroes from one asset set', () => {
    const elevator = lastOf(fixture.trips[seniors[0]]);
    const loading = lastOf(fixture.trips[vendors[vendors.length - 1]]);
    const assets2: SceneAssets = {
      arrivals: null,
      graphNodes: [
        { id: 'e0', lng: elevator[0], lat: elevator[1], role: 'elevator' },
        { id: 'l0', lng: loading[0], lat: loading[1], role: 'loading' },
      ],
    };
    const starts = commuters.map((i) => startOf(fixture.trips[i]));
    const win = [Math.min(...starts), Math.max(...starts)] as const;
    const rules = [helga, { ...lukas, window: win } as HeroRule, markus];
    const want = {
      markus: asPick('markus', oracleNearestNode(fixture, 'vendor', [loading])!),
      helga: asPick('helga', oracleEarliestPassing(fixture, 'senior', [elevator], helga.withinM)!),
      lukas: asPick('lukas', oracleLongest(fixture, 'commuter', win)!),
    };
    expect(Object.values(want).every((p) => p !== null)).toBe(true);
    expect(pickHeroes(rules, fixture, assets2)).toEqual(want);
    expect(pickHeroes(rules, fixture, assets2)).toEqual(pickHeroes(rules, fixture, assets2));
  });
});

import { describe, expect, it } from 'vitest';
import type { Candidate } from '../../contracts';
import { simulate } from '../engine';
import { LocalProjection } from '../geo';
import { round1 } from '../metrics';
import * as P from '../params';
import { prepareWorld, scenarioPool, type PoolAgent } from '../prepare';
import { fork } from '../rng';
import type { GraphEdge, GraphNode, Mitigation, World } from '../world';

const projection = new LocalProjection(11.07, 49.45);
const xy = (x: number, y = 0) => projection.toLngLat(x, y);
const node = (x: number, y = 0): GraphNode => { const [lng, lat] = xy(x, y); return { lng, lat }; };
const edge = (a: number, b: number, lengthM: number, vehicle = false): GraphEdge => ({
  a, b, lengthM, vehicle, walk: true, oneway: false, slope: 0, steps: false,
  surface: 'smooth', sheltered: false, widthM: 3,
});
const site: Candidate = {
  id: 'regression', name: 'Regression square', kind: 'square', areaM2: 900,
  polygon: [xy(-15, -15), xy(15, -15), xy(15, 15), xy(-15, 15)], passedFilter: true,
  indicators: { transitScore: 0, walkScore: 0, population800m: 0, retailPoi400m: 0,
    attractions400m: 0, deliveryAccess: false, vanDistM: 0 },
};
function world(nodes: GraphNode[], edges: GraphEdge[]): World {
  return { graph: { nodes, edges }, pois: { subwayEntrances: [], elevators: [], stops: [], shops: [],
    attractions: [], vanEntries: [] }, population: [], stations: [], christmasMarket: [] };
}
function agent(kind: PoolAgent['kind'], origin: number, arriveAt: number): PoolAgent {
  return { kind, node: origin, arriveAt, dwellSec: 1200, homeX: 0, homeY: 0, station: 'Test' };
}
function prepared(w: World, agents: PoolAgent[] = []) {
  const pw = prepareWorld(w);
  pw.pools.set('SUNNY_SAT|7|1', { agents, passers: [], ctx: { rain: false } });
  return pw;
}
const opts = { scenario: 'SUNNY_SAT', seed: 7, scale: 1, maxTrips: 300 } as const;

describe('review regressions', () => {
  it('supplements tagged loading nodes with candidate-scoped existing locations', () => {
    const w = world([node(-200), { ...node(-70), loadingPoint: true }, node(-40), node(0)],
      [edge(0, 1, 130, true), edge(1, 2, 30, true), edge(2, 3, 40, true)]);
    w.pois.vanEntries = [xy(-200)];
    const run = (input: World) => simulate(prepared(input), site, opts).personas.vendor;
    const tagged = run({ ...w, loadingPoints: { [site.id]: [] } });
    const explicit = run({ ...w, loadingPoints: { [site.id]: [xy(-40)], another: [xy(0)] } });
    expect(explicit.score).toBeGreaterThan(tagged.score);
    expect(explicit.topFriction).toMatch(/^25 m carry/);
    expect(run({ ...w, loadingPoints: { another: [xy(0)] } }).score).toBeGreaterThan(explicit.score);
    expect(run({ ...w, loadingPoints: { [site.id]: [xy(-200)] } })).toEqual(tagged);
    const both = run({ ...w, loadingPoints: { [site.id]: [xy(-40)] }, graph: {
      ...w.graph, nodes: w.graph.nodes.map((n, i) => i === 3 ? { ...n, loadingPoint: true } : n),
    } });
    expect(both.score).toBeGreaterThan(explicit.score);
    expect(both.topFriction).toMatch(/^0 m carry/);
  });

  it("uses Part A's evidence.loadingPoint in place of the world's benchmark points", () => {
    const w = world([node(-200), node(-70), node(-40), node(0)],
      [edge(0, 1, 130, true), edge(1, 2, 30, true), edge(2, 3, 40, true)]);
    w.pois.vanEntries = [xy(-200)];
    const withWorld = { ...w, loadingPoints: { [site.id]: [xy(-70)] } };
    const run = (cand: typeof site) => simulate(prepared(withWorld), cand, opts).personas.vendor;
    const worldOnly = run(site);
    const prep = run({ ...site, evidence: { loadingPoint: xy(0) } } as unknown as typeof site);
    expect(worldOnly.topFriction).toMatch(/^\d+ m carry/);
    expect(prep.score).toBeGreaterThan(worldOnly.score);
    expect(prep.topFriction).toMatch(/^0 m carry/);
  });

  it('improves vendor routing only when a new designated loading destination becomes usable, with a fixed seed', () => {
    const w = world([node(-200), { ...node(-70), loadingPoint: true }, node(0)],
      [edge(0, 1, 130, true), edge(1, 2, 70, true)]);
    w.pois.vanEntries = [xy(-200)];
    w.loadingPoints = { [site.id]: [] };
    const pw = prepared(w);
    const run = (mitigations: Mitigation[] = []) => simulate(pw, site, { ...opts, mitigations });
    const base = run();
    const added = run([{ kind: 'loading_point', lng: xy(0)[0], lat: xy(0)[1] }]);
    expect(added.personas.vendor.score).toBeGreaterThan(base.personas.vendor.score);
    expect(base.personas.vendor.topFriction).toMatch(/^55 m carry/);
    expect(added.personas.vendor.topFriction).toMatch(/^0 m carry/);
    // Re-designating the existing point or adding a point outside the carry radius changes no routing.
    for (const x of [-70, -200]) {
      const unchanged = run([{ kind: 'loading_point', lng: xy(x)[0], lat: xy(x)[1], label: 'Different label' }]);
      expect(unchanged.personas.vendor).toEqual(base.personas.vendor);
      expect(unchanged.trips.filter((t) => t.persona === 'vendor')).toEqual(base.trips.filter((t) => t.persona === 'vendor'));
    }
    expect(run([{ kind: 'loading_point', lng: xy(0)[0], lat: xy(0)[1] }])).toEqual(added);
  });

  it('falls back to one nearby vehicle node without tags, while an empty benchmark entry disables fallback', () => {
    const w = world([node(-200), node(-40), node(0)], [edge(0, 1, 160, true), edge(1, 2, 40, true)]);
    w.pois.vanEntries = [xy(-200)];
    const run = (input: World) => simulate(prepared(input), site, opts).personas.vendor;
    expect(run(w).score).toBeGreaterThan(90);
    expect(run(w).topFriction).toMatch(/^0 m carry/);
    expect(run({ ...w, loadingPoints: { another: [] } })).toEqual(run(w));
    expect(run({ ...w, loadingPoints: { [site.id]: [] } }).score).toBe(5);
  });

  it('picks the fallback node nearest the stalls rather than the site centre', () => {
    // (0, 52) is 52 m from the centre and 37 m from the stalls; (40, 40) is 57 m and 35 m.
    const w = world([node(-200), node(0, 52), node(40, 40)],
      [edge(0, 1, 210, true), edge(0, 2, 245, true)]);
    w.pois.vanEntries = [xy(-200)];
    const vendor = simulate(prepared(w), site, opts).personas.vendor;
    expect(vendor.topFriction).toMatch(/^35 m carry/);
  });

  it('adds a genuinely new fallback destination around a blocked route with the seed fixed', () => {
    const w = world([node(-200), { ...node(-100), barrier: 'gate' }, node(0), node(-40)],
      [edge(0, 1, 100, true), edge(1, 2, 100, true), edge(0, 3, 160, true)]);
    w.pois.vanEntries = [xy(-200)];
    const pw = prepared(w);
    const base = simulate(pw, site, opts);
    expect(base.personas.vendor.score).toBe(5);
    expect(base.personas.vendor.topFriction).toMatch(/^gate/);
    const added = simulate(pw, site, { ...opts, mitigations: [
      { kind: 'loading_point', lng: xy(-40)[0], lat: xy(-40)[1] },
    ] });
    expect(added.personas.vendor.score).toBeGreaterThan(base.personas.vendor.score + 30);
    expect(added.personas.vendor.topFriction).toMatch(/^25 m carry/);
    expect(simulate(pw, site, { ...opts, mitigations: [
      { kind: 'loading_point', lng: xy(0)[0], lat: xy(0)[1], label: 'Existing fallback' },
    ] }).personas.vendor).toEqual(base.personas.vendor);
  });

  it('reports a missing nearby vehicle road without a NaN distance', () => {
    const w = world([node(0), node(50), node(1400), node(1450)], [edge(0, 1, 50), edge(2, 3, 50, true)]);
    w.pois.vanEntries = [xy(1400)];
    w.loadingPoints = { [site.id]: [] };
    const vendor = simulate(prepared(w), site, opts).personas.vendor;
    expect(vendor.score).toBe(5);
    expect(vendor.topFriction).toMatch(/no vehicle-legal road within 1000 m/);
    expect(vendor.topFriction).not.toContain('NaN');
  });

  it('counts senior accessibility using the selected 180 m or 240 m stop route', () => {
    const w = world([node(0), node(180), node(240, 80), node(500)],
      [edge(0, 1, 180), edge(0, 2, 240), edge(0, 3, 500)]);
    w.pois.stops = [1, 2].map((i) => ({ ...w.graph.nodes[i], name: `Stop ${i}`, mode: 'tram' }));
    const agents = Array.from({ length: 100 }, (_, i) => agent('senior', 3, 30000 + i));
    const shorter = agents.filter((a) => fork(7, `senior:${site.id}:${a.node}:${a.arriveAt}`)() < 0.5).length;
    expect(shorter).toBeGreaterThan(0);
    expect(shorter).toBeLessThan(100);
    const r = simulate(prepared(w, agents), site, opts);
    // Seniors and unserved vendors are the two accessibility groups in this isolated world.
    expect(r.criteria.accessibility).toBe(round1(100 * shorter / agents.length / 2));
  });

  it('starts a six-minute commuter walk at the station exit after the train arrives', () => {
    const w = world([node(0), node(468)], [edge(0, 1, 468)]);
    w.pois.subwayEntrances = [{ ...w.graph.nodes[1], station: 'Test' }];
    const depart = 11.5 * 3600 + P.COMMUTER_EXIT_MIN * 60;
    const r = simulate(prepared(w, [agent('commuter', 1, depart)]), site, opts);
    const trip = r.trips.find((t) => t.persona === 'commuter')!;
    expect(trip.path[0][2]).toBe(depart);
    expect(trip.path[1][2]).toBe(depart + 6 * 60);
  });

  it('carries real train arrival and exit times from the generated pool into commuter trips', () => {
    const w = world([node(0), node(468)], [edge(0, 1, 468)]);
    w.pois.subwayEntrances = [{ ...w.graph.nodes[1], station: 'Test' }];
    const arrivals = [11.5 * 3600, 12 * 3600];
    w.stations = [{ ...w.graph.nodes[1], name: 'Test', mode: 'subway', arrivals }];
    const pw = prepareWorld(w);
    const pool = scenarioPool(pw, opts.scenario, opts.seed, opts.scale);
    const commuters = pool.agents.filter((a) => a.kind === 'commuter');
    const departures = arrivals.map((t) => t + P.COMMUTER_EXIT_MIN * 60);
    expect(commuters).toHaveLength(arrivals.length * P.LUNCH_SHOPPERS_PER_TRAIN);
    expect([...new Set(commuters.map((a) => a.arriveAt))]).toEqual(departures);
    const trips = simulate(pw, site, opts).trips.filter((t) => t.persona === 'commuter');
    expect(trips).toHaveLength(commuters.length);
    expect([...new Set(trips.map((t) => t.path[0][2]))].sort((a, b) => a - b)).toEqual(departures);
    for (const trip of trips) expect(trip.path[1][2] - trip.path[0][2]).toBe(6 * 60);
  });

  it('preserves the original non-kiosk dwell for a one-stall visit', () => {
    const w = world([node(0), node(468)], [edge(0, 1, 468)]);
    w.pois.subwayEntrances = [{ ...w.graph.nodes[1], station: 'Test' }];
    const smallSite = { ...site, areaM2: 250,
      polygon: [xy(-0.5, -0.5), xy(0.5, -0.5), xy(0.5, 0.5), xy(-0.5, 0.5)] };
    const r = simulate(prepared(w, [agent('commuter', 1, 41400)]), smallSite, opts);
    expect(r.stallExposure).toHaveLength(1);
    const trip = r.trips.find((t) => t.persona === 'commuter')!;
    // Trails are simplified, so find the dwell as the segment where the agent stays put.
    const stay = trip.path.findIndex((p, i) => i > 0 && p[0] === trip.path[i - 1][0] && p[1] === trip.path[i - 1][1]);
    expect(trip.path[stay][2] - trip.path[stay - 1][2]).toBe(Math.round(P.COMMUTER_SHOP_MIN * 60 * 0.7));
  });

  it('keeps a kiosk visitor at the kiosk for the full configured service time', () => {
    const w = world([node(0), node(900), node(978)], [edge(0, 1, 900), edge(1, 2, 78)]);
    w.pois.subwayEntrances = [{ ...w.graph.nodes[2], station: 'Test' }];
    const r = simulate(prepared(w, [agent('commuter', 2, 41400)]), site,
      { ...opts, mitigations: [{ kind: 'kiosk', lng: xy(900)[0], lat: xy(900)[1] }] });
    const trip = r.trips.find((t) => t.persona === 'commuter')!;
    expect(trip.path[2].slice(0, 2)).toEqual(trip.path[1].slice(0, 2));
    expect(trip.path[2][2] - trip.path[1][2]).toBe(P.COMMUTER_KIOSK_MIN * 60);
  });
});

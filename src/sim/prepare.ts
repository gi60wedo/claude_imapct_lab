import type { Scenario } from '../contracts';
import type { CostContext } from './cost';
import { shortestPathsTo, pathFrom } from './dijkstra';
import { LocalProjection, pointInPolygon } from './geo';
import { IndexedGraph } from './graph';
import { clock } from './metrics';
import * as P from './params';
import { fork, pickWeighted, stochasticRound, uniform } from './rng';
import type { Mitigation, World } from './world';

export type VisitorKind = 'senior' | 'resident' | 'tourist' | 'commuter';

/** Someone who may visit the market. Whether they do depends on the site. */
export interface PoolAgent {
  kind: VisitorKind;
  node: number;            // where the trip starts (home, hotel, U-Bahn entrance)
  arriveAt: number;        // seconds after midnight: station-exit departure for commuters; preferred market arrival for others
  dwellSec: number;
  station?: string;        // commuters: which station's lunch crowd
  homeX: number; homeY: number;
}

/** A pedestrian who is in the Altstadt anyway. Counts for exposure, crowding and shop spillover. */
export interface Passer { nodes: number[]; edges: number[]; depart: number }

export interface ScenarioPool { agents: PoolAgent[]; passers: Passer[]; ctx: CostContext }

export interface PreparedWorld {
  world: World;
  g: IndexedGraph;
  proj: LocalProjection;
  isWalkNode: (i: number) => boolean;
  isVanNode: (i: number) => boolean;
  edgeMidX: Float64Array;
  edgeMidY: Float64Array;
  entrances: { node: number; station: string; x: number; y: number }[];
  /** Step-free arrival points for seniors: elevators and tram/bus stops. */
  seniorAccess: number[];
  vanEntries: number[];
  shops: { x: number; y: number; node: number }[];
  attractionNodes: number[];
  stations: { name: string; x: number; y: number; mode: 'subway' | 'tram'; arrivals: number[] }[];
  christmasXY: [number, number][];
  christmasEdges: Uint8Array;
  /** Current road conditions (World.roadConditions) baked into per-edge masks. */
  road: { walkFactor: Float32Array; walkClosed: Uint8Array; vanClosed: Uint8Array; edgeCondition: Int16Array };
  pools: Map<string, ScenarioPool>;
}

export function prepareWorld(world: World): PreparedWorld {
  const { nodes } = world.graph;
  let lng = 0, lat = 0;
  for (const n of nodes) { lng += n.lng; lat += n.lat; }
  const proj = new LocalProjection(lng / nodes.length, lat / nodes.length);
  const g = new IndexedGraph(world.graph, proj);
  const isWalkNode = (i: number) => g.hasEdge(i, (e) => e.walk);
  const isStepFreeNode = (i: number) => g.hasEdge(i, (e) => e.walk && !e.steps);
  const isVanNode = (i: number) => g.hasEdge(i, (e) => e.vehicle);

  const edgeMidX = new Float64Array(world.graph.edges.length);
  const edgeMidY = new Float64Array(world.graph.edges.length);
  world.graph.edges.forEach((e, k) => {
    edgeMidX[k] = (g.x[e.a] + g.x[e.b]) / 2;
    edgeMidY[k] = (g.y[e.a] + g.y[e.b]) / 2;
  });

  const snap = (lngLat: [number, number], accept: (i: number) => boolean, maxM = 150) => {
    const [x, y] = proj.toXY(lngLat[0], lngLat[1]);
    return g.nearest(x, y, maxM, accept);
  };

  const entrances = world.pois.subwayEntrances.flatMap((s) => {
    const node = snap([s.lng, s.lat], isWalkNode, 80);
    const [x, y] = proj.toXY(s.lng, s.lat);
    return node >= 0 ? [{ node, station: s.station, x, y }] : [];
  });

  // Road conditions: closures, narrowed or rough stretches, and elevators out of service
  const nEdges = world.graph.edges.length;
  const road = { walkFactor: new Float32Array(nEdges).fill(1), walkClosed: new Uint8Array(nEdges), vanClosed: new Uint8Array(nEdges),
                 edgeCondition: new Int16Array(nEdges).fill(-1) };
  const elevatorsOut: [number, number, number][] = [];
  (world.roadConditions ?? []).forEach((c, ci) => {
    const [cx, cy] = proj.toXY(c.lng, c.lat);
    if (c.effect === 'elevator_out') { elevatorsOut.push([cx, cy, c.radiusM]); return; }
    for (let k = 0; k < nEdges; k++) {
      if (Math.hypot(edgeMidX[k] - cx, edgeMidY[k] - cy) > c.radiusM) continue;
      road.edgeCondition[k] = ci;
      if (c.effect === 'closed') {
        if (c.affects.includes('walk')) road.walkClosed[k] = 1;
        if (c.affects.includes('van')) road.vanClosed[k] = 1;
      } else if (c.affects.includes('walk') || c.affects.includes('senior')) {
        road.walkFactor[k] = Math.max(road.walkFactor[k], c.walkFactor ?? 1.3);
      }
    }
  });
  const elevatorWorks = (i: number) => !elevatorsOut.some(([x, y, r]) => Math.hypot(g.x[i] - x, g.y[i] - y) <= r);

  const seniorAccess = new Set<number>();
  world.graph.nodes.forEach((n, i) => { if (n.elevator && isWalkNode(i) && elevatorWorks(i)) seniorAccess.add(i); });
  for (const p of world.pois.elevators) { const i = snap(p, isStepFreeNode, 40); if (i >= 0 && elevatorWorks(i)) seniorAccess.add(i); }
  for (const s of world.pois.stops) { const i = snap([s.lng, s.lat], isStepFreeNode, 60); if (i >= 0) seniorAccess.add(i); }

  const vanEntries = [...new Set(world.pois.vanEntries.map((p) => snap(p, isVanNode, 200)).filter((i) => i >= 0))];

  const shops = world.pois.shops.flatMap((p) => {
    const node = snap(p, isWalkNode, 60);
    const [x, y] = proj.toXY(p[0], p[1]);
    return node >= 0 ? [{ x, y, node }] : [];
  });
  const attractionNodes = world.pois.attractions.map((p) => snap(p, isWalkNode, 80)).filter((i) => i >= 0);

  const stations = world.stations.map((s) => {
    const [x, y] = proj.toXY(s.lng, s.lat);
    return { name: s.name, x, y, mode: s.mode, arrivals: s.arrivals };
  });

  const christmasXY = world.christmasMarket.map(([a, b]) => proj.toXY(a, b));
  const christmasEdges = new Uint8Array(world.graph.edges.length);
  if (christmasXY.length >= 3) {
    for (let k = 0; k < christmasEdges.length; k++) {
      if (pointInPolygon(edgeMidX[k], edgeMidY[k], christmasXY)) christmasEdges[k] = 1;
    }
  }

  return { world, g, proj, isWalkNode, isVanNode, edgeMidX, edgeMidY, entrances, seniorAccess: [...seniorAccess],
           vanEntries, shops, attractionNodes, stations, christmasXY, christmasEdges, road, pools: new Map() };
}

/** Cost context for a scenario plus mitigations. */
export function scenarioContext(pw: PreparedWorld, scenario: Scenario, mitigations: Mitigation[] = []): CostContext {
  // Current road conditions apply in every scenario; the Christkindlesmarkt adds to them.
  const closed = pw.road.walkClosed.slice();
  const factor = pw.road.walkFactor.slice();
  if (scenario === 'CHRISTMAS_MARKET') {
    pw.world.graph.edges.forEach((e, k) => {
      if (!pw.christmasEdges[k]) return;
      if (e.vehicle && !e.walk) closed[k] = 1;
      factor[k] *= P.CHRISTMAS_CROWD_FACTOR;
    });
  }
  const ctx: CostContext = { rain: scenario === 'RAINY_SAT', snow: scenario === 'SNOWY_SAT', closedEdges: closed, walkFactor: factor, vanClosedEdges: pw.road.vanClosed };
  for (const m of mitigations) if (m.kind === 'delivery_window' && m.unlockRemovableBollards) ctx.unlockRemovableBollards = true;
  return ctx;
}

/** Trains arriving in [from, to) at each subway station. */
function trainsNear(pw: PreparedWorld, from: number, to: number) {
  return pw.stations.filter((s) => s.mode === 'subway')
    .map((s) => ({ s, times: s.arrivals.filter((t) => t >= from && t < to) }));
}

/** Site-independent visitors and passers for a scenario. Cached per scenario × seed × scale. */
export function scenarioPool(pw: PreparedWorld, scenario: Scenario, seed: number, scale: number): ScenarioPool {
  const key = `${scenario}|${seed}|${scale}`;
  const cached = pw.pools.get(key);
  if (cached) return cached;
  const ctx = scenarioContext(pw, scenario);
  const agents: PoolAgent[] = [];
  const tourFactor = scenario === 'CHRISTMAS_MARKET' ? P.CHRISTMAS_TOURIST_FACTOR : 1;

  // Residents and seniors from the Zensus grid
  const rng = fork(seed, `pool:${scenario}`);
  const homeRng = fork(seed, 'homes');
  for (const cell of pw.world.population) {
    const [x, y] = pw.proj.toXY(cell.lng, cell.lat);
    if (Math.hypot(x, y) > P.POOL_RADIUS_M) continue;
    const node = pw.g.nearest(x, y, 150, pw.isWalkNode);
    if (node < 0) continue;
    const seniors = stochasticRound(homeRng, cell.pop * cell.share65 * P.SENIOR_RATE * scale);
    const others = stochasticRound(homeRng, cell.pop * (1 - cell.share65) * P.RESIDENT_RATE * scale);
    for (let i = 0; i < seniors; i++) {
      agents.push({ kind: 'senior', node, homeX: x, homeY: y, arriveAt: uniform(rng, clock('08:00'), clock('11:30')),
                    dwellSec: uniform(rng, 20, 40) * 60 });
    }
    for (let i = 0; i < others; i++) {
      agents.push({ kind: 'resident', node, homeX: x, homeY: y, arriveAt: uniform(rng, clock('08:30'), clock('14:00')),
                    dwellSec: uniform(rng, 15, 35) * 60 });
    }
  }

  // Tourists from attractions
  for (const node of pw.attractionNodes) {
    const n = stochasticRound(rng, P.TOURISTS_PER_ATTRACTION * tourFactor * scale);
    for (let i = 0; i < n; i++) {
      agents.push({ kind: 'tourist', node, homeX: pw.g.x[node], homeY: pw.g.y[node],
                    arriveAt: uniform(rng, clock('10:00'), clock('14:30')), dwellSec: uniform(rng, 10, 25) * 60 });
    }
  }

  // Lunch commuters from U-Bahn arrivals (GTFS) 11:30–13:30
  for (const { s, times } of trainsNear(pw, clock('11:30'), clock('13:30'))) {
    const exits = pw.entrances.filter((e) => e.station === s.name);
    if (exits.length === 0) continue;
    for (const t of times) {
      const n = stochasticRound(rng, P.LUNCH_SHOPPERS_PER_TRAIN * scale);
      for (let i = 0; i < n; i++) {
        const ex = exits[Math.floor(rng() * exits.length)];
        agents.push({ kind: 'commuter', node: ex.node, homeX: ex.x, homeY: ex.y, station: s.name,
                      arriveAt: t + P.COMMUTER_EXIT_MIN * 60, dwellSec: P.COMMUTER_SHOP_MIN * 60 });
      }
    }
  }

  const passers = buildPassers(pw, ctx, scenario, seed, scale, tourFactor);
  const pool = { agents, passers, ctx };
  pw.pools.set(key, pool);
  return pool;
}

function buildPassers(pw: PreparedWorld, ctx: CostContext, scenario: Scenario, seed: number, scale: number,
                      tourFactor: number): Passer[] {
  const rng = fork(seed, `passers:${scenario}`);
  // Destinations: attractions and a spread of shops. One reverse search per hub keeps this cheap.
  const hubRng = fork(seed, 'hubs');
  const hubs = [...new Set([
    ...pw.attractionNodes,
    ...Array.from({ length: Math.min(16, pw.shops.length) }, () => pw.shops[Math.floor(hubRng() * pw.shops.length)].node),
  ])].slice(0, 32);
  if (hubs.length === 0) return [];

  const trips: { origin: number; depart: number }[] = [];
  for (const { s, times } of trainsNear(pw, P.MARKET_OPEN, P.DAY_END)) {
    const exits = pw.entrances.filter((e) => e.station === s.name);
    if (exits.length === 0) continue;
    for (const t of times) {
      const n = stochasticRound(rng, P.PASSERS_PER_TRAIN * scale);
      for (let i = 0; i < n; i++) trips.push({ origin: exits[Math.floor(rng() * exits.length)].node, depart: t });
    }
  }
  for (const node of pw.attractionNodes) {
    const n = stochasticRound(rng, P.PASSERS_PER_ATTRACTION * tourFactor * scale);
    for (let i = 0; i < n; i++) trips.push({ origin: node, depart: uniform(rng, P.MARKET_OPEN, P.DAY_END) });
  }

  const byHub = new Map<number, typeof trips>();
  for (const t of trips) {
    const hub = pickWeighted(rng, hubs, hubs.map((h) => (h === t.origin ? 0 : 1)));
    let list = byHub.get(hub);
    if (!list) byHub.set(hub, (list = []));
    list.push(t);
  }
  const passers: Passer[] = [];
  for (const [hub, list] of [...byHub.entries()].sort((a, b) => a[0] - b[0])) {
    const sp = shortestPathsTo(pw.g, [hub], 'walker', ctx);
    for (const t of list) {
      const p = pathFrom(sp, t.origin);
      if (p.edges.length > 0) passers.push({ ...p, depart: t.depart });
    }
  }
  return passers;
}

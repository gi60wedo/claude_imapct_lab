import type {
  Bottleneck, Candidate, PersonaId, PersonaResult, Scenario, SimulationResult, TimeSlice, Weights,
} from '../contracts';
import type { CostContext } from './cost';
import { pathFrom, shortestPathsTo, type ShortestPaths } from './dijkstra';
import { centroid, distanceToPolygon, pointInPolygon, polygonArea } from './geo';
import { clamp, formatClock, gini, round1 } from './metrics';
import * as P from './params';
import { scenarioContext, scenarioPool, type PreparedWorld } from './prepare';
import { fork, pickWeighted, type Rng } from './rng';
import type { Mitigation } from './world';

export interface SimOptions {
  scenario: Scenario;
  seed: number;
  mitigations?: Mitigation[];
  /** Share of people simulated as agents (default 0.25). */
  scale?: number;
  /** Trails returned for the map (default 100). */
  maxTrips?: number;
}

type TripKind = 'senior' | 'commuter' | 'vendor' | 'visitor' | 'passer';

/** A moving agent: polyline with a timestamp per vertex and the graph edge of each segment (-1 off-graph). */
interface Trip { kind: TripKind; xs: number[]; ys: number[]; ts: number[]; seg: number[] }

const SLICE_IDS = Object.keys(P.SLICES) as TimeSlice[];

export function describeMitigation(m: Mitigation): string {
  if (m.label) return m.label;
  switch (m.kind) {
    case 'kiosk': return `Express kiosk at ${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}`;
    case 'delivery_window': return 'Delivery window 05:00–07:00 with removable bollards lowered';
    case 'loading_point': return `Designated loading point at ${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}`;
    case 'stall_layout': return m.layout === 'loop' ? 'Loop stall layout with one circulation route' : 'Clustered stall layout';
  }
}

export function simulate(pw: PreparedWorld, cand: Candidate, opts: SimOptions): SimulationResult {
  const { scenario, seed } = opts;
  const mitigations = opts.mitigations ?? [];
  const scale = opts.scale ?? P.DEFAULT_SCALE;
  const up = 1 / scale;
  const g = pw.g;
  const edges = pw.world.graph.edges;
  const pool = scenarioPool(pw, scenario, seed, scale);
  const ctx = scenarioContext(pw, scenario, mitigations);
  const rng = fork(seed, `site:${cand.id}:${scenario}`);
  const rain = scenario === 'RAINY_SAT';
  const sheltered = cand.kind === 'ground_floor';

  // ── Site geometry ────────────────────────────────────────────────────────────
  const poly = cand.polygon.map(([lng, lat]) => pw.proj.toXY(lng, lat));
  const [cx, cy] = centroid(poly);
  const reach = Math.max(...poly.map(([x, y]) => Math.hypot(x - cx, y - cy)));
  const distPoly = (x: number, y: number) => distanceToPolygon(x, y, poly);
  const area = cand.areaM2 > 0 ? cand.areaM2 : polygonArea(poly);
  let slots = layoutStalls(poly, area);
  if (scenario === 'CHRISTMAS_MARKET' && pw.christmasXY.length >= 3) {
    slots = slots.filter(([x, y]) => !pointInPolygon(x, y, pw.christmasXY));
  }
  const siteAvailable = slots.length > 0;

  let entries = g.nodesWithin(cx, cy, reach + P.ENTRY_RADIUS_M,
    (i) => pw.isWalkNode(i) && distPoly(g.x[i], g.y[i]) <= P.ENTRY_RADIUS_M);
  if (entries.length === 0) entries = [g.nearest(cx, cy, 400, pw.isWalkNode)].filter((i) => i >= 0);

  const spWalk = shortestPathsTo(g, entries, 'walker', ctx);
  const spSenior = shortestPathsTo(g, entries, 'senior', ctx);
  const kioskNodes = mitigations.flatMap((m) => {
    if (m.kind !== 'kiosk') return [];
    const [x, y] = pw.proj.toXY(m.lng, m.lat);
    const i = g.nearest(x, y, 100, pw.isWalkNode);
    return i >= 0 ? [i] : [];
  });
  const spKioskWalk = kioskNodes.length ? shortestPathsTo(g, kioskNodes, 'walker', ctx) : null;
  const spKioskSenior = kioskNodes.length ? shortestPathsTo(g, kioskNodes, 'senior', ctx) : null;

  const pathLength = (es: number[]) => es.reduce((s, k) => s + edges[k].lengthM, 0);
  const trips: Trip[] = [];
  const visitorTrips: { trip: Trip; legNodes: number[]; legEdges: number[]; kind: TripKind }[] = [];
  const slotVisits = new Float64Array(slots.length);
  const layout = mitigations.find((m) => m.kind === 'stall_layout')?.layout ?? 'cluster';

  /** Walk to the market (or kiosk), browse, walk back. Returns the trip so callers can tag it. */
  const visit = (kind: TripKind, sp: ShortestPaths, origin: number, arriveAt: number, dwellSec: number,
                 senior: boolean, atKiosk: boolean, r: Rng) => {
    const leg = pathFrom(sp, origin);
    if (leg.nodes.length === 0) return;
    const out = walkTrip(pw, ctx, leg.nodes, leg.edges, 0, senior);
    const travel = out.ts[out.ts.length - 1];
    const depart = kind === 'commuter' ? arriveAt : Math.max(P.MARKET_OPEN - 1800, arriveAt - travel);
    const trip: Trip = { kind, xs: [], ys: [], ts: [], seg: [] };
    appendShifted(trip, out, depart);
    const end = leg.nodes[leg.nodes.length - 1];
    let t = trip.ts[trip.ts.length - 1];
    let remainingDwell = dwellSec;
    if (!atKiosk && siteAvailable) {
      const visited = chooseStalls(r, slots, g.x[end], g.y[end], layout, 4);
      for (const s of visited) {
        slotVisits[s] += up;
        const pause = dwellSec / (visited.length + 1);
        t += pause;
        remainingDwell -= pause;
        pushPoint(trip, slots[s][0], slots[s][1], t, -1);
      }
    }
    t += remainingDwell;
    pushPoint(trip, g.x[end], g.y[end], t, -1);
    const back = walkTrip(pw, ctx, [...leg.nodes].reverse(), [...leg.edges].reverse(), 0, senior);
    appendShifted(trip, back, t);
    trips.push(trip);
    visitorTrips.push({ trip, legNodes: leg.nodes, legEdges: leg.edges, kind });
  };

  // ── Seniors (Oma Helga) ──────────────────────────────────────────────────────
  // Beyond her walking budget she rides to a step-free stop or elevator; equally good ones share the load.
  const access = pw.seniorAccess
    .map((a) => {
      const kiosk = (spKioskSenior?.dist[a] ?? Infinity) < spSenior.dist[a];
      return { a, kiosk, cost: kiosk ? spKioskSenior!.dist[a] : spSenior.dist[a] };
    })
    .filter((o) => o.cost < Infinity)
    .sort((x, y) => x.cost - y.cost);
  const accessChoices = access.filter((o) => o.cost <= access[0].cost + 100).slice(0, 4);
  const transitLenM = access.length
    ? pathLength(pathFrom(access[0].kiosk ? spKioskSenior! : spSenior, access[0].a).edges) : Infinity;
  const transitWithinRadius = transitLenM <= P.SENIOR_TRANSIT_RADIUS_M;

  const seniors = pool.agents.filter((a) => a.kind === 'senior');
  let seniorExpected = 0, seniorAccessible = 0, seniorServed = 0, seniorNoAccess = 0;
  const seniorPathEdges: number[][] = [];
  for (const a of seniors) {
    const r = fork(seed, `senior:${cand.id}:${a.node}:${a.arriveAt}`);
    const viaKiosk = (spKioskSenior?.dist[a.node] ?? Infinity) < spSenior.dist[a.node];
    const homeCost = viaKiosk ? spKioskSenior!.dist[a.node] : spSenior.dist[a.node];
    let origin = -1, d = Infinity, kiosk = false, accessible = false;
    if (homeCost <= P.SENIOR_WALK_BUDGET_M) {
      origin = a.node; d = homeCost; kiosk = viaKiosk; accessible = true;
    } else if (accessChoices.length) {
      const o = accessChoices[Math.floor(r() * accessChoices.length)];
      origin = o.a; d = o.cost; kiosk = o.kiosk;
      accessible = pathLength(pathFrom(kiosk ? spKioskSenior! : spSenior, origin).edges) <= P.SENIOR_TRANSIT_RADIUS_M;
    }
    if (!accessible) seniorNoAccess++;
    if (origin < 0 || (!siteAvailable && !kiosk)) continue;
    // §6: p_drop = max(0, (D_effective − 200) / 100 × 0.15), D_effective = senior route cost
    let pDrop = Math.min(1, Math.max(0, ((d - P.SENIOR_DROP_START_M) / 100) * P.SENIOR_DROP_PER_100M));
    if (rain && !sheltered && !kiosk) pDrop = 1 - (1 - pDrop) * (1 - P.SENIOR_RAIN_DROP);
    seniorExpected += 1 - pDrop;
    if (accessible) seniorAccessible += 1 - pDrop;
    if (r() < 1 - pDrop) {
      const sp = kiosk ? spKioskSenior! : spSenior;
      seniorServed++;
      visit('senior', sp, origin, a.arriveAt, a.dwellSec, true, kiosk, r);
      seniorPathEdges.push(pathFrom(sp, origin).edges);
    }
  }

  // ── Residents and tourists ───────────────────────────────────────────────────
  let visitorExpected = 0, visitorPool = 0, visitorServed = 0;
  for (const a of pool.agents) {
    if (a.kind !== 'resident' && a.kind !== 'tourist') continue;
    visitorPool++;
    const d = spWalk.dist[a.node];
    const budget = a.kind === 'resident' ? P.RESIDENT_BUDGET_M : P.TOURIST_BUDGET_M;
    const decay = a.kind === 'resident' ? 0.5 : 0.6;
    let p = siteAvailable && d <= budget ? 1 - (decay * d) / budget : 0;
    if (rain && !sheltered) p *= P.RAIN_DEMAND_OUTDOOR;
    visitorExpected += p;
    const r = fork(seed, `${a.kind}:${cand.id}:${a.node}:${a.arriveAt}`);
    if (r() < p) {
      visitorServed++;
      visit('visitor', spWalk, a.node, a.arriveAt, a.dwellSec, false, false, r);
    }
  }

  // ── Lunch commuters (Lukas) ──────────────────────────────────────────────────
  // Lukas gets off at the U-Bahn station nearest the site (§6: walk from the real entrance). Stations within
  // COMMUTER_TIE_MIN of the nearest share the lunch crowd. Commuters from farther stations count as passers.
  const minutes = (cost: number) => cost / (P.WALK_SPEED * 60);
  const stationWalk = new Map<string, number>();
  for (const e of pw.entrances) stationWalk.set(e.station, Math.min(stationWalk.get(e.station) ?? Infinity, minutes(spWalk.dist[e.node])));
  const nearestWalk = Math.min(...stationWalk.values());
  const homeStations = new Set([...stationWalk].filter(([, m]) => m <= nearestWalk + P.COMMUTER_TIE_MIN).map(([s]) => s));
  const commuters = pool.agents.filter((a) => a.kind === 'commuter' && homeStations.has(a.station!));
  let commuterScoreSum = 0, commuterServed = 0;
  const commuterWalks: { min: number; station: string }[] = [];
  for (const a of commuters) {
    const fits = (walkMin: number, serviceMin: number) =>
      P.COMMUTER_EXIT_MIN + 2 * walkMin + serviceMin <= P.COMMUTER_BREAK_MIN;
    const mWalk = siteAvailable ? minutes(spWalk.dist[a.node]) : Infinity;
    const kWalk = spKioskWalk ? minutes(spKioskWalk.dist[a.node]) : Infinity;
    let walkMin = mWalk, ok = false, kiosk = false;
    if (fits(mWalk, P.COMMUTER_SHOP_MIN)) ok = true;
    else if (fits(kWalk, P.COMMUTER_KIOSK_MIN)) { ok = true; kiosk = true; walkMin = kWalk; }
    commuterScoreSum += Math.max(0.1, 1 - Math.min(walkMin, kWalk) / 10);
    commuterWalks.push({ min: Math.min(walkMin, kWalk), station: a.station! });
    if (ok) {
      commuterServed++;
      const r = fork(seed, `commuter:${cand.id}:${a.node}:${a.arriveAt}`);
      visit('commuter', kiosk ? spKioskWalk! : spWalk, a.node, a.arriveAt,
            (kiosk ? P.COMMUTER_KIOSK_MIN : P.COMMUTER_SHOP_MIN) * 60, false, kiosk, r);
    }
  }

  // ── Passers: exposure and impulse visits ─────────────────────────────────────
  const nearSite = new Uint8Array(g.n);
  for (const i of g.nodesWithin(cx, cy, reach + P.EXPOSURE_RADIUS_M)) {
    if (distPoly(g.x[i], g.y[i]) <= P.EXPOSURE_RADIUS_M) nearSite[i] = 1;
  }
  let exposedPassers = 0;
  const passerRng = fork(seed, `impulse:${cand.id}:${scenario}`);
  for (const ps of pool.passers) {
    const trip = walkTrip(pw, ctx, ps.nodes, ps.edges, ps.depart, false);
    trip.kind = 'passer';
    trips.push(trip);
    const hit = ps.nodes.find((i) => nearSite[i]);
    if (hit === undefined) continue;
    exposedPassers++;
    if (siteAvailable && passerRng() < IMPULSE_SHARE(rain, sheltered)) {
      for (const s of chooseStalls(passerRng, slots, g.x[hit], g.y[hit], layout, 2)) slotVisits[s] += up;
    }
  }

  // ── Vendors (Markus) ─────────────────────────────────────────────────────────
  const vendor = simulateVans(pw, ctx, mitigations, cand.id, poly, cx, cy, reach, siteAvailable, slots.length, trips, rng);

  // ── Ticks: heat, crowding, elevators ─────────────────────────────────────────
  const ticks = runTicks(pw, trips, up);

  // ── Criteria and persona scores ──────────────────────────────────────────────
  const seniorScore = seniors.length ? (100 * seniorExpected) / seniors.length : 0;
  const commuterScore = commuters.length ? (100 * commuterScoreSum) / commuters.length : 0;

  const walkStats = walkability(pw, visitorTrips.map((v) => v.legEdges));
  const local = localBusiness(pw, poly, cx, cy, reach, visitorTrips, sheltered, up);

  const groupShares = [
    seniors.length ? seniorAccessible / seniors.length : null,
    commuters.length ? commuterServed / commuters.length : null,
    visitorPool ? visitorExpected / visitorPool : null,
    vendor.total ? vendor.served / vendor.total : null,
  ].filter((v): v is number => v !== null);
  const exposure = (seniorServed + visitorServed + commuterServed + exposedPassers) * up;

  const criteria: Weights = {
    accessibility: round1(100 * mean(groupShares)),
    footfall: round1(100 * (1 - Math.exp(-exposure / P.FOOTFALL_REF))),
    fairness: round1(siteAvailable ? 100 * (1 - gini([...slotVisits])) : 0),
    localBusiness: round1(local.aggregate),
    walkability: round1(walkStats.score),
  };

  const seniorFriction = !siteAvailable ? 'Christkindlesmarkt occupies the site'
    : seniors.length && seniorNoAccess / seniors.length >= 0.3 && !transitWithinRadius
      ? `no step-free stop or elevator within ${P.SENIOR_TRANSIT_RADIUS_M} m (nearest ${Number.isFinite(transitLenM) ? Math.round(transitLenM) + ' m' : 'unreachable'})`
      : topCobble(pw, seniorPathEdges) ?? (rain && !sheltered ? 'open square in the rain' : `${Math.round(transitLenM)} m step-free walk from the nearest stop`);

  const medianWalk = commuterWalks.length ? [...commuterWalks].sort((a, b) => a.min - b.min)[Math.floor(commuterWalks.length / 2)] : null;

  const personas: Record<PersonaId, PersonaResult> = {
    senior: { score: round1(seniorScore), served: Math.round(seniorServed * up),
              droppedOut: Math.round((seniors.length - seniorServed) * up), topFriction: seniorFriction },
    vendor: { score: round1(vendor.score), served: vendor.served, droppedOut: vendor.total - vendor.served,
              topFriction: vendor.friction },
    commuter: { score: round1(commuterScore), served: Math.round(commuterServed * up),
                droppedOut: Math.round((commuters.length - commuterServed) * up),
                topFriction: !siteAvailable ? 'Christkindlesmarkt occupies the site'
                  : medianWalk ? `${medianWalk.min.toFixed(1)}-min walk from ${medianWalk.station} U-Bahn exit` : 'no U-Bahn station nearby' },
    retailer: siteAvailable ? local.persona : { ...local.persona, topFriction: 'Christkindlesmarkt occupies the site' },
  };

  return {
    candidateId: cand.id, scenario, seed,
    mitigations: mitigations.map(describeMitigation),
    criteria,
    personas,
    bySlice: Object.fromEntries(SLICE_IDS.map((id) => [id, {
      heat: ticks.heat[id],
      bottlenecks: [...(id === '05:30_DELIVERY' ? vendor.bottlenecks : []), ...ticks.bottlenecks[id]]
        .sort((a, b) => b.severity - a.severity).slice(0, 12),
    }])) as SimulationResult['bySlice'],
    stallExposure: [...slotVisits].map((v) => Math.round(v)),
    trips: sampleTrips(pw, trips, opts.maxTrips ?? 100, fork(seed, `trails:${cand.id}`)),
  };
}

const IMPULSE_SHARE = (rain: boolean, sheltered: boolean) =>
  P.IMPULSE_VISIT_SHARE * (rain && !sheltered ? P.RAIN_DEMAND_OUTDOOR : 1);

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// ── Trips ──────────────────────────────────────────────────────────────────────

function pushPoint(t: Trip, x: number, y: number, ts: number, segToHere: number) {
  if (t.xs.length > 0) t.seg.push(segToHere);
  t.xs.push(x); t.ys.push(y); t.ts.push(ts);
}

function appendShifted(dst: Trip, src: Trip, offset: number) {
  for (let i = 0; i < src.xs.length; i++) pushPoint(dst, src.xs[i], src.ys[i], src.ts[i] + offset, i === 0 ? -1 : src.seg[i - 1]);
}

function walkTrip(pw: PreparedWorld, ctx: CostContext, nodes: number[], edges: number[], t0: number, senior: boolean): Trip {
  const trip: Trip = { kind: senior ? 'senior' : 'visitor', xs: [], ys: [], ts: [], seg: [] };
  let t = t0;
  pushPoint(trip, pw.g.x[nodes[0]], pw.g.y[nodes[0]], t, -1);
  for (let i = 0; i < edges.length; i++) {
    const e = pw.world.graph.edges[edges[i]];
    const speed = senior ? P.SENIOR_SPEED / (e.surface === 'cobble' ? P.SENIOR_COBBLE_SLOWDOWN : 1) : P.WALK_SPEED;
    t += (e.lengthM / speed) * (ctx.walkFactor?.[edges[i]] || 1);
    pushPoint(trip, pw.g.x[nodes[i + 1]], pw.g.y[nodes[i + 1]], t, edges[i]);
  }
  return trip;
}

function sampleTrips(pw: PreparedWorld, trips: Trip[], max: number, rng: Rng): SimulationResult['trips'] {
  const pick = (kind: TripKind, n: number) => {
    const list = trips.filter((t) => t.kind === kind);
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    return list.slice(0, n);
  };
  const vans = pick('vendor', Math.min(20, max));
  const rest = max - vans.length;
  const chosen: [PersonaId, Trip][] = [
    ...vans.map((t) => ['vendor', t] as [PersonaId, Trip]),
    ...pick('senior', Math.ceil(rest / 2)).map((t) => ['senior', t] as [PersonaId, Trip]),
    ...pick('commuter', Math.floor(rest / 2)).map((t) => ['commuter', t] as [PersonaId, Trip]),
  ];
  return chosen.map(([persona, t]) => ({
    persona,
    path: t.xs.map((x, i) => {
      const [lng, lat] = pw.proj.toLngLat(x, t.ys[i]);
      return [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6, Math.round(t.ts[i])] as [number, number, number];
    }),
  }));
}

// ── Stalls ─────────────────────────────────────────────────────────────────────

/** Stall slots on a grid inside the site polygon. */
export function layoutStalls(poly: [number, number][], area: number): [number, number][] {
  const n = Math.round(clamp(area / P.STALL_M2, P.MIN_STALLS, P.MAX_STALLS));
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  let spacing = Math.sqrt(Math.max(area, 1) / n);
  let best: [number, number][] = [];
  for (let attempt = 0; attempt < 8 && best.length < n; attempt++) {
    const pts: [number, number][] = [];
    for (let y = minY + spacing / 2; y < maxY; y += spacing) {
      for (let x = minX + spacing / 2; x < maxX; x += spacing) if (pointInPolygon(x, y, poly)) pts.push([x, y]);
    }
    if (pts.length > best.length) best = pts;
    spacing *= 0.8;
  }
  if (best.length > n) {
    const step = best.length / n;
    best = Array.from({ length: n }, (_, i) => best[Math.floor(i * step)]);
  }
  if (best.length === 0) {
    const [cx, cy] = centroid(poly);
    best = Array.from({ length: n }, (_, i) => [cx + 3 * Math.cos(i), cy + 3 * Math.sin(i)] as [number, number]);
  }
  return best;
}

/** Visitors browse stalls near where they enter; a loop layout walks everyone past most stalls. */
function chooseStalls(r: Rng, slots: [number, number][], x: number, y: number, layout: 'cluster' | 'loop', k: number): number[] {
  const lambda = layout === 'loop' ? 150 : 25;
  const idx = slots.map((_, i) => i);
  const w = slots.map(([sx, sy]) => Math.exp(-Math.hypot(sx - x, sy - y) / lambda));
  const out: number[] = [];
  for (let j = 0; j < Math.min(k, slots.length); j++) {
    const s = pickWeighted(r, idx, w);
    out.push(s);
    w[s] = 0;
  }
  return out;
}

// ── Vans ───────────────────────────────────────────────────────────────────────

function simulateVans(pw: PreparedWorld, ctx: CostContext, mitigations: Mitigation[], candidateId: string, poly: [number, number][],
                      cx: number, cy: number, reach: number, siteAvailable: boolean, stalls: number,
                      trips: Trip[], rng: Rng) {
  const g = pw.g;
  const nodes = pw.world.graph.nodes;
  const edges = pw.world.graph.edges;
  const total = Math.round(clamp(stalls / 2, 6, 20));
  const bottlenecks: Bottleneck[] = [];
  const distPoly = (i: number) => distanceToPolygon(g.x[i], g.y[i], poly);

  const loading = g.nodesWithin(cx, cy, reach + P.VENDOR_MAX_CARRY_M,
    (i) => nodes[i].loadingPoint === true && pw.isVanNode(i) && distPoly(i) <= P.VENDOR_MAX_CARRY_M);
  const addLoadingPoint = (lng: number, lat: number) => {
    const [x, y] = pw.proj.toXY(lng, lat);
    const i = g.nearest(x, y, 60, pw.isVanNode);
    if (i >= 0 && distPoly(i) <= P.VENDOR_MAX_CARRY_M && !loading.includes(i)) loading.push(i);
  };
  for (const [lng, lat] of pw.world.loadingPoints?.[candidateId] ?? []) addLoadingPoint(lng, lat);
  for (const m of mitigations) {
    if (m.kind !== 'loading_point') continue;
    addLoadingPoint(m.lng, m.lat);
  }
  const fail = (friction: string) => ({ score: 5, served: 0, total, friction, bottlenecks });
  if (!siteAvailable) return fail('Christkindlesmarkt occupies the site');
  if (pw.vanEntries.length === 0) return fail('no van entry point in the data');

  if (loading.length === 0) {
    const nearest = g.nearest(cx, cy, 1000, pw.isVanNode);
    const d = nearest >= 0 ? Math.round(distPoly(nearest)) : NaN;
    if (d > P.VENDOR_MAX_CARRY_M) {
      return fail(`nearest vehicle-legal road is ${d} m from the stalls (limit ${P.VENDOR_MAX_CARRY_M} m)`);
    }
    return fail(`no designated loading point within ${P.VENDOR_MAX_CARRY_M} m of the stalls (nearest vehicle-legal road ${d} m)`);
  }

  const sp = shortestPathsTo(g, loading, 'van', ctx, { sourceCost: loading.map((i) => 3 * distPoly(i)) });
  const reachable = pw.vanEntries.filter((e) => sp.dist[e] < Infinity);

  if (reachable.length === 0) {
    // Find what blocks them: route as if barriers were open, and report the first barrier on the way.
    const free = shortestPathsTo(g, loading, 'van', { ...ctx, ignoreBarriers: true }, { sourceCost: loading.map((i) => 3 * distPoly(i)) });
    const entry = pw.vanEntries.reduce((b, e) => (free.dist[e] < free.dist[b] ? e : b), pw.vanEntries[0]);
    const path = pathFrom(free, entry);
    let t = P.DAY_START;
    const trip: Trip = { kind: 'vendor', xs: [], ys: [], ts: [], seg: [] };
    if (path.nodes.length) pushPoint(trip, g.x[path.nodes[0]], g.y[path.nodes[0]], t, -1);
    for (let i = 0; i < path.edges.length; i++) {
      const next = path.nodes[i + 1];
      t += edges[path.edges[i]].lengthM / P.VENDOR_DRIVE_SPEED;
      if (nodes[next].barrier) {
        const name = edges[path.edges[i]].name ?? 'an unnamed lane';
        const kind = nodes[next].barrier === 'gate' ? 'gate' : 'bollard';
        pushPoint(trip, g.x[next], g.y[next], t, path.edges[i]);
        trips.push(trip);
        bottlenecks.push({ lng: nodes[next].lng, lat: nodes[next].lat, severity: 1, type: 'BOLLARD_BLOCKAGE',
                           time: formatClock(t), cause: `${kind} on ${name} stops the 3.5 t van` });
        return fail(`${kind} at ${name} ${formatClock(t)}`);
      }
      pushPoint(trip, g.x[next], g.y[next], t, path.edges[i]);
    }
    return fail('no vehicle-legal route to a loading point');
  }

  let scoreSum = 0, served = 0;
  let worst = '';
  let worstCarry = -1;
  for (let v = 0; v < total; v++) {
    const weights = reachable.map((e) => Math.exp(-sp.dist[e] / 500));
    const entry = pickWeighted(rng, reachable, weights);
    const path = pathFrom(sp, entry);
    const load = path.nodes[path.nodes.length - 1];
    const carry = distPoly(load);
    let t = P.DAY_START + (v * 45 * 60) / total;
    const trip: Trip = { kind: 'vendor', xs: [], ys: [], ts: [], seg: [] };
    pushPoint(trip, g.x[entry], g.y[entry], t, -1);
    for (let i = 0; i < path.edges.length; i++) {
      t += edges[path.edges[i]].lengthM / P.VENDOR_DRIVE_SPEED;
      pushPoint(trip, g.x[path.nodes[i + 1]], g.y[path.nodes[i + 1]], t, path.edges[i]);
    }
    const unload = P.VENDOR_SETUP_MIN * 60 +
      (P.VENDOR_CRATES / P.VENDOR_CRATES_PER_TRIP) * ((2 * carry) / P.VENDOR_CARRY_SPEED);
    const done = t + unload;
    pushPoint(trip, g.x[load], g.y[load], done, -1);
    trips.push(trip);
    const late = Math.max(0, (done - P.VENDOR_SOFT_DEADLINE) / 60);
    let s = 100 * (1 - (0.5 * carry) / P.VENDOR_MAX_CARRY_M) - 2 * late;
    if (done > P.VENDOR_HARD_DEADLINE) s = Math.min(s, 30);
    else served++;
    scoreSum += clamp(s, 5, 100);
    if (carry > worstCarry) {
      worstCarry = carry;
      const street = edges[path.edges[path.edges.length - 1]]?.name;
      worst = done > P.VENDOR_HARD_DEADLINE
        ? `unloading runs to ${formatClock(done)}, past 07:00`
        : `${Math.round(carry)} m carry from the loading point${street ? ' on ' + street : ''}`;
    }
  }
  return { score: scoreSum / total, served, total, friction: worst, bottlenecks };
}

// ── Ticks ──────────────────────────────────────────────────────────────────────

function runTicks(pw: PreparedWorld, trips: Trip[], up: number) {
  const edges = pw.world.graph.edges;
  const nodes = pw.world.graph.nodes;
  const heat = {} as Record<TimeSlice, [number, number, number][]>;
  const bottlenecks = {} as Record<TimeSlice, Bottleneck[]>;
  const count = new Int32Array(edges.length);
  const sorted = [...trips].sort((a, b) => a.ts[0] - b.ts[0]);

  for (const slice of SLICE_IDS) {
    const [from, to] = P.SLICES[slice];
    const bins = new Map<number, number>();
    const peak = new Map<number, { sev: number; t: number; people: number }>();
    const elevatorUse = new Map<number, Map<number, number>>();   // node → 5-min window → seniors
    const cobbleUse = new Map<number, number>();
    let seniorTrips = 0;
    const active = sorted.filter((t) => t.ts[t.ts.length - 1] >= from && t.ts[0] <= to);
    const ptr = new Int32Array(active.length);
    let nTicks = 0;

    for (let t = from; t <= to; t += P.TICK_SEC) {
      nTicks++;
      const touched: number[] = [];
      for (let a = 0; a < active.length; a++) {
        const tr = active[a];
        const last = tr.ts.length - 1;
        if (t < tr.ts[0] || t > tr.ts[last]) continue;
        let i = ptr[a];
        while (i < last - 1 && tr.ts[i + 1] < t) i++;
        ptr[a] = i;
        const span = tr.ts[i + 1] - tr.ts[i];
        const f = span > 0 ? (t - tr.ts[i]) / span : 0;
        const x = tr.xs[i] + f * (tr.xs[i + 1] - tr.xs[i]);
        const y = tr.ys[i] + f * (tr.ys[i + 1] - tr.ys[i]);
        const key = (Math.floor(x / P.HEAT_CELL_M) + 5000) * 10000 + Math.floor(y / P.HEAT_CELL_M) + 5000;
        bins.set(key, (bins.get(key) ?? 0) + 1);
        const e = tr.seg[i];
        if (e >= 0 && tr.kind !== 'vendor') {
          if (count[e] === 0) touched.push(e);
          count[e]++;
        }
      }
      for (const e of touched) {
        const ed = edges[e];
        const people = count[e] * up;
        const sev = people / (Math.max(ed.lengthM, P.MIN_EDGE_AREA_M) * Math.max(ed.widthM, 1)) / P.CROWD_DENSITY_FULL;
        const prev = peak.get(e);
        if (!prev || sev > prev.sev) peak.set(e, { sev, t, people });
        count[e] = 0;
      }
    }

    // Senior-specific frictions: cobbles walked and elevators used inside this slice.
    for (const tr of active) {
      if (tr.kind !== 'senior') continue;
      let inSlice = false;
      const cobbled = new Set<number>();
      for (let i = 0; i < tr.seg.length; i++) {
        if (tr.ts[i] < from || tr.ts[i] > to) continue;
        inSlice = true;
        const e = tr.seg[i];
        if (e < 0) continue;
        const ed = edges[e];
        if (ed.surface === 'cobble' && !cobbled.has(e)) { cobbled.add(e); cobbleUse.set(e, (cobbleUse.get(e) ?? 0) + 1); }
        for (const n of [ed.a, ed.b]) {
          if (!nodes[n].elevator) continue;
          const w = Math.floor(tr.ts[i] / 300);
          const m = elevatorUse.get(n) ?? new Map<number, number>();
          m.set(w, (m.get(w) ?? 0) + 1);
          elevatorUse.set(n, m);
        }
      }
      if (inSlice) seniorTrips++;
    }

    const out: Bottleneck[] = [];
    for (const [e, p] of peak) {
      if (p.sev < 0.25) continue;
      const ed = edges[e];
      const [lng, lat] = pw.proj.toLngLat(pw.edgeMidX[e], pw.edgeMidY[e]).map(round6);
      out.push({ lng, lat, severity: round2(Math.min(1, p.sev)), type: 'CROWDING', time: formatClock(p.t),
                 cause: `${Math.round(p.people)} people on ${ed.name ?? 'a path'} (${ed.widthM} m wide)` });
    }
    for (const [e, n] of cobbleUse) {
      const share = seniorTrips ? n / seniorTrips : 0;
      if (share < 0.15) continue;
      const ed = edges[e];
      const [lng, lat] = pw.proj.toLngLat(pw.edgeMidX[e], pw.edgeMidY[e]).map(round6);
      out.push({ lng, lat, severity: round2(Math.min(1, share)), type: 'COBBLESTONE_FRICTION', time: formatClock(from),
                 cause: `${Math.round(share * 100)} % of seniors cross cobblestones on ${ed.name ?? 'a lane'}` });
    }
    for (const [n, windows] of elevatorUse) {
      let best = 0, bestW = 0;
      for (const [w, c] of windows) if (c > best) { best = c; bestW = w; }
      const sev = (best * up) / P.ELEVATOR_CAPACITY_5MIN;
      if (sev < 0.3) continue;
      out.push({ lng: nodes[n].lng, lat: nodes[n].lat, severity: round2(Math.min(1, sev)), type: 'ELEVATOR_CONGESTION',
                 time: formatClock(bestW * 300), cause: `${Math.round(best * up)} seniors in 5 min at one elevator` });
    }
    bottlenecks[slice] = out.sort((a, b) => b.severity - a.severity).slice(0, 12);

    heat[slice] = [...bins.entries()].map(([key, c]) => {
      const bx = Math.floor(key / 10000) - 5000;
      const by = (key % 10000) - 5000;
      const [lng, lat] = pw.proj.toLngLat((bx + 0.5) * P.HEAT_CELL_M, (by + 0.5) * P.HEAT_CELL_M);
      return [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6, round2((c * up) / nTicks)] as [number, number, number];
    });
  }
  return { heat, bottlenecks };
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

// ── Criteria helpers ───────────────────────────────────────────────────────────

function walkability(pw: PreparedWorld, legs: number[][]) {
  const edges = pw.world.graph.edges;
  let len = 0, cobble = 0, road = 0, slope = 0, steps = 0;
  for (const leg of legs) {
    for (const k of leg) {
      const e = edges[k];
      len += e.lengthM;
      if (e.surface !== 'smooth') cobble += e.lengthM;
      if (e.vehicle) road += e.lengthM;
      if (e.steps) steps++;
      slope += e.slope * e.lengthM;
    }
  }
  if (len === 0) return { score: 0 };
  const stepsPerTrip = steps / Math.max(1, legs.length);
  const score = 100 - 40 * (cobble / len) - 20 * Math.min(1, stepsPerTrip) - 500 * Math.max(0, slope / len - 0.02) - 20 * (road / len);
  return { score: clamp(score) };
}

function localBusiness(pw: PreparedWorld, poly: [number, number][], cx: number, cy: number, reach: number,
                       visitorTrips: { legNodes: number[] }[], sheltered: boolean, up: number) {
  const nearby = pw.shops.filter((s) => {
    if (Math.hypot(s.x - cx, s.y - cy) > reach + P.FRONTAGE_RADIUS_M) return false;
    const d = distanceToPolygon(s.x, s.y, poly);
    return d > 0 && d <= P.FRONTAGE_RADIUS_M;
  });
  if (nearby.length === 0) {
    return { aggregate: 0, persona: { score: 0, served: 0, droppedOut: 0, topFriction: `no shops within ${P.FRONTAGE_RADIUS_M} m` } as PersonaResult };
  }
  // Which shops each graph node passes in front of
  const shopsAt = new Map<number, number[]>();
  nearby.forEach((s, k) => {
    for (const n of pw.g.nodesWithin(s.x, s.y, P.SHOP_PASS_RADIUS_M)) {
      const list = shopsAt.get(n) ?? [];
      list.push(k);
      shopsAt.set(n, list);
    }
  });
  const passes = new Float64Array(nearby.length);
  for (const v of visitorTrips) {
    const seen = new Set<number>();
    for (const n of v.legNodes) for (const k of shopsAt.get(n) ?? []) seen.add(k);
    for (const k of seen) passes[k] += 2 * up;   // there and back
  }
  // 50 = no change for the shop; spillover adds up to +50, a blocked window costs 40, produce waste costs a little.
  const waste = sheltered ? 0 : 5;
  let blocked = 0;
  const scores = nearby.map((s, k) => {
    const isBlocked = distanceToPolygon(s.x, s.y, poly) <= P.BLOCKED_FRONTAGE_M;
    if (isBlocked) blocked++;
    const gain = 50 * (1 - Math.exp(-passes[k] / P.LOCAL_BUSINESS_REF));
    return { induced: passes[k], score: clamp(50 + gain - (isBlocked ? 40 : 0) - waste) };
  });
  const sortedScores = [...scores].sort((a, b) => a.score - b.score);
  const median = sortedScores[Math.floor(scores.length / 2)];
  const gaining = scores.filter((s) => s.score > 50).length;
  return {
    aggregate: mean(scores.map((s) => s.score)),
    persona: {
      score: round1(median.score),
      served: gaining,
      droppedOut: scores.length - gaining,
      topFriction: blocked > 0 ? `stalls block ${blocked} of ${scores.length} shop windows` : `+${Math.round(median.induced)} market visitors past a typical shop`,
    } as PersonaResult,
  };
}

function topCobble(pw: PreparedWorld, legs: number[][]): string | null {
  const edges = pw.world.graph.edges;
  const byName = new Map<string, number>();
  for (const leg of legs) {
    const seen = new Set<string>();
    for (const k of leg) {
      const e = edges[k];
      if (e.surface !== 'cobble' || !e.name || seen.has(e.name)) continue;
      seen.add(e.name);
      byName.set(e.name, (byName.get(e.name) ?? 0) + 1);
    }
  }
  let best: string | null = null, bestN = 0;
  for (const [name, n] of byName) if (n > bestN) { best = name; bestN = n; }
  return best && bestN / Math.max(1, legs.length) >= 0.2 ? `cobblestones on ${best}` : null;
}

// "Ask an agent": draw a random young commuter and a random senior from the twin, route each of them to every
// candidate site, and turn their actual trips into answers and a mark out of 10. Every fact comes from the route.
import type { Candidate, Scenario } from '../contracts';
import type { CostContext } from './cost';
import { pathFrom, shortestPathsTo } from './dijkstra';
import { siteEntries } from './engine';
import * as P from './params';
import { scenarioContext, scenarioPool, type PreparedWorld } from './prepare';
import { fork } from './rng';

export type Interviewee = 'young' | 'senior';

export interface InterviewTrip {
  siteId: string; siteName: string;
  start: string;                 // where this trip begins, e.g. "the Lorenzkirche U-Bahn exit"
  reachable: boolean;
  lengthM: number; minutes: number;
  cobbleM: number; roughM: number; steps: number;
  detourM: number;               // seniors: extra metres compared with the shortest walk, to avoid steps and cobbles
  unshelteredM: number;
  roadworks: string[];           // road conditions passed (World.roadConditions titles)
  streets: string[];             // main streets on the way
  rating: number;                // out of 10
  reasons: string[];             // what cost points, in plain words
  path: [number, number, number][];   // [lng, lat, seconds since start]
}

export interface Interview {
  id: string; who: Interviewee; name: string; age: number; about: string;
  scenario: Scenario; trips: InterviewTrip[]; preferred: string;
}

const YOUNG = ['Lena', 'Mia', 'Sophie', 'Emma', 'Hannah', 'Lea'];
const SENIOR = ['Helga', 'Ingrid', 'Gertrud', 'Renate', 'Erika', 'Hildegard'];
const r1 = (x: number) => Math.round(x * 10) / 10;
const half = (x: number) => Math.round(x * 2) / 2;

/** Generate `count` interview pairs (one young commuter, one senior) for the given sites. */
export function runInterviews(pw: PreparedWorld, sites: Candidate[], scenario: Scenario, seed: number, count = 4): Interview[] {
  const ctx = scenarioContext(pw, scenario);
  const rain = scenario === 'RAINY_SAT';
  const site = sites.map((c) => {
    const poly = c.polygon.map(([lng, lat]) => pw.proj.toXY(lng, lat));
    const entries = siteEntries(pw, poly);
    return {
      c, sheltered: c.kind === 'ground_floor',
      walk: shortestPathsTo(pw.g, entries, 'walker', ctx),
      senior: shortestPathsTo(pw.g, entries, 'senior', ctx),
    };
  });
  const pool = scenarioPool(pw, scenario, seed, P.DEFAULT_SCALE);
  const seniors = pool.agents.filter((a) => a.kind === 'senior');
  const residents = pool.agents.filter((a) => a.kind === 'resident');
  const out: Interview[] = [];
  const seen = new Set<string>();
  const signature = (trips: InterviewTrip[]) => trips.map((t) => `${t.start}|${t.minutes}`).join('/');

  /** Draw agents until one gives answers we haven't heard yet (so two interviews never repeat). */
  const draw = (rng: () => number, candidates: typeof residents, make: (node: number) => InterviewTrip[]) => {
    let trips = make(candidates[Math.floor(rng() * candidates.length)].node);
    for (let tries = 0; tries < 40 && seen.has(signature(trips)); tries++) trips = make(candidates[Math.floor(rng() * candidates.length)].node);
    seen.add(signature(trips));
    return trips;
  };

  for (let n = 0; n < count; n++) {
    const rng = fork(seed, `interview:${scenario}:${n}`);

    // A young resident from the Zensus grid: walks if the site is close, otherwise takes the U-Bahn to the nearest exit
    let home = -1;
    const youngTrips = draw(rng, residents, (node) => {
      home = node;
      return site.map((s) => {
        if (s.walk.dist[node] <= P.YOUNG_WALK_MAX_M) return trip(pw, ctx, rain, s.c, s.sheltered, s.walk, null, node, 'home', 'young');
        // Farther away she rides: S-Bahn, U-Bahn, tram or bus, whichever stop is the shortest walk from the site
        const stop = transitStops(pw).reduce((b, x) => (s.walk.dist[x.node] < s.walk.dist[b.node] ? x : b));
        return trip(pw, ctx, rain, s.c, s.sheltered, s.walk, null, stop.node, stop.label, 'young');
      });
    });
    out.push(finish(`young-${scenario}-${n}`, 'young', YOUNG[Math.floor(rng() * YOUNG.length)], 19 + Math.floor(rng() * 9),
      `student, lives near ${streetOf(pw, home)}`, scenario, youngTrips));

    // A senior from the Zensus grid: walks from home if close, otherwise rides to the best step-free stop
    let seniorHome = -1;
    const seniorTrips = draw(rng, seniors, (node) => {
      seniorHome = node;
      return site.map((s) => {
        if (s.senior.dist[node] <= P.SENIOR_WALK_BUDGET_M) return trip(pw, ctx, rain, s.c, s.sheltered, s.walk, s.senior, node, 'home', 'senior');
        // Like the engine: stops within 100 m of the best one are equally likely (they live on different lines)
        const options = pw.seniorAccess.filter((a) => s.senior.dist[a] < Infinity).sort((a, b) => s.senior.dist[a] - s.senior.dist[b]);
        const near = options.filter((a) => s.senior.dist[a] <= s.senior.dist[options[0]] + 100).slice(0, 4);
        const pick = near.length ? near[Math.floor(fork(seed, `access:${node}:${s.c.id}`)() * near.length)] : -1;
        return trip(pw, ctx, rain, s.c, s.sheltered, s.walk, s.senior, pick, accessLabel(pw, pick), 'senior');
      });
    });
    out.push(finish(`senior-${scenario}-${n}`, 'senior', SENIOR[Math.floor(rng() * SENIOR.length)], 72 + Math.floor(rng() * 13),
      `retired, uses a rollator, lives near ${streetOf(pw, seniorHome)}`, scenario, seniorTrips));
  }
  return out;
}

/** The name of a street at this node, for "lives near …". */
function streetOf(pw: PreparedWorld, node: number): string {
  for (let k = pw.g.adjStart[node]; k < pw.g.adjStart[node + 1]; k++) {
    const name = pw.world.graph.edges[pw.g.adjEdge[k]].name;
    if (name) return name;
  }
  return 'the Altstadt';
}

function finish(id: string, who: Interviewee, name: string, age: number, about: string, scenario: Scenario, trips: InterviewTrip[]): Interview {
  const preferred = [...trips].sort((a, b) => b.rating - a.rating || a.minutes - b.minutes)[0].siteId;
  return { id, who, name, age, about, scenario, trips, preferred };
}

function trip(pw: PreparedWorld, ctx: CostContext, rain: boolean, cand: Candidate, sheltered: boolean,
              walkSp: ReturnType<typeof shortestPathsTo>, seniorSp: ReturnType<typeof shortestPathsTo> | null,
              from: number, start: string, who: Interviewee): InterviewTrip {
  const edges = pw.world.graph.edges;
  const sp = who === 'senior' ? seniorSp! : walkSp;
  const leg = from >= 0 ? pathFrom(sp, from) : { nodes: [], edges: [] };
  const base: InterviewTrip = { siteId: cand.id, siteName: cand.name, start, reachable: false, lengthM: 0, minutes: 0, cobbleM: 0, roughM: 0,
    steps: 0, detourM: 0, unshelteredM: 0, roadworks: [], streets: [], rating: 1, reasons: ['there is no step-free way to get there'], path: [] };
  if (leg.nodes.length === 0) return base;

  let t = who === 'young' ? P.COMMUTER_EXIT_MIN * 60 : 0;
  const path: [number, number, number][] = [];
  const pushNode = (i: number) => { const [lng, lat] = pw.proj.toLngLat(pw.g.x[i], pw.g.y[i]); path.push([r6(lng), r6(lat), Math.round(t)]); };
  if (leg.nodes.length) pushNode(leg.nodes[0]);
  let lengthM = 0, cobbleM = 0, roughM = 0, steps = 0, unshelteredM = 0;
  const streetLen = new Map<string, number>();
  const roadworks = new Set<string>();
  leg.edges.forEach((k, i) => {
    const e = edges[k];
    lengthM += e.lengthM;
    if (e.surface === 'cobble') cobbleM += e.lengthM;
    if (e.surface === 'rough') roughM += e.lengthM;
    if (e.steps) steps++;
    if (!e.sheltered) unshelteredM += e.lengthM;
    if (e.name) streetLen.set(e.name, (streetLen.get(e.name) ?? 0) + e.lengthM);
    const ci = pw.road.edgeCondition[k];
    if (ci >= 0) { const c = pw.world.roadConditions![ci]; roadworks.add(c.street ?? c.title); }
    const speed = who === 'senior' ? P.SENIOR_SPEED / (e.surface === 'cobble' ? P.SENIOR_COBBLE_SLOWDOWN : 1) : P.WALK_SPEED;
    t += (e.lengthM / speed) * (ctx.walkFactor?.[k] || 1);
    pushNode(leg.nodes[i + 1]);
  });
  const minutes = t / 60;
  const shortest = who === 'senior' && from >= 0 ? pathFrom(walkSp, from).edges.reduce((s, k) => s + edges[k].lengthM, 0) : lengthM;
  const detourM = Math.max(0, lengthM - shortest);
  const streets = [...streetLen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([n]) => n);

  // Mark out of 10: start from 10 and subtract what the route actually costs this person.
  const reasons: string[] = [];
  let rating = 10;
  const cost = (points: number, why: string) => { if (points >= 0.25) { rating -= points; reasons.push(why); } };
  if (who === 'young') {
    cost(P.RATING_YOUNG_PER_MIN * minutes, `${r1(minutes)}-minute walk`);
    cost(P.RATING_PER_100M_COBBLE_YOUNG * (cobbleM / 100), `${Math.round(cobbleM)} m of cobblestones`);
    cost(P.RATING_PER_STEP_RUN * steps, `${steps} flights of steps`);
  } else {
    const d = sp.dist[from];
    const pDrop = Math.min(1, Math.max(0, ((d - P.SENIOR_DROP_START_M) / 100) * P.SENIOR_DROP_PER_100M));
    cost(10 * pDrop, `a ${Math.round(lengthM)} m walk, far with a rollator`);
    cost(P.RATING_PER_100M_COBBLE_SENIOR * (cobbleM / 100), `${Math.round(cobbleM)} m of cobblestones`);
    cost(P.RATING_PER_100M_ROUGH_SENIOR * (roughM / 100), `${Math.round(roughM)} m of uneven paving`);
    cost(P.RATING_PER_100M_DETOUR * (detourM / 100), `a ${Math.round(detourM)} m detour around steps and cobbles`);
  }
  cost(P.RATING_PER_ROADWORK * roadworks.size, `roadworks on ${[...roadworks].join(' and ')}`);
  if (rain && !sheltered) cost(P.RATING_RAIN_OPEN_SITE, 'an open-air market in the rain');
  if (ctx.snow && !sheltered) cost(P.RATING_SNOW_OPEN_SITE, 'an open-air market in the snow');
  if (ctx.snow) cost(Math.min(P.RATING_SNOW_ROUTE_MAX, P.RATING_PER_100M_SNOW * (unshelteredM / 100)), `${Math.round(unshelteredM)} m through snow`);
  if (rain) cost(Math.min(P.RATING_RAIN_ROUTE_MAX, P.RATING_PER_100M_RAIN * (unshelteredM / 100)), `${Math.round(unshelteredM)} m without a roof in the rain`);
  if (reasons.length === 0) reasons.push('short, smooth and easy');

  return { siteId: cand.id, siteName: cand.name, start, reachable: true, lengthM: Math.round(lengthM), minutes: r1(minutes),
    cobbleM: Math.round(cobbleM), roughM: Math.round(roughM), steps, detourM: Math.round(detourM), unshelteredM: Math.round(unshelteredM),
    roadworks: [...roadworks], streets, rating: Math.max(1, half(rating)), reasons, path };
}

const MODE: Record<string, string> = { sbahn: 'S-Bahn', tram: 'tram', bus: 'bus' };
const stopCache = new WeakMap<PreparedWorld, { node: number; label: string }[]>();

/** Every place a commuter can arrive: U-Bahn exits plus S-Bahn, tram and bus stops, named with their mode. */
function transitStops(pw: PreparedWorld): { node: number; label: string }[] {
  let list = stopCache.get(pw);
  if (list) return list;
  list = pw.entrances.map((e) => ({ node: e.node, label: `${e.station} (U-Bahn)` }));
  for (const s of pw.world.pois.stops) {
    const [x, y] = pw.proj.toXY(s.lng, s.lat);
    const node = pw.g.nearest(x, y, 80, pw.isWalkNode);
    if (node >= 0 && s.name) list.push({ node, label: `${s.name.replace(/^Nürnberg /, '')} (${MODE[s.mode]})` });
  }
  stopCache.set(pw, list);
  return list;
}

/** Name a step-free access node after the stop or station next to it. */
function accessLabel(pw: PreparedWorld, node: number): string {
  if (node < 0) return 'the nearest stop';
  const [lng, lat] = pw.proj.toLngLat(pw.g.x[node], pw.g.y[node]);
  const near = (a: number, b: number) => Math.hypot((a - lng) * 72400, (b - lat) * 111200);
  const stop = pw.world.pois.stops.map((s) => ({ s, d: near(s.lng, s.lat) })).sort((a, b) => a.d - b.d)[0];
  const exit = pw.world.pois.subwayEntrances.map((s) => ({ s, d: near(s.lng, s.lat) })).sort((a, b) => a.d - b.d)[0];
  if (exit && exit.d < 80 && (!stop || exit.d <= stop.d)) return `${exit.s.station} (U-Bahn lift)`;
  if (stop && stop.d < 80 && stop.s.name) return `${stop.s.name.replace(/^Nürnberg /, '')} (${MODE[stop.s.mode]})`;
  return 'a step-free stop';
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** The main thing that made the other site worse, in one sentence. */
function whyNot(other: InterviewTrip, best: InterviewTrip, name: string): string {
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
  if (!other.reachable) return `I simply can't get to ${name} without steps.`;
  if (other.minutes - best.minutes >= 2) return `${cap(name)} takes me ${other.minutes} minutes instead of ${best.minutes}.`;
  const kind = (r: string) => r.replace(/[0-9.]+/g, '#');
  const worse = other.reasons.find((r) => !r.endsWith('-minute walk') && !best.reasons.some((b) => kind(b) === kind(r)));
  return worse ? `At ${name} I had ${worse}.` : `${cap(name)} is a bit harder for me.`;
}

/** Plain-English answers to the three questions, built only from the trip facts. */
export function templateAnswers(iv: Interview): { commute: string; rating: string; future: string } {
  const say = (t: InterviewTrip) => {
    const short = t.siteName.replace(/ \(.*\)$/, '').replace('St. Lorenzkirche plaza', 'Lorenzkirche').replace('Former ', 'the old ');
    if (!t.reachable) return `${short} I couldn't reach at all: there is no step-free way`;
    const from = t.start === 'home' ? 'from home' : `from ${t.start.replace(/ \((.+)\)$/, ' $1')}`;
    const notes = t.reasons.filter((r) => !r.endsWith('-minute walk'));
    const extra = notes.length === 0 ? 'quick and easy' : notes[0] === 'short, smooth and easy' ? 'short, smooth and easy' : notes.slice(0, 2).join(', and ');
    return `${short} took me ${t.minutes} minutes ${from}${t.streets[0] ? ` via ${t.streets[0]}` : ''}: ${extra}`;
  };
  const shortName = (id: string) => (id === 'kaufhof' ? 'the old Kaufhof' : id === 'lorenzkirche' ? 'Lorenzkirche' : id);
  const best = iv.trips.find((t) => t.siteId === iv.preferred)!;
  const other = iv.trips.find((t) => t.siteId !== iv.preferred);
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
  return {
    commute: iv.trips.map((t) => cap(say(t))).join('. ') + '.',
    rating: cap(iv.trips.map((t) => `${shortName(t.siteId)}: ${t.rating} out of 10`).join(', and ') + '.'),
    future: other && best.rating === other.rating
      ? (best.minutes === other.minutes ? 'Honestly, both are equally good for me.' : `Honestly, both are about the same. Maybe ${shortName(best.siteId)}, it's a little quicker.`)
      : `${cap(shortName(best.siteId))}, for sure. ${other ? whyNot(other, best, shortName(other.siteId)) : ''}`,
  };
}


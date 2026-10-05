// Dev-only viewer: runs every benchmark × scenario × mitigation and writes one self-contained HTML page
// (deck.gl inlined, so it works offline). Usage: npm run sim:viz  →  sim-viz/index.html
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Scenario, SimulationResult } from '../../contracts';
import { haversineM } from '../geo';
import { createTwin, type Mitigation } from '../index';
import { benchmarkCandidates } from './benchmarks';
import { BRIEF_MODEL, buildFacts, generateBriefs, generateVoices, PRESETS, voiceFacts } from './briefs';
import { runInterviews, templateAnswers } from '../interview';
import { prepareWorld } from '../prepare';
import { loadBuildings } from './lod2';
import { buildOsmWorld, REPO } from './osmWorld';

const SEED = 42;
const SCENARIOS: Scenario[] = ['SUNNY_SAT', 'RAINY_SAT', 'SNOWY_SAT'];   // the engine also supports CHRISTMAS_MARKET
const MAX_TRIPS = 300;
const OUT_DIR = resolve(REPO, 'sim-viz');

const world = buildOsmWorld();
const twin = createTwin(world);
const SITE_IDS = ['lorenzkirche', 'kaufhof'];   // the two organizer candidates, side by side
const sites = benchmarkCandidates(world).filter((s) => SITE_IDS.includes(s.id));
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

// Street layers drawn from the same graph the agents walk on
const walk: [number, number][][] = [], road: [number, number][][] = [];
for (const e of world.graph.edges) {
  const a = world.graph.nodes[e.a], b = world.graph.nodes[e.b];
  (e.vehicle ? road : walk).push([[r6(a.lng), r6(a.lat)], [r6(b.lng), r6(b.lat)]]);
}

const buildings = loadBuildings().map((b) => ({ ring: b.ring, h: Math.round(b.h * 10) / 10, addr: b.addr }));

/** Kiosk mitigation: the nearest U-Bahn exit that is at least 150 m from the site. */
function kioskFor(polygon: [number, number][]): Mitigation & { kind: 'kiosk' } {
  const lng = polygon.reduce((s, p) => s + p[0], 0) / polygon.length;
  const lat = polygon.reduce((s, p) => s + p[1], 0) / polygon.length;
  const e = world.pois.subwayEntrances
    .map((x) => ({ x, d: haversineM(lng, lat, x.lng, x.lat) }))
    .filter((x) => x.d >= 150)
    .sort((a, b) => a.d - b.d)[0].x;
  return { kind: 'kiosk', lng: e.lng, lat: e.lat, label: `Express kiosk at the ${e.station} U-Bahn exit` };
}

const runs: Record<string, SimulationResult> = {};
const mitigations: Record<string, { label: string; lng?: number; lat?: number }> = {};
let ms = 0;
for (const site of sites) {
  const kiosk = kioskFor(site.polygon);
  const variants: Record<string, Mitigation[]> = {
    none: [],
    delivery: [{ kind: 'delivery_window', unlockRemovableBollards: true }],
    loop: [{ kind: 'stall_layout', layout: 'loop' }],
    kiosk: [kiosk],
  };
  for (const scenario of SCENARIOS) {
    for (const [key, mits] of Object.entries(variants)) {
      const t = performance.now();
      const r = twin.run(site, { scenario, seed: SEED, mitigations: mits, maxTrips: MAX_TRIPS });
      ms += performance.now() - t;
      for (const slice of Object.values(r.bySlice)) slice.heat = slice.heat.filter((h) => h[2] >= 0.02);
      runs[`${site.id}|${scenario}|${key}`] = r;
      if (key !== 'none') mitigations[`${site.id}|${key}`] = { label: r.mitigations[0], ...(key === 'kiosk' ? { lng: kiosk.lng, lat: kiosk.lat } : {}) };
    }
  }
}

// Claude's recommendation per weather × fix × priority preset (cached; needs ANTHROPIC_API_KEY for new ones)
const fixLabels = Object.fromEntries(Object.entries(mitigations).map(([k, v]) => [k, v.label]));
const roadNearby = Object.fromEntries(sites.map((s) => {
  const [lng, lat] = [s.polygon.reduce((a, p) => a + p[0], 0) / s.polygon.length, s.polygon.reduce((a, p) => a + p[1], 0) / s.polygon.length];
  return [s.id, (world.roadConditions ?? []).filter((c) => haversineM(lng, lat, c.lng, c.lat) <= 300)
    .map((c) => `${c.title} (until ${c.until ?? 'open-ended'})`)];
}));
const jobs = SCENARIOS.flatMap((scenario) => ['none', 'delivery', 'loop', 'kiosk'].flatMap((mit) => Object.keys(PRESETS).map((preset) => ({
  key: `${scenario}|${mit}|${preset}`, facts: buildFacts(runs, sites, scenario, mit, preset, fixLabels, roadNearby),
}))));
const briefs = await generateBriefs(jobs);

// "Ask an agent": a random young commuter and a random senior travel to both sites and answer three questions
const pw = prepareWorld(world);
const interviewRuns = SCENARIOS.flatMap((scenario) => runInterviews(pw, sites, scenario, SEED, 4));
const voices = await generateVoices(interviewRuns.map((iv) => ({ key: iv.id, facts: voiceFacts(iv) })));
const interviews = interviewRuns.map((iv) => {
  const claude = voices[iv.id];
  return { ...iv, answers: claude ? { commute: claude.commute, rating: claude.rating, future: claude.future } : templateAnswers(iv),
           voice: claude ? { model: claude.model, verified: claude.verified, unverified: claude.unverified } : null };
});

const data = {
  briefs,
  interviews,
  roadConditions: world.roadConditions ?? [],
  briefModel: BRIEF_MODEL,
  seed: SEED,
  streets: { walk, road },
  buildings,
  sites: sites.map((s) => ({ id: s.id, name: s.name, kind: s.kind, polygon: s.polygon })),
  scenarios: SCENARIOS,
  mitigations,
  runs,
};

const deckBundle = readFileSync(resolve(REPO, 'node_modules/deck.gl/dist.min.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
const template = readFileSync(resolve(import.meta.dirname, 'viz.html'), 'utf8');
const html = template
  .replace('/*__DECK__*/', () => deckBundle)
  .replace('/*__DATA__*/null', () => JSON.stringify(data));
mkdirSync(OUT_DIR, { recursive: true });
const out = resolve(OUT_DIR, 'index.html');
writeFileSync(out, html);
console.log(`${Object.keys(runs).length} runs in ${Math.round(ms)} ms, ${buildings.length} buildings → ${out} (${(html.length / 1e6).toFixed(1)} MB)`);

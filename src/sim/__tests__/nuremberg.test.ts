// Integration on the real datasets/ (OSM, Zensus, GTFS extract). Skipped if the data isn't checked out.
import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Candidate, Scenario } from '../../contracts';
import { benchmarkCandidates } from '../dev/benchmarks';
import { buildOsmWorld, laeaToWgs84, WORLD_DATA_PATHS, vanAllowed } from '../dev/osmWorld';
import { createTwin, type Twin, type World } from '../index';

const hasData = WORLD_DATA_PATHS.map((file) => existsSync(file)).every(Boolean);

describe('osm rules', () => {
  it('reads delivery access from OSM tags at 05:30', () => {
    expect(vanAllowed({ highway: 'pedestrian' })).toBe(false);
    expect(vanAllowed({ highway: 'pedestrian', 'motor_vehicle:conditional': 'delivery @ (05:00-20:00)' })).toBe(true);
    expect(vanAllowed({ highway: 'residential', 'motor_vehicle:conditional': 'destination @ (22:00-05:00)' })).toBe(true);
    expect(vanAllowed({ highway: 'service', access: 'private' })).toBe(false);
    expect(vanAllowed({ highway: 'pedestrian', motor_vehicle: 'destination' })).toBe(true);
  });

  it('converts EPSG:3035 like the IOGP guidance note 7-2 worked example', () => {
    const [lng, lat] = laeaToWgs84(3962799.45, 2999718.85);
    expect(lng).toBeCloseTo(5, 6);
    expect(lat).toBeCloseTo(50, 6);
  });
});

describe.skipIf(!hasData)('Nuremberg benchmarks', () => {
  let world: World;
  let twin: Twin;
  let sites: Candidate[];
  let byId: Record<string, Candidate>;
  beforeAll(() => {
    world = buildOsmWorld();
    twin = createTwin(world);
    sites = benchmarkCandidates(world);
    byId = Object.fromEntries(sites.map((s) => [s.id, s]));
  });

  it('builds a connected Altstadt graph with real stations', () => {
    expect(world.graph.nodes.length).toBeGreaterThan(5000);
    expect(world.stations.some((s) => s.name === 'Lorenzkirche' && s.mode === 'subway')).toBe(true);
    expect(world.pois.subwayEntrances.length).toBeGreaterThan(30);
    expect(world.population.length).toBeGreaterThan(500);
  });

  it('runs one site × scenario in under 1.5 s and reproduces it from the seed', () => {
    twin.run(byId.hauptmarkt, { scenario: 'SUNNY_SAT', seed: 1 });   // warm the scenario pool
    for (const scenario of ['SUNNY_SAT', 'RAINY_SAT', 'CHRISTMAS_MARKET'] as Scenario[]) {
      for (const site of sites) {
        const t = performance.now();
        const a = twin.run(site, { scenario, seed: 42 });
        expect(performance.now() - t).toBeLessThan(1500);
        const b = twin.run(site, { scenario, seed: 42 });
        expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
      }
    }
  });

  it('commuters prefer Lorenzkirche, the site on the U-Bahn station', () => {
    const score = (id: string) => twin.run(byId[id], { scenario: 'SUNNY_SAT', seed: 42 }).personas.commuter.score;
    expect(score('lorenzkirche')).toBeGreaterThan(score('hauptmarkt'));
    expect(score('lorenzkirche')).toBeGreaterThan(score('kaufhof'));
  });

  it('preserves baseline delivery access at Kaufhof and Hauptmarkt while Lorenzkirche requires a 94 m carry', () => {
    const vendor = (id: string, scenario: Scenario = 'SUNNY_SAT') =>
      twin.run(byId[id], { scenario, seed: 42 }).personas.vendor;
    const lorenz = vendor('lorenzkirche');
    expect(lorenz.score).toBeLessThan(10);
    expect(lorenz.topFriction).toMatch(/94 m/);
    expect(vendor('hauptmarkt').score).toBeGreaterThan(60);
    for (const scenario of ['SUNNY_SAT', 'RAINY_SAT', 'CHRISTMAS_MARKET'] as Scenario[]) {
      const kaufhof = vendor('kaufhof', scenario);
      expect(kaufhof.score).toBeGreaterThan(80);
      expect(kaufhof.score).toBeGreaterThan(vendor('lorenzkirche', scenario).score + 30);
      expect(kaufhof.topFriction).toMatch(/Peuntgasse/);
    }
  });

  it('the Christkindlesmarkt closes the Hauptmarkt but not the alternatives', () => {
    const run = (id: string) => twin.run(byId[id], { scenario: 'CHRISTMAS_MARKET', seed: 42 });
    expect(run('hauptmarkt').personas.vendor.topFriction).toBe('Christkindlesmarkt occupies the site');
    expect(run('lorenzkirche').stallExposure.length).toBeGreaterThan(0);
    expect(run('kaufhof').stallExposure.length).toBeGreaterThan(0);
  });

  it('rain costs the open squares more senior visitors than the sheltered Kaufhof', () => {
    const drop = (id: string) =>
      twin.run(byId[id], { scenario: 'SUNNY_SAT', seed: 42 }).personas.senior.score -
      twin.run(byId[id], { scenario: 'RAINY_SAT', seed: 42 }).personas.senior.score;
    expect(drop('lorenzkirche')).toBeGreaterThan(drop('kaufhof'));
  });
});

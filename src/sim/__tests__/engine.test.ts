import { describe, expect, it } from 'vitest';
import type { PersonaId, SimulationResult } from '../../contracts';
import { createTwin } from '../index';
import { at, EAST, gridWorld, WEST } from './fixtures';

const twin = createTwin(gridWorld());
const run = (cand = EAST, extra: Partial<Parameters<typeof twin.run>[1]> = {}) =>
  twin.run(cand, { scenario: 'SUNNY_SAT', seed: 7, ...extra });

function expectValidResult(r: SimulationResult) {
  for (const v of Object.values(r.criteria)) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(100);
  for (const id of ['senior', 'vendor', 'commuter', 'retailer'] as PersonaId[]) {
    const p = r.personas[id];
    expect(p.score).toBeGreaterThanOrEqual(0);
    expect(p.score).toBeLessThanOrEqual(100);
    expect(p.topFriction.length).toBeGreaterThan(0);
  }
  expect(Object.keys(r.bySlice).sort()).toEqual(['05:30_DELIVERY', '11:30_PEAK', '15:00_LULL']);
  for (const t of r.trips) {
    for (let i = 1; i < t.path.length; i++) expect(t.path[i][2]).toBeGreaterThanOrEqual(t.path[i - 1][2]);
  }
}

describe('simulate', () => {
  it('returns a complete SimulationResult', () => {
    const r = run();
    expectValidResult(r);
    expect(r.candidateId).toBe('east');
    expect(r.stallExposure.length).toBeGreaterThanOrEqual(10);
    expect(r.trips.length).toBeGreaterThan(0);
    expect(r.bySlice['11:30_PEAK'].heat.length).toBeGreaterThan(0);
  });

  it('is deterministic for a seed and changes with the seed', () => {
    expect(JSON.stringify(run())).toEqual(JSON.stringify(run()));
    expect(JSON.stringify(run(EAST, { seed: 8 }))).not.toEqual(JSON.stringify(run()));
  });

  it('flags the bollard that blocks vans, and the delivery window clears it', () => {
    const blocked = run();
    expect(blocked.personas.vendor.score).toBeLessThan(10);
    expect(blocked.personas.vendor.topFriction).toMatch(/^bollard at Row 6 05:3\d$/);
    expect(blocked.bySlice['05:30_DELIVERY'].bottlenecks.some((b) => b.type === 'BOLLARD_BLOCKAGE')).toBe(true);

    const fixed = run(EAST, { mitigations: [{ kind: 'delivery_window', unlockRemovableBollards: true }] });
    expect(fixed.personas.vendor.score).toBeGreaterThan(60);
    expect(fixed.mitigations).toEqual(['Delivery window 05:00–07:00 with removable bollards lowered']);
  });

  it('gives sites clearly different persona profiles', () => {
    const east = run(EAST), west = run(WEST);
    expect(west.personas.vendor.score - east.personas.vendor.score).toBeGreaterThan(50);
    const diffs = (['senior', 'commuter', 'retailer'] as PersonaId[]).map((p) => Math.abs(east.personas[p].score - west.personas[p].score));
    expect(Math.max(...diffs)).toBeGreaterThan(5);
  });

  it('rain hurts an open square more than a sheltered hall', () => {
    const drop = (c: typeof EAST) => run(c).personas.senior.score - run(c, { scenario: 'RAINY_SAT' }).personas.senior.score;
    expect(drop(EAST)).toBeGreaterThan(drop(WEST));
  });

  it('closes a site the Christkindlesmarkt occupies', () => {
    const r = run(WEST, { scenario: 'CHRISTMAS_MARKET' });
    expect(r.personas.vendor.topFriction).toBe('Christkindlesmarkt occupies the site');
    expect(r.personas.senior.served).toBe(0);
    expect(r.stallExposure).toEqual([]);
  });

  it('a kiosk at the U-Bahn exit serves commuters the market is too far for', () => {
    const base = run(WEST);
    const kiosk = run(WEST, { mitigations: [{ kind: 'kiosk', lng: at(10, 10)[0], lat: at(10, 10)[1], label: 'Kiosk at Alpha' }] });
    expect(kiosk.personas.commuter.score).toBeGreaterThanOrEqual(base.personas.commuter.score);
    expect(kiosk.personas.commuter.served).toBeGreaterThanOrEqual(base.personas.commuter.served);
    expect(kiosk.mitigations).toEqual(['Kiosk at Alpha']);
  });

  it('a loop layout spreads visitors more fairly than clusters at the entrance', () => {
    const cluster = run(EAST, { mitigations: [{ kind: 'delivery_window', unlockRemovableBollards: true }] });
    const loop = run(EAST, { mitigations: [{ kind: 'delivery_window', unlockRemovableBollards: true },
                                           { kind: 'stall_layout', layout: 'loop' }] });
    expect(loop.criteria.fairness).toBeGreaterThan(cluster.criteria.fairness);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Brief, Candidate, PersonaId, Scenario, SimulationResult } from '../../contracts';
import type { BriefClient, SimClient } from '../adapters/types';
import { formatBinding, resolve, UNRESOLVED } from './bind';
import {
  createDirector,
  installSceneApi,
  validateSceneDef,
  type DirectorOptions,
  type FrameScheduler,
  type SceneFrame,
} from './director';
import { haversineM, offsetLngLat, tripPositionAt } from './heroes';
import type { SceneAssets, SceneDef, SceneState, SceneViewState } from './types';

/* ------------------------------------------------------------------------ */
/* Test data                                                                 */
/* ------------------------------------------------------------------------ */

type Trip = SimulationResult['trips'][number];

const BASE: [number, number] = [11.08, 49.449];
const at = (east: number, north: number) => offsetLngLat(offsetLngLat(BASE, 90, east), 0, north);
const trip = (persona: PersonaId, pts: [number, number, number][]): Trip => ({
  persona,
  path: pts.map(([e, n, t]) => [...at(e, n), t] as [number, number, number]),
});

const ELEVATOR = at(100, 0);
const BOLLARD = at(0, 300);
const ASSETS: SceneAssets = {
  arrivals: [],
  graphNodes: [{ id: 'e1', lng: ELEVATOR[0], lat: ELEVATOR[1], role: 'elevator' }],
};

const TRIPS: Trip[] = [
  trip('vendor', [[0, 0, 19800], [0, 200, 21000]]),
  trip('vendor', [[0, 0, 19800], [0, 295, 21000]]), // Markus
  trip('senior', [[0, 0, 36000], [200, 0, 36600]]), // Helga, at the elevator at 36300
  trip('commuter', [[0, 0, 41400], [50, 0, 42300]]), // Lukas
];

function makeResult(scenario: Scenario, mitigations: string[], commuterScore: number): SimulationResult {
  const p = (score: number, topFriction: string) => ({ score, served: 40, droppedOut: 6, topFriction });
  return {
    candidateId: 'kaufhof', scenario, seed: 42, mitigations,
    criteria: { accessibility: 50, footfall: 50, fairness: 50, localBusiness: 50, walkability: 50 },
    personas: {
      senior: p(37, 'steps'), vendor: p(22.6, 'bollard at Königstraße'),
      commuter: p(commuterScore, 'long walk'), retailer: p(70, 'none'),
    },
    bySlice: {
      '05:30_DELIVERY': {
        heat: [],
        bottlenecks: [{ lng: BOLLARD[0], lat: BOLLARD[1], severity: 1, type: 'BOLLARD_BLOCKAGE', time: '05:34', cause: 'bollard' }],
      },
      '11:30_PEAK': { heat: [], bottlenecks: [] },
      '15:00_LULL': { heat: [], bottlenecks: [] },
    },
    stallExposure: [1, 2],
    trips: TRIPS,
  };
}

const KIOSK = 'kiosk:11.080500,49.449500';
const BRIEF: Brief = {
  recommended: 'kaufhof', why: [], comparisons: [],
  losers: [{ persona: 'commuter', mitigation: KIOSK }, { persona: 'vendor', mitigation: 'delivery-window:05:00-06:30' }],
  councilBriefMd: '',
};

const VIEW_A: SceneViewState = { longitude: 11.078, latitude: 49.4525, zoom: 13.8, pitch: 0, bearing: 0 };
const VIEW_B: SceneViewState = { longitude: 11.0777, latitude: 49.4507, zoom: 17, pitch: 60, bearing: -30 };
const VIEW_C: SceneViewState = { longitude: 11.08, latitude: 49.449, zoom: 16.5, pitch: 50, bearing: 0 };

const DEF: SceneDef = {
  id: '2', title: 'Test scene', candidateId: 'kaufhof', scenario: 'RAINY_SAT', seed: 42,
  heroes: [
    { hero: 'markus', persona: 'vendor', pick: 'lastPointNearestBottleneck', slice: '05:30_DELIVERY', type: 'BOLLARD_BLOCKAGE' },
    { hero: 'helga', persona: 'senior', pick: 'earliestPassingNode', node: 'elevator', withinM: 5 },
    { hero: 'lukas', persona: 'commuter', pick: 'longestInWindow', window: [41400, 43200] },
  ],
  keyframes: [
    {
      id: 'K0', t: 0, durationMs: 2000, camera: { kind: 'fixed', viewState: VIEW_A }, transition: 'cut', transitionMs: 0,
      sim: { mode: 'paused', at: 19800 },
      layers: [{ layer: 'terrain', on: true }],
      captions: [
        { id: 'title', slot: 'title', template: 'Kaufhof · rainy Saturday' },
        { id: 'clock0', slot: 'clock', template: '{scene.simSec|clock}' },
      ],
    },
    {
      id: 'K1', t: 2000, durationMs: 4000, camera: { kind: 'fixed', viewState: VIEW_B }, transition: 'fly', transitionMs: 3000,
      sim: { mode: 'run', from: 19800, to: 22500 },
      layers: [
        { layer: 'buildings', on: true, fade: { ms: 2000 } },
        { layer: 'trips', on: true, personas: ['vendor', 'senior'], highlight: 'markus' },
        { layer: 'bottlenecks', on: true, slice: '05:30_DELIVERY', pulse: { trigger: 'always', periodMs: 1000 } },
      ],
      captions: [
        { id: 'markus', slot: 'personaChip', persona: 'vendor', template: 'Markus: {personas.vendor.score}', fadeMs: 500 },
        { id: 'friction', slot: 'frictionChip', template: "{personas.vendor.topFriction} · {bySlice['05:30_DELIVERY'].bottlenecks[type=BOLLARD_BLOCKAGE].time}" },
        { id: 'broken', slot: 'footer', template: 'Market {derived.active.marketScore} · {personas.vendor.nope}' },
      ],
    },
    {
      id: 'K2', t: 6000, durationMs: 3000, camera: { kind: 'follow', hero: 'helga', offsetM: 60, pose: { zoom: 18, pitch: 60, bearing: 90 } },
      transition: 'linear', transitionMs: 1000,
      sim: { mode: 'run', from: 36000, to: 36600 },
      layers: [
        { layer: 'trips', on: false, personas: [], fade: { ms: 1000 } },
        { layer: 'elevatorMarkers', on: true, pulse: { trigger: 'heroNear', hero: 'helga', withinM: 10 } },
        { layer: 'heroProgress', on: true, hero: 'helga', budget: { kind: 'tripDuration' } },
      ],
      captions: [{ id: 'clock2', slot: 'clock', template: '{scene.simSec|clock}' }],
    },
    {
      id: 'K3', t: 9000, durationMs: 2000,
      camera: { kind: 'anchor', anchor: { kind: 'bottleneck', slice: '05:30_DELIVERY', type: 'BOLLARD_BLOCKAGE' }, pose: { zoom: 18, pitch: 40, bearing: 0 } },
      transition: 'cut', transitionMs: 0,
      sim: { mode: 'paused' },
      layers: [],
      captions: [{ id: 'apply', slot: 'subtitle', template: 'Apply Claude mitigation' }],
      gate: { kind: 'mitigation' },
    },
    {
      id: 'K4', t: 11000, durationMs: 3000, camera: { kind: 'fixed', viewState: VIEW_C }, transition: 'linear', transitionMs: 2000,
      sim: { mode: 'run', from: 41400, to: 43200 },
      layers: [{ layer: 'kioskMarkers', on: true }],
      captions: [
        { id: 'delta', slot: 'personaChip', persona: 'commuter', template: '{before.personas.commuter.score} → {after.personas.commuter.score}' },
        { id: 'seed', slot: 'footer', template: 'seed {scene.seed}' },
      ],
    },
  ],
};

const KEY_TIMES = [0, 1000, 2000, 3500, 5000, 6000, 6500, 7300, 8999, 9000, 10500, 11000, 12000, 14000];

/* ------------------------------------------------------------------------ */
/* Fakes                                                                     */
/* ------------------------------------------------------------------------ */

function fakeSim(opts: { failRun?: boolean } = {}) {
  const calls: { candidateId: string; scenario: Scenario; mitigations: string[]; seed: number }[] = [];
  const sim: SimClient = {
    candidates: async () => [
      { id: 'kaufhof', polygon: [[11.079, 49.448], [11.081, 49.448], [11.081, 49.45], [11.079, 49.45]] } as Candidate,
    ],
    run: async (candidateId, scenario, mitigations, seed) => {
      calls.push({ candidateId, scenario, mitigations, seed });
      if (opts.failRun && mitigations.length) throw new Error('engine down');
      return makeResult(scenario, mitigations, mitigations.length ? 64 : 12);
    },
  };
  return { sim, calls };
}

const okBrief: BriefClient = { brief: async () => BRIEF };
const downBrief: BriefClient = { brief: async () => { throw new Error('network blocked'); } };

function fakeFrames() {
  let next = 1;
  const queue = new Map<number, (ts: number) => void>();
  const frames: FrameScheduler = {
    request: (cb) => { queue.set(next, cb); return next++; },
    cancel: (h) => { queue.delete(h); },
  };
  let now = 1000;
  const tick = (dt: number) => {
    now += dt;
    const due = [...queue.values()];
    queue.clear();
    due.forEach((cb) => cb(now));
  };
  return { frames, tick, pending: () => queue.size };
}

function director(over: Partial<DirectorOptions> = {}) {
  const { sim, calls } = fakeSim();
  const log = vi.fn();
  const d = createDirector({
    def: DEF, sim, briefClient: okBrief, dataSource: 'fixtures',
    loadAssets: async () => ASSETS, log, ...over,
  });
  return { d, calls, log };
}

/** A state without lifecycle fields, as JSON, for equality checks. */
const frameOf = (s: SceneState) => {
  const { phase: _p, error: _e, ...frame } = s;
  return JSON.stringify(frame satisfies SceneFrame);
};

/** RZ-live, in Vitest: every binding part equals the formatted value it names. */
function expectBindingsMatchScope(s: SceneState) {
  for (const c of s.captions) {
    for (const part of c.parts) {
      if (part.kind !== 'binding') continue;
      expect(part.text, `${c.id} ${part.path}`).toBe(formatBinding(resolve(s.scope!, part.path), part.format));
    }
  }
}

const text = (s: SceneState, id: string) => s.captions.find((c) => c.id === id)?.parts.map((p) => p.text).join('');

afterEach(() => { delete window.__scene; });

/* ------------------------------------------------------------------------ */
/* Tests                                                                     */
/* ------------------------------------------------------------------------ */

describe('validateSceneDef', () => {
  it('accepts the test scene', () => {
    expect(validateSceneDef(DEF)).toEqual([]);
  });

  it('reports gaps, duplicates, missing hero rules, bad templates and extra gates', () => {
    const k = DEF.keyframes;
    const bad: SceneDef = {
      ...DEF,
      heroes: DEF.heroes.filter((h) => h.hero !== 'helga'),
      keyframes: [
        k[0],
        { ...k[1], t: 2500, captions: [...k[1].captions, { id: 'title', slot: 'title', template: 'oops {x' }] },
        k[2],
        k[3],
        { ...k[4], gate: { kind: 'mitigation' } },
      ],
    };
    const problems = validateSceneDef(bad).join('\n');
    expect(problems).toMatch(/K1 starts at 2500, expected 2000/);
    expect(problems).toMatch(/duplicate caption id title/);
    expect(problems).toMatch(/caption title: unclosed/);
    expect(problems).toMatch(/hero helga is used but has no rule/);
    expect(problems).toMatch(/only one gate/);
    expect(() => createDirector({ def: bad, sim: fakeSim().sim, briefClient: okBrief, dataSource: 'fixtures' })).toThrow(/invalid SceneDef/);
  });
});

describe('director lifecycle', () => {
  it('starts loading and becomes ready with the baseline result', async () => {
    const { d, calls } = director();
    expect(d.state.phase).toBe('loading');
    expect(d.state.result).toBeNull();
    expect(d.state.captions).toEqual([]);
    const s = await d.load();
    expect(s.phase).toBe('ready');
    expect(s.result?.mitigations).toEqual([]);
    expect(calls).toEqual([{ candidateId: 'kaufhof', scenario: 'RAINY_SAT', mitigations: [], seed: 42 }]);
    expect(s.scope?.heroes).toEqual({
      markus: { hero: 'markus', tripIndex: 1 },
      helga: { hero: 'helga', tripIndex: 2 },
      lukas: { hero: 'lukas', tripIndex: 3 },
    });
    expect(d.keyframes.map((k) => [k.id, k.gated])).toEqual([['K0', false], ['K1', false], ['K2', false], ['K3', true], ['K4', false]]);
  });

  it('enters the error phase when the baseline run fails', async () => {
    const sim: SimClient = { candidates: async () => [], run: async () => { throw new Error('no worker'); } };
    const log = vi.fn();
    const d = createDirector({ def: DEF, sim, briefClient: okBrief, dataSource: 'worker', log });
    const s = await d.load();
    expect(s.phase).toBe('error');
    expect(s.error).toMatch(/no worker/);
    expect(log).toHaveBeenCalled();
  });

  it('publishes itself as window.__scene', async () => {
    const { d } = director();
    const uninstall = installSceneApi(d);
    await d.load();
    expect(window.__scene?.state).toBe(d.state);
    expect(window.__scene?.seek(3000).tMs).toBe(3000);
    uninstall();
    expect(window.__scene).toBeUndefined();
  });
});

describe('seek is pure', () => {
  it('gives the same state from any prior state', async () => {
    const a = director().d;
    const b = director().d;
    const c = director().d;
    await Promise.all([a.load(), b.load(), c.load()]);
    for (let t = 0; t <= 9000; t += 33) b.step(33); // played through
    c.seek(8000); c.seek(500); c.seek(9000);        // jumped around
    for (const t of [...KEY_TIMES].reverse()) {
      const fresh = frameOf(a.seek(t));
      expect(frameOf(b.seek(t)), `t=${t}`).toBe(fresh);
      expect(frameOf(c.seek(t)), `t=${t}`).toBe(fresh);
      expect(frameOf(a.seek(t)), `t=${t} twice`).toBe(fresh);
    }
  });

  it('matches step(dt) with seek(t + dt)', async () => {
    const { d } = director();
    await d.load();
    d.seek(1000);
    const stepped = frameOf(d.step(2500));
    expect(frameOf(d.seek(3500))).toBe(stepped);
    expect(d.step(Number.NaN).tMs).toBe(3500);
  });
});

describe('camera', () => {
  it('holds, flies and lands on fixed keyframes', async () => {
    const { d } = director();
    await d.load();
    expect(d.seek(0).viewState).toEqual(VIEW_A);
    expect(d.seek(2000).viewState).toEqual(VIEW_A);
    expect(d.seek(5000).viewState).toEqual(VIEW_B);
    const mid = d.seek(3500).viewState;
    expect(mid.zoom).toBeGreaterThan(VIEW_A.zoom);
    expect(mid.zoom).toBeLessThan(VIEW_B.zoom);
    expect(mid.pitch).toBeCloseTo(30, 6);
    expect(mid.bearing).toBeCloseTo(-15, 6);
  });

  it('follows the hero with the view centre offset ahead of it', async () => {
    const { d } = director();
    await d.load();
    const s = d.seek(7500); // linear transition done; sim clock mid-run
    const helga = tripPositionAt(TRIPS[2], s.simSec, true)!;
    const centre: [number, number] = [s.viewState.longitude, s.viewState.latitude];
    expect(haversineM(centre, helga)).toBeCloseTo(60, 1);
    expect(centre[0]).toBeLessThan(helga[0]); // bearing 90: the camera trails from the west
    expect(s.viewState).toMatchObject({ zoom: 18, pitch: 60, bearing: 90 });
  });

  it('aims at an engine bottleneck', async () => {
    const { d } = director();
    await d.load();
    const v = d.seek(9000).viewState;
    expect([v.longitude, v.latitude]).toEqual([BOLLARD[0], BOLLARD[1]]);
  });
});

describe('sim clock, layers and captions', () => {
  it('runs, holds and jumps the sim clock per keyframe', async () => {
    const { d } = director();
    await d.load();
    expect(d.seek(1000).simSec).toBe(19800);
    expect(d.seek(4000).simSec).toBe(21150);
    expect(d.seek(7500).simSec).toBe(36300);
    expect(d.seek(9500).simSec).toBe(36600); // paused without `at` holds K2's end
    expect(text(d.seek(1000), 'clock0')).toBe('05:30');
    expect(text(d.seek(7500), 'clock2')).toBe('10:05');
  });

  it('folds layer toggles and computes fades from scene time', async () => {
    const { d } = director();
    await d.load();
    let s = d.seek(1000);
    expect(s.layers.terrain.currentOpacity).toBe(1);
    expect(s.layers.buildings.currentOpacity).toBe(0);
    expect(s.layers.trips.on).toBe(false);
    s = d.seek(3000);
    expect(s.layers.buildings.currentOpacity).toBe(0.5);
    expect(s.layers.trips).toMatchObject({ on: true, personas: ['senior', 'vendor'], highlight: 'markus', currentOpacity: 1 });
    s = d.seek(6500);
    expect(s.layers.trips).toMatchObject({ on: false, personas: ['senior', 'vendor'], currentOpacity: 0.5 });
    expect(s.layers.terrain.currentOpacity).toBe(1);
    expect(Object.keys(s.layers)).toHaveLength(15);
  });

  it('computes pulses and the hero progress ring', async () => {
    const { d } = director();
    await d.load();
    expect(d.seek(3250).layers.bottlenecks.pulseState).toEqual({ phase: 0.25, active: [0] });
    expect(d.seek(6500).layers.elevatorMarkers.pulseState?.active).toEqual([]);  // Helga far from the elevator
    const near = d.seek(7500);                                                    // Helga at the elevator
    expect(near.layers.elevatorMarkers.pulseState?.active).toEqual([0]);
    expect(near.layers.heroProgress.progress?.fraction).toBeCloseTo(0.5, 6);
    expect(near.layers.heroProgress.progress?.hero).toBe('helga');
    expect(d.seek(1000).layers.heroProgress.progress).toBeNull();
  });

  it('fades captions and renders bound values from the active result', async () => {
    const { d } = director();
    await d.load();
    expect(d.seek(2250).captions.find((c) => c.id === 'markus')?.opacity).toBe(0.5);
    const s = d.seek(4000);
    expect(text(s, 'markus')).toBe('Markus: 23');
    expect(text(s, 'friction')).toBe('bollard at Königstraße · 05:34');
    for (const t of KEY_TIMES) expectBindingsMatchScope(d.seek(t));
  });

  it('renders unresolved bindings as a dash and logs each one once', async () => {
    const { d, log } = director();
    await d.load();
    const s = d.seek(4000);
    d.seek(4100);
    d.seek(4200);
    expect(text(s, 'broken')).toBe(`Market ${UNRESOLVED} · ${UNRESOLVED}`);
    expect(s.errors).toEqual([
      { captionId: 'broken', path: 'derived.active.marketScore', reason: 'not-scalar' },
      { captionId: 'broken', path: 'personas.vendor.nope', reason: 'missing' },
    ]);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('renders derived values from the injected functions', async () => {
    const { d } = director({ derive: (r) => ({ marketScore: r.criteria.accessibility + 0.4, consensus: 0.7 }) });
    await d.load();
    expect(text(d.seek(4000), 'broken')).toBe(`Market 50 · ${UNRESOLVED}`);
  });
});

describe('mitigation gate', () => {
  it('clamps time at the gate until the action resolves', async () => {
    const { d } = director();
    await d.load();
    let s = d.seek(12000);
    expect(s.tMs).toBe(9000);
    expect(s.phase).toBe('awaiting-action');
    expect(d.step(500).tMs).toBe(9000);
    s = d.seek(4000);
    expect(s.phase).toBe('paused');
  });

  it('rejects apply when no gate is pending', async () => {
    const { d } = director();
    await d.load();
    d.seek(1000);
    await expect(d.apply()).rejects.toThrow(/no gate pending/);
  });

  it('reruns once with the brief mitigations and switches results at the gate', async () => {
    const { d, calls } = director();
    await d.load();
    d.seek(9000);
    const pending = d.apply();
    expect(d.state.phase).toBe('rerunning');
    expect(d.apply()).toBe(pending);
    const s = await pending;
    expect(s.phase).toBe('paused');
    expect(calls.slice(1)).toEqual([{ candidateId: 'kaufhof', scenario: 'RAINY_SAT', mitigations: [KIOSK, 'delivery-window:05:00-06:30'], seed: 42 }]);

    const late = d.seek(12000);
    expect(late.tMs).toBe(12000);
    expect(late.result?.mitigations).toEqual([KIOSK, 'delivery-window:05:00-06:30']);
    expect(late.scope?.brief).toEqual(BRIEF);
    expect(text(late, 'delta')).toBe('12 → 64');
    expect(text(late, 'seed')).toBe('seed 42');
    expectBindingsMatchScope(late);
    expect(late.layers.kioskMarkers.on).toBe(true);
    expect(d.seek(8000).result?.mitigations).toEqual([]);
    expect(d.seek(9000).result?.mitigations).toEqual([KIOSK, 'delivery-window:05:00-06:30']);
    await expect(d.apply()).rejects.toThrow(/no gate pending/);
  });

  it('falls back to the cached brief when the brief call fails', async () => {
    const { d, calls, log } = director({ briefClient: downBrief, fallbackBrief: okBrief });
    await d.load();
    d.seek(9000);
    const s = await d.apply();
    expect(s.phase).toBe('paused');
    expect(calls).toHaveLength(2);
    expect(log.mock.calls.some(([m]) => /cached brief/.test(String(m)))).toBe(true);
  });

  it('keeps the camera still across the gate when the rerun moves the hero', async () => {
    // The rerun's Helga trip passes the same elevator but ends 300 m north instead of 200 m east.
    const afterTrips = TRIPS.map((t) => (t.persona === 'senior' ? trip('senior', [[100, -300, 36000], [100, 0, 36300], [100, 300, 36600]]) : t));
    const sim: SimClient = {
      ...fakeSim().sim,
      run: async (_c, scenario, mitigations) =>
        mitigations.length ? { ...makeResult(scenario, mitigations, 64), trips: afterTrips } : makeResult(scenario, mitigations, 12),
    };
    // A linear move out of the gate keyframe starts from K2's end pose, the Helga follow-cam.
    const def: SceneDef = { ...DEF, keyframes: DEF.keyframes.map((k) => (k.gate ? { ...k, transition: 'linear', transitionMs: 1000 } : k)) };
    const d = createDirector({ def, sim, briefClient: okBrief, dataSource: 'fixtures', loadAssets: async () => ASSETS, log: vi.fn() });
    await d.load();

    const held = d.seek(9000).viewState;
    const beforeEnd = offsetLngLat(tripPositionAt(TRIPS[2], 36600, true)!, 90, -60);
    expect(haversineM([held.longitude, held.latitude], beforeEnd)).toBeLessThan(0.01);
    await d.apply();
    const resolved = d.seek(9000);
    expect(resolved.scope?.heroes.helga).toEqual({ hero: 'helga', tripIndex: 2 });
    expect(haversineM(tripPositionAt(afterTrips[2], 36600, true)!, tripPositionAt(TRIPS[2], 36600, true)!)).toBeGreaterThan(300);
    expect(resolved.viewState).toEqual(held);
    const centre = (v: SceneViewState): [number, number] => [v.longitude, v.latitude];
    expect(haversineM(centre(d.seek(8999).viewState), centre(held))).toBeLessThan(1);
    expect(haversineM(centre(d.seek(9010).viewState), centre(held))).toBeLessThan(5);
  });

  it('shows an error and allows a retry when the rerun fails', async () => {
    const { sim } = fakeSim({ failRun: true });
    const d = createDirector({ def: DEF, sim, briefClient: okBrief, dataSource: 'fixtures', log: vi.fn() });
    await d.load();
    d.seek(9000);
    const s = await d.apply();
    expect(s.phase).toBe('error');
    expect(s.error).toMatch(/engine down/);
    expect(s.tMs).toBe(9000);
    expect(d.seek(12000).tMs).toBe(9000);
    await expect(d.apply()).resolves.toMatchObject({ phase: 'error' });
  });
});

describe('live loop', () => {
  it('steps from frame deltas, clamps gaps, halts at the gate and resumes after apply', async () => {
    const { frames, tick, pending } = fakeFrames();
    const { d } = director({ frames, maxFrameMs: 100 });
    await d.load();
    d.play();
    expect(d.state.phase).toBe('playing');
    tick(16); // first frame sets the baseline
    tick(16);
    expect(d.state.tMs).toBe(16);
    tick(5000); // background tab: clamped
    expect(d.state.tMs).toBe(116);
    d.pause();
    expect(d.state.phase).toBe('paused');
    expect(pending()).toBe(0);
    d.seek(8950);
    d.play();
    tick(16); tick(50); tick(50);
    expect(d.state.tMs).toBe(9000);
    expect(d.state.phase).toBe('awaiting-action');
    expect(pending()).toBe(0);
    await d.apply();
    expect(d.state.phase).toBe('playing');
    tick(16); tick(100);
    expect(d.state.tMs).toBe(9100);
    d.seek(13990);
    tick(100);
    expect(d.state.phase).toBe('ended');
    expect(pending()).toBe(0);
  });

  it('notifies subscribers and stops after dispose', async () => {
    const { d } = director();
    const listener = vi.fn();
    const off = d.subscribe(listener);
    await d.load();
    d.seek(100);
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    d.seek(200);
    expect(listener).toHaveBeenCalledTimes(2);
    d.dispose();
    expect(d.seek(300).tMs).toBe(200);
  });
});

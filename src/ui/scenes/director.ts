/**
 * Scene director. `evaluateScene` turns a `SceneDef` plus engine output into
 * the `SceneState` for one scene time; it is pure in its inputs and `tMs`.
 * `createDirector` wraps it with loading, the mitigation gate, the live rAF
 * loop and the `window.__scene` API. See `types.ts` for the determinism rules.
 */

import { FlyToInterpolator } from '@deck.gl/core';
import type { Brief, Candidate, PersonaId, SimulationResult, TimeSlice } from '../../contracts';
import type { BriefClient, BriefInput, SimClient } from '../adapters/types';
import { getState } from '../state/store';
import { parseTemplate, resolveCaption, resolveDetailed, TemplateParseError } from './bind';
import {
  graphNodesOf,
  kioskPositions,
  offsetLngLat,
  passedWithin,
  pickHeroes,
  tripPositionAt,
  tripStart,
  tripEnd,
  type LngLat,
} from './heroes';
import type {
  AnchorRef,
  BindingError,
  BindingScope,
  CameraSpec,
  DerivedValues,
  HeroId,
  HeroPick,
  KeyframeInfo,
  LayerToggle,
  MarkerLayerId,
  PulseSpec,
  ResolvedCaption,
  ResolvedLayer,
  ResolvedProgress,
  ResolvedPulse,
  SceneApi,
  SceneAssets,
  SceneDataSource,
  SceneDef,
  SceneLayerId,
  SceneMs,
  ScenePhase,
  SceneState,
  SceneViewState,
  SimSec,
} from './types';

/* ------------------------------------------------------------------------ */
/* Constants                                                                 */
/* ------------------------------------------------------------------------ */

/** Every layer id in a fixed order, so `SceneState.layers` never depends on toggle order. */
export const LAYER_IDS: readonly SceneLayerId[] = [
  'terrain', 'buildings', 'candidateOutline', 'arrivalTicks', 'stepsEdges', 'shelteredEdges', 'rainOverlay',
  'bollardMarkers', 'elevatorMarkers', 'loadingMarker', 'kioskMarkers',
  'trips', 'heatmap', 'bottlenecks', 'heroProgress',
];

const PERSONA_ORDER: readonly PersonaId[] = ['senior', 'vendor', 'commuter', 'retailer'];
const TIME_SLICES: readonly TimeSlice[] = ['05:30_DELIVERY', '11:30_PEAK', '15:00_LULL'];

/** Pulse period when a `PulseSpec` omits `periodMs`. */
export const DEFAULT_PULSE_MS: SceneMs = 1200;
/** Viewport the fly interpolator plans for. The recorder captures at this size. */
export const DEFAULT_VIEWPORT = { width: 1920, height: 1080 } as const;
/** Largest rAF gap fed into `step`, so a background tab does not skip a keyframe. */
export const DEFAULT_MAX_FRAME_MS: SceneMs = 100;
/** Camera framing when a scene has no fixed camera and its first anchor does not resolve. */
const FALLBACK_VIEW: SceneViewState = { longitude: 11.0775, latitude: 49.4515, zoom: 15, pitch: 0, bearing: 0 };

export const EMPTY_ASSETS: SceneAssets = { arrivals: null, graphNodes: null };

/**
 * Stand-in until the real functions land. Unresolved values render `—`.
 * TODO(subagent): wire D's `score(result.criteria, weights)` and the cockpit's
 * consensus function through `DirectorOptions.derive`; neither exists in this
 * worktree yet.
 */
const UNKNOWN_DERIVED: DerivedValues = { marketScore: NaN, consensus: NaN };

const fly = new FlyToInterpolator();

const clamp01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);
const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

/* ------------------------------------------------------------------------ */
/* Scene definition helpers                                                  */
/* ------------------------------------------------------------------------ */

export function sceneDurationMs(def: SceneDef): SceneMs {
  const last = def.keyframes[def.keyframes.length - 1];
  return last ? last.t + last.durationMs : 0;
}

/** Index of the keyframe that covers `tMs`: the last one with `t <= tMs`. */
export function keyframeIndexAt(def: SceneDef, tMs: SceneMs): number {
  let k = 0;
  for (let i = 0; i < def.keyframes.length; i++) if (def.keyframes[i].t <= tMs) k = i;
  return k;
}

/** Start time of the mitigation gate, or `null` when the scene has none. */
export function gateTime(def: SceneDef): SceneMs | null {
  return def.keyframes.find((k) => k.gate)?.t ?? null;
}

/** Clamps a requested time to `[0, duration]` and to an unresolved gate. */
export function clampSceneTime(def: SceneDef, tMs: SceneMs, gateResolved: boolean): SceneMs {
  const t = Number.isFinite(tMs) ? Math.min(Math.max(tMs, 0), sceneDurationMs(def)) : 0;
  const gate = gateTime(def);
  return gate !== null && !gateResolved && t > gate ? gate : t;
}

function heroesNamed(def: SceneDef): Set<HeroId> {
  const out = new Set<HeroId>();
  const fromAnchor = (a: AnchorRef) => { if (a.kind === 'hero') out.add(a.hero); };
  for (const k of def.keyframes) {
    if (k.camera.kind === 'follow') out.add(k.camera.hero);
    if (k.camera.kind === 'anchor') fromAnchor(k.camera.anchor);
    for (const l of k.layers) {
      if (l.layer === 'trips' && l.highlight) out.add(l.highlight);
      if (l.layer === 'heroProgress') out.add(l.hero);
      const pulse = 'pulse' in l ? (l.pulse as PulseSpec | undefined) : undefined;
      if (pulse?.trigger === 'heroNear') out.add(pulse.hero);
    }
  }
  return out;
}

/** Lists every structural problem in a scene definition. Empty means valid. */
export function validateSceneDef(def: SceneDef): string[] {
  const problems: string[] = [];
  const kfs = def.keyframes;
  if (!kfs.length) problems.push('scene has no keyframes');
  const ids = new Set<string>();
  const captionIds = new Set<string>();
  let expectedT = 0;
  kfs.forEach((k, i) => {
    if (ids.has(k.id)) problems.push(`duplicate keyframe id ${k.id}`);
    ids.add(k.id);
    if (k.t !== expectedT) problems.push(`keyframe ${k.id} starts at ${k.t}, expected ${expectedT}`);
    if (!(k.durationMs > 0)) problems.push(`keyframe ${k.id} needs durationMs > 0`);
    expectedT = k.t + k.durationMs;
    if (k.gate && kfs.findIndex((x) => x.gate) !== i) problems.push(`keyframe ${k.id}: only one gate per scene`);
    for (const c of k.captions) {
      if (captionIds.has(c.id)) problems.push(`duplicate caption id ${c.id}`);
      captionIds.add(c.id);
      try { parseTemplate(c.template); } catch (e) {
        if (!(e instanceof TemplateParseError)) throw e;
        problems.push(`caption ${c.id}: ${e.message}`);
      }
    }
  });
  const ruled = new Set<HeroId>();
  for (const r of def.heroes) {
    if (ruled.has(r.hero)) problems.push(`hero ${r.hero} has more than one rule`);
    ruled.add(r.hero);
  }
  for (const h of heroesNamed(def)) if (!ruled.has(h)) problems.push(`hero ${h} is used but has no rule`);
  return problems;
}

/* ------------------------------------------------------------------------ */
/* Inputs                                                                    */
/* ------------------------------------------------------------------------ */

/** Values computed once per result: hero picks, derived values and kiosks. */
export interface ResultContext {
  result: SimulationResult;
  heroes: Record<HeroId, HeroPick | null>;
  derived: DerivedValues;
  kiosks: [number, number][];
}

export function prepareResult(
  def: SceneDef,
  result: SimulationResult,
  assets: SceneAssets,
  derive?: (result: SimulationResult) => DerivedValues,
): ResultContext {
  return {
    result,
    heroes: pickHeroes(def.heroes, result, assets),
    derived: derive ? derive(result) : UNKNOWN_DERIVED,
    kiosks: kioskPositions(result),
  };
}

/** Everything `evaluateScene` reads besides `tMs`. Replace the object when any field changes. */
export interface SceneInputs {
  def: SceneDef;
  before: ResultContext | null;
  /** Set once the gate action resolved. */
  after: ResultContext | null;
  brief: Brief | null;
  candidate: Candidate | null;
  assets: SceneAssets;
  dataSource: SceneDataSource;
  viewport: { width: number; height: number };
}

/** Per-inputs memo of keyframe end poses. Pure: the key object never mutates. */
const endPoseCache = new WeakMap<SceneInputs, Map<number, SceneViewState>>();

/* ------------------------------------------------------------------------ */
/* Sim clock                                                                 */
/* ------------------------------------------------------------------------ */

function firstStatedClock(def: SceneDef): SimSec {
  for (const k of def.keyframes) {
    if (k.sim.mode === 'run') return k.sim.from;
    if (k.sim.at !== undefined) return k.sim.at;
  }
  return 0;
}

/**
 * Sim clock of keyframe `k` at `tMs`. A paused keyframe without `at` holds the
 * previous keyframe's end value; the first keyframe falls back to the first
 * clock value stated anywhere in the scene.
 */
export function simClockAt(def: SceneDef, k: number, tMs: SceneMs): SimSec {
  for (let i = k; i >= 0; i--) {
    const kf = def.keyframes[i];
    const at = i === k ? tMs : kf.t + kf.durationMs;
    if (kf.sim.mode === 'run') return lerp(kf.sim.from, kf.sim.to, clamp01((at - kf.t) / kf.durationMs));
    if (kf.sim.at !== undefined) return kf.sim.at;
  }
  return firstStatedClock(def);
}

/* ------------------------------------------------------------------------ */
/* Camera                                                                    */
/* ------------------------------------------------------------------------ */

function polygonCentroid(poly: readonly (readonly [number, number])[]): LngLat | null {
  if (!poly.length) return null;
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    const cross = x0 * y1 - x1 * y0;
    a += cross; cx += (x0 + x1) * cross; cy += (y0 + y1) * cross;
  }
  if (Math.abs(a) < 1e-15) {
    const n = poly.length;
    return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

function heroTrip(ctx: ResultContext | null, hero: HeroId) {
  const pick = ctx?.heroes[hero];
  return pick ? ctx!.result.trips[pick.tripIndex] ?? null : null;
}

function anchorPosition(anchor: AnchorRef, inputs: SceneInputs, ctx: ResultContext | null, simSec: SimSec): LngLat | null {
  switch (anchor.kind) {
    case 'bottleneck': {
      const b = ctx?.result.bySlice[anchor.slice]?.bottlenecks.find((x) => x.type === anchor.type);
      return b ? [b.lng, b.lat] : null;
    }
    case 'hero': {
      const trip = heroTrip(ctx, anchor.hero);
      return trip ? tripPositionAt(trip, simSec, true) : null;
    }
    case 'candidate':
      return inputs.candidate ? polygonCentroid(inputs.candidate.polygon) : null;
    case 'graphNode': {
      const n = graphNodesOf(inputs.assets, anchor.node)[0];
      return n ? [n.lng, n.lat] : null;
    }
  }
}

/**
 * Camera target of a keyframe. A follow-cam keeps the hero `offsetM` metres
 * ahead of the view centre along `pose.bearing`, so the camera trails the hero
 * and the hero sits in the lower half of the frame.
 */
function cameraTarget(camera: CameraSpec, inputs: SceneInputs, ctx: ResultContext | null, simSec: SimSec): SceneViewState | null {
  if (camera.kind === 'fixed') return { ...camera.viewState };
  if (camera.kind === 'anchor') {
    const p = anchorPosition(camera.anchor, inputs, ctx, simSec);
    return p ? { longitude: p[0], latitude: p[1], ...camera.pose } : null;
  }
  const trip = heroTrip(ctx, camera.hero);
  const p = trip ? tripPositionAt(trip, simSec, true) : null;
  if (!p) return null;
  const [longitude, latitude] = offsetLngLat(p, camera.pose.bearing, -camera.offsetM);
  return { longitude, latitude, ...camera.pose };
}

function basePose(def: SceneDef): SceneViewState {
  const fixed = def.keyframes.find((k) => k.camera.kind === 'fixed')?.camera;
  return fixed?.kind === 'fixed' ? { ...fixed.viewState } : { ...FALLBACK_VIEW };
}

function interpolatePose(kind: 'fly' | 'linear', a: SceneViewState, b: SceneViewState, p: number, inputs: SceneInputs): SceneViewState {
  if (p <= 0) return { ...a };
  if (p >= 1) return { ...b };
  if (kind === 'fly') {
    const v = fly.interpolateProps({ ...a, ...inputs.viewport }, { ...b, ...inputs.viewport }, p) as SceneViewState;
    return { longitude: v.longitude, latitude: v.latitude, zoom: v.zoom, pitch: v.pitch, bearing: v.bearing };
  }
  return {
    longitude: lerp(a.longitude, b.longitude, p),
    latitude: lerp(a.latitude, b.latitude, p),
    zoom: lerp(a.zoom, b.zoom, p),
    pitch: lerp(a.pitch, b.pitch, p),
    bearing: lerp(a.bearing, b.bearing, p),
  };
}

/** Active result context at a scene time: `after` from the gate onward once resolved. */
function contextAt(inputs: SceneInputs, tMs: SceneMs): ResultContext | null {
  const gate = gateTime(inputs.def);
  return inputs.after && gate !== null && tMs >= gate ? inputs.after : inputs.before;
}

/**
 * End pose of keyframe `k`, which is also the start pose of keyframe `k + 1`.
 * It uses the result active within keyframe `k`. The gate starts a keyframe,
 * so a keyframe ending at the gate keeps `before` and the camera does not jump
 * when the rerun resolves.
 */
function endPose(inputs: SceneInputs, k: number): SceneViewState {
  let cache = endPoseCache.get(inputs);
  if (!cache) endPoseCache.set(inputs, (cache = new Map()));
  const hit = cache.get(k);
  if (hit) return hit;
  const kf = inputs.def.keyframes[k];
  const pose = poseAt(inputs, k, kf.t + kf.durationMs, contextAt(inputs, kf.t));
  cache.set(k, pose);
  return pose;
}

/** Camera pose of keyframe `k` at `tMs`. An unresolved target holds the start pose. */
function poseAt(inputs: SceneInputs, k: number, tMs: SceneMs, ctx: ResultContext | null): SceneViewState {
  const def = inputs.def;
  const kf = def.keyframes[k];
  const start = k > 0 ? endPose(inputs, k - 1) : null;
  const target = cameraTarget(kf.camera, inputs, ctx, simClockAt(def, k, tMs));
  if (!target) return start ? { ...start } : basePose(def);
  if (!start || kf.transition === 'cut') return target;
  const span = Math.min(kf.transitionMs, kf.durationMs);
  const p = span > 0 ? clamp01((tMs - kf.t) / span) : 1;
  return interpolatePose(kf.transition, start, target, p, inputs);
}

/* ------------------------------------------------------------------------ */
/* Layers                                                                    */
/* ------------------------------------------------------------------------ */

function defaultToggle(layer: SceneLayerId): LayerToggle {
  switch (layer) {
    case 'trips': return { layer, on: false, personas: [] };
    case 'heatmap': return { layer, on: false, slice: TIME_SLICES[0] };
    case 'bottlenecks': return { layer, on: false, slice: TIME_SLICES[0] };
    case 'heroProgress': return { layer, on: false, hero: 'markus', budget: { kind: 'tripDuration' } };
    default: return { layer, on: false } as LayerToggle;
  }
}

/** Off toggles keep the last on-state's data, so a fade-out renders what faded in. */
function mergeToggle(prev: LayerToggle, next: LayerToggle): LayerToggle {
  if (next.on) {
    return next.layer === 'trips'
      ? { ...next, personas: PERSONA_ORDER.filter((p) => next.personas.includes(p)) }
      : next;
  }
  const merged = { ...prev, on: false } as LayerToggle & { opacity?: number; fade?: { ms: number } };
  delete merged.opacity;
  delete merged.fade;
  if (next.opacity !== undefined) merged.opacity = next.opacity;
  if (next.fade !== undefined) merged.fade = next.fade;
  return merged;
}

interface FoldedLayer {
  toggle: LayerToggle;
  opacity: number;
  toggled: boolean;
}

function foldLayer(def: SceneDef, layer: SceneLayerId, k: number, tMs: SceneMs): FoldedLayer {
  let toggle = defaultToggle(layer);
  let toggled = false;
  let from = 0, target = 0, start = 0, fadeMs = 0;
  const opacityAt = (t: number) => (fadeMs > 0 ? lerp(from, target, clamp01((t - start) / fadeMs)) : target);
  for (let i = 0; i <= k; i++) {
    const kf = def.keyframes[i];
    for (const tg of kf.layers) {
      if (tg.layer !== layer) continue;
      from = opacityAt(kf.t);
      start = kf.t;
      target = tg.on ? tg.opacity ?? 1 : 0;
      fadeMs = tg.fade?.ms ?? 0;
      toggle = mergeToggle(toggle, tg);
      toggled = true;
    }
  }
  return { toggle, opacity: opacityAt(tMs), toggled };
}

const MARKER_ROLE: Record<Exclude<MarkerLayerId, 'kioskMarkers'>, 'bollard' | 'elevator' | 'loading'> = {
  bollardMarkers: 'bollard',
  elevatorMarkers: 'elevator',
  loadingMarker: 'loading',
};

/** Item positions of a pulsable layer, in the layer's data order. */
export function layerItems(toggle: LayerToggle, assets: SceneAssets, ctx: ResultContext | null): LngLat[] {
  switch (toggle.layer) {
    case 'kioskMarkers':
      return ctx ? ctx.kiosks : [];
    case 'bollardMarkers':
    case 'elevatorMarkers':
    case 'loadingMarker':
      return graphNodesOf(assets, MARKER_ROLE[toggle.layer]).map((n) => [n.lng, n.lat]);
    case 'bottlenecks': {
      const list = ctx?.result.bySlice[toggle.slice]?.bottlenecks ?? [];
      return list.filter((b) => !toggle.types || toggle.types.includes(b.type)).map((b) => [b.lng, b.lat]);
    }
    default:
      return [];
  }
}

function resolvePulse(pulse: PulseSpec, items: LngLat[], ctx: ResultContext | null, tMs: SceneMs, simSec: SimSec): ResolvedPulse {
  const period = pulse.periodMs && pulse.periodMs > 0 ? pulse.periodMs : DEFAULT_PULSE_MS;
  const phase = (((tMs % period) + period) % period) / period;
  if (pulse.trigger === 'always') return { phase, active: items.map((_, i) => i) };
  const trip = heroTrip(ctx, pulse.hero);
  if (!trip) return { phase, active: [] };
  const t0 = simSec - (pulse.lingerSec ?? 0);
  const active: number[] = [];
  items.forEach((p, i) => { if (passedWithin(trip, p, pulse.withinM, t0, simSec)) active.push(i); });
  return { phase, active };
}

function resolveProgress(
  toggle: Extract<LayerToggle, { layer: 'heroProgress' }>,
  ctx: ResultContext | null,
  scope: BindingScope | null,
  simSec: SimSec,
  errors: BindingError[],
): ResolvedProgress {
  const trip = heroTrip(ctx, toggle.hero);
  const t0 = trip ? tripStart(trip) : null;
  if (!trip || t0 === null) return { hero: toggle.hero, position: null, fraction: 0 };
  let budget: number | null = null;
  if (toggle.budget.kind === 'tripDuration') {
    budget = tripEnd(trip)! - t0;
  } else if (scope) {
    const out = resolveDetailed(scope, toggle.budget.path);
    if (!out.ok) errors.push({ captionId: 'layer:heroProgress', path: toggle.budget.path, reason: out.reason });
    else if (typeof out.value !== 'number') errors.push({ captionId: 'layer:heroProgress', path: toggle.budget.path, reason: 'not-scalar' });
    else budget = out.value;
  }
  const elapsed = simSec - t0;
  const fraction = budget === null ? 0 : budget > 0 ? clamp01(elapsed / budget) : elapsed >= 0 ? 1 : 0;
  return { hero: toggle.hero, position: tripPositionAt(trip, simSec, true), fraction };
}

/* ------------------------------------------------------------------------ */
/* Evaluation                                                                */
/* ------------------------------------------------------------------------ */

/** `SceneState` without the lifecycle fields the director owns. */
export type SceneFrame = Omit<SceneState, 'phase' | 'error'>;

function buildScope(inputs: SceneInputs, ctx: ResultContext, simSec: SimSec): BindingScope {
  const { def, before, after } = inputs;
  return {
    result: ctx.result,
    before: before!.result,
    after: after ? after.result : null,
    brief: inputs.brief,
    derived: { active: ctx.derived, before: before!.derived, after: after ? after.derived : null },
    scene: { simSec, seed: def.seed, scenario: def.scenario, candidateId: def.candidateId, dataSource: inputs.dataSource },
    heroes: ctx.heroes,
    assets: inputs.assets,
  };
}

function captionOpacity(tMs: SceneMs, start: SceneMs, durationMs: SceneMs, fadeMs: number | undefined): number {
  if (!fadeMs || fadeMs <= 0) return 1;
  return clamp01(Math.min(tMs - start, start + durationMs - tMs) / fadeMs);
}

/**
 * The scene at `requestedMs`, clamped to the scene span and to an unresolved
 * gate. Pure: equal inputs and time give equal output, whatever came before.
 */
export function evaluateScene(inputs: SceneInputs, requestedMs: SceneMs): SceneFrame {
  const { def } = inputs;
  const tMs = clampSceneTime(def, requestedMs, inputs.after !== null);
  const k = keyframeIndexAt(def, tMs);
  const kf = def.keyframes[k];
  const simSec = simClockAt(def, k, tMs);
  const ctx = contextAt(inputs, tMs);
  const scope = ctx && inputs.before ? buildScope(inputs, ctx, simSec) : null;
  const errors: BindingError[] = [];

  const layers = {} as Record<SceneLayerId, ResolvedLayer>;
  for (const id of LAYER_IDS) {
    const { toggle, opacity, toggled } = foldLayer(def, id, k, tMs);
    const pulse = 'pulse' in toggle ? (toggle.pulse as PulseSpec | undefined) : undefined;
    layers[id] = {
      ...toggle,
      currentOpacity: opacity,
      pulseState: pulse ? resolvePulse(pulse, layerItems(toggle, inputs.assets, ctx), ctx, tMs, simSec) : null,
      progress: toggle.layer === 'heroProgress' && toggled ? resolveProgress(toggle, ctx, scope, simSec, errors) : null,
    } as ResolvedLayer;
  }

  const captions: ResolvedCaption[] = [];
  if (scope) {
    for (const c of kf.captions) {
      const out = resolveCaption(c, scope, captionOpacity(tMs, kf.t, kf.durationMs, c.fadeMs));
      captions.push(out.caption);
      errors.push(...out.errors);
    }
  }

  return {
    sceneId: def.id,
    tMs,
    durationMs: sceneDurationMs(def),
    keyframeId: kf.id,
    keyframeIndex: k,
    simSec,
    viewState: poseAt(inputs, k, tMs, ctx),
    layers,
    captions,
    result: scope ? scope.result : null,
    scope,
    errors,
  };
}

/* ------------------------------------------------------------------------ */
/* Director                                                                  */
/* ------------------------------------------------------------------------ */

/** The one wall-clock boundary: rAF in the browser, a fake in tests. */
export interface FrameScheduler {
  request(cb: (timestampMs: number) => void): number;
  cancel(handle: number): void;
}

export interface DirectorOptions {
  def: SceneDef;
  sim: SimClient;
  briefClient: BriefClient;
  /** Cached brief used when `briefClient.brief` fails, for example with the network blocked. */
  fallbackBrief?: BriefClient;
  dataSource: SceneDataSource;
  /** Loads `arrivals.json` and `graph.json` nodes. Failure leaves the assets empty. */
  loadAssets?: () => Promise<SceneAssets>;
  /** Market score and consensus from the project's own functions. See `UNKNOWN_DERIVED`. */
  derive?: (result: SimulationResult) => DerivedValues;
  /** Brief request for the gate. Defaults to the scene's baseline result plus store results and weights. */
  briefInput?: (data: { candidates: Candidate[]; before: SimulationResult }) => BriefInput;
  viewport?: { width: number; height: number };
  frames?: FrameScheduler;
  maxFrameMs?: SceneMs;
  /** Error sink for binding and load errors. Defaults to `console.error`. */
  log?: (message: string, detail?: unknown) => void;
}

export interface Director extends SceneApi {
  /** Loads candidates, assets and the baseline result. Safe to call more than once. */
  load(): Promise<SceneState>;
  /** Notifies on every state change. Fits `useSyncExternalStore` with `getState`. */
  subscribe(listener: () => void): () => void;
  getState(): SceneState;
  dispose(): void;
}

const browserFrames = (): FrameScheduler => ({
  request: (cb) => window.requestAnimationFrame(cb),
  cancel: (h) => window.cancelAnimationFrame(h),
});

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createDirector(opts: DirectorOptions): Director {
  const { def } = opts;
  const problems = validateSceneDef(def);
  if (problems.length) throw new Error(`invalid SceneDef ${def.id}: ${problems.join('; ')}`);

  const log = opts.log ?? ((msg: string, detail?: unknown) => console.error(msg, detail));
  const maxFrameMs = opts.maxFrameMs ?? DEFAULT_MAX_FRAME_MS;
  const keyframes: readonly KeyframeInfo[] = def.keyframes.map((k) => ({
    id: k.id, t: k.t, durationMs: k.durationMs, gated: Boolean(k.gate),
  }));
  const gate = gateTime(def);

  let inputs: SceneInputs = {
    def, before: null, after: null, brief: null, candidate: null,
    assets: EMPTY_ASSETS, dataSource: opts.dataSource, viewport: opts.viewport ?? DEFAULT_VIEWPORT,
  };
  let candidates: Candidate[] = [];
  let tMs: SceneMs = 0;
  let started = false;
  let wantsPlay = false;
  let looping = false;
  let frameHandle: number | null = null;
  let lastTs: number | null = null;
  let rerun: Promise<SceneState> | null = null;
  let loading: Promise<SceneState> | null = null;
  let error: string | undefined;
  let disposed = false;
  const logged = new Set<string>();
  const listeners = new Set<() => void>();
  let frames: FrameScheduler | null = opts.frames ?? null;

  const phaseOf = (frame: SceneFrame): ScenePhase => {
    if (!inputs.before) return error ? 'error' : 'loading';
    if (rerun) return 'rerunning';
    if (error) return 'error';
    if (gate !== null && !inputs.after && frame.tMs >= gate) return 'awaiting-action';
    if (frame.tMs >= frame.durationMs) return 'ended';
    if (looping) return 'playing';
    return started ? 'paused' : 'ready';
  };

  const compute = (): SceneState => {
    const frame = evaluateScene(inputs, tMs);
    const next: SceneState = { ...frame, phase: phaseOf(frame) };
    if (error) next.error = error;
    for (const e of frame.errors) {
      const key = `${e.captionId}|${e.path}|${e.reason}`;
      if (!logged.has(key)) { logged.add(key); log(`[scene ${def.id}] unresolved binding ${e.path} (${e.reason})`, e); }
    }
    return next;
  };

  let state = compute();

  const update = () => {
    if (disposed) return;
    state = compute();
    listeners.forEach((l) => l());
  };

  const stopLoop = () => {
    looping = false;
    lastTs = null;
    if (frameHandle !== null && frames) frames.cancel(frameHandle);
    frameHandle = null;
  };

  const halted = (p: ScenePhase) => p === 'ended' || p === 'awaiting-action' || p === 'error' || p === 'rerunning';

  const onFrame = (ts: number) => {
    frameHandle = null;
    if (!looping || disposed) return;
    const dt = lastTs === null ? 0 : Math.min(Math.max(ts - lastTs, 0), maxFrameMs);
    lastTs = ts;
    if (inputs.before) seekTo(tMs + dt);
    if (halted(state.phase)) { stopLoop(); update(); return; }
    frameHandle = frames!.request(onFrame);
  };

  const startLoop = () => {
    if (looping || disposed) return;
    frames ??= browserFrames();
    looping = true;
    lastTs = null;
    frameHandle = frames.request(onFrame);
  };

  const seekTo = (t: SceneMs) => {
    started = true;
    tMs = clampSceneTime(def, t, inputs.after !== null);
    update();
    return state;
  };

  const buildBriefInput = (): BriefInput => {
    const before = inputs.before!.result;
    if (opts.briefInput) return opts.briefInput({ candidates, before });
    const s = getState();
    const others = Object.values(s.results).filter((r) => r.scenario === def.scenario && r.candidateId !== def.candidateId);
    return { candidates, results: [before, ...others], weights: s.weights, scenario: def.scenario };
  };

  const fetchBrief = async (input: BriefInput): Promise<Brief> => {
    try {
      return await opts.briefClient.brief(input);
    } catch (e) {
      if (!opts.fallbackBrief) throw e;
      log(`[scene ${def.id}] brief failed, using cached brief: ${message(e)}`);
      return opts.fallbackBrief.brief(input);
    }
  };

  const director: Director = {
    get state() { return state; },
    get keyframes() { return keyframes; },
    getState: () => state,

    step: (dtMs) => seekTo(tMs + (Number.isFinite(dtMs) ? dtMs : 0)),
    seek: (t) => seekTo(t),

    play() {
      if (disposed) return;
      wantsPlay = true;
      started = true;
      if (state.phase === 'ended') tMs = 0;
      if (!halted(phaseOf(evaluateScene(inputs, tMs)))) startLoop();
      update();
    },

    pause() {
      wantsPlay = false;
      stopLoop();
      update();
    },

    apply() {
      if (rerun) return rerun;
      const pending = inputs.before && gate !== null && !inputs.after && tMs >= gate;
      if (!pending || disposed) return Promise.reject(new Error(`scene ${def.id}: no gate pending`));
      error = undefined;
      rerun = (async () => {
        try {
          const brief = await fetchBrief(buildBriefInput());
          const result = await opts.sim.run(def.candidateId, def.scenario, brief.losers.map((l) => l.mitigation), def.seed);
          if (disposed) return state;
          inputs = { ...inputs, brief, after: prepareResult(def, result, inputs.assets, opts.derive) };
        } catch (e) {
          error = `mitigation rerun failed: ${message(e)}`;
          log(`[scene ${def.id}] ${error}`, e);
        }
        rerun = null;
        if (!error && wantsPlay) startLoop();
        update();
        return state;
      })();
      update();
      return rerun;
    },

    load() {
      if (loading) return loading;
      loading = (async () => {
        const [cands, assets] = await Promise.all([
          opts.sim.candidates().catch((e) => { log(`[scene ${def.id}] candidates failed: ${message(e)}`); return [] as Candidate[]; }),
          (opts.loadAssets ?? (async () => EMPTY_ASSETS))().catch((e) => {
            log(`[scene ${def.id}] scene assets failed: ${message(e)}`);
            return EMPTY_ASSETS;
          }),
        ]);
        candidates = cands;
        try {
          const before = await opts.sim.run(def.candidateId, def.scenario, [], def.seed);
          if (disposed) return state;
          inputs = {
            ...inputs,
            assets,
            candidate: cands.find((c) => c.id === def.candidateId) ?? null,
            before: prepareResult(def, before, assets, opts.derive),
          };
        } catch (e) {
          error = `scene data failed to load: ${message(e)}`;
          log(`[scene ${def.id}] ${error}`, e);
        }
        update();
        if (wantsPlay && !halted(state.phase)) startLoop();
        return state;
      })();
      return loading;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    dispose() {
      stopLoop();
      disposed = true;
      listeners.clear();
    },
  };
  return director;
}

/** Publishes a director as `window.__scene`. Returns the matching uninstall. */
export function installSceneApi(api: SceneApi): () => void {
  window.__scene = api;
  return () => { if (window.__scene === api) delete window.__scene; };
}

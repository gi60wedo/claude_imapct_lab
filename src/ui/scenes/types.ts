/**
 * Scene contract for the scripted 3D presentation scenes (`?scene=1`, `?scene=2`).
 *
 * Scene files (`scene1.ts`, `scene2.ts`) export `SceneDef` data. The director
 * (`director.ts`) turns a `SceneDef` plus engine output into a `SceneState` for
 * any scene time. `SceneView.tsx` and `SceneHUD.tsx` render that state. This
 * file holds types only.
 *
 * ## Rule zero
 *
 * Every number on screen comes from a `SimulationResult`, a `Brief`,
 * `arrivals.json` or the score function. A `SceneDef` holds camera keyframes,
 * layer toggles, hero rules and caption templates with binding paths. It holds
 * no score, percentage or count. The UI formats engine values and computes no
 * criterion. A before/after comparison shows two engine values side by side.
 *
 * ## Determinism
 *
 * `SceneState` is a pure function of `(SceneDef, results, brief, tMs)`.
 * The live player and the video recorder therefore produce the same frames.
 *
 * - Scene time `tMs` advances only through `SceneApi.step` and `SceneApi.seek`.
 *   The director, bindings, hero rules and layer builders never read
 *   `Date.now()`, `new Date()`, `performance.now()`, timers or CSS animation
 *   clocks.
 * - The single wall-clock boundary is the live `requestAnimationFrame` loop in
 *   `SceneView.tsx`. It converts the rAF timestamp delta into `step(dtMs)` and
 *   clamps large gaps. The recorder never starts that loop. It calls
 *   `step(1000 / 30)` once per captured frame.
 * - Scene code never calls `Math.random`. Any jitter (pulse phase, rain
 *   streaks) derives from `tMs` or from a seeded generator keyed on
 *   `SceneDef.seed`.
 * - Camera motion is computed, not animated. The director evaluates
 *   `FlyToInterpolator#interpolateProps(start, end, p)` or a linear lerp at
 *   progress `p` derived from `tMs`. The `<DeckGL>` view state never receives
 *   `transitionDuration` or `transitionInterpolator`, because deck.gl runs
 *   those transitions on the wall clock.
 * - Fades and pulses render as computed opacity and radius from `tMs`, never
 *   as CSS `transition` or `animation`. The rerun spinner is the one exception,
 *   since scene time stays frozen while it shows.
 * - Ties break by ascending array index. Iteration over persona maps uses the
 *   fixed order senior, vendor, commuter, retailer, never object key order
 *   from engine JSON.
 * - `seek(t)` from any prior state returns the same `SceneState`. `step(dt)`
 *   equals `seek(state.tMs + dt)`, except at a mitigation gate (see `SceneGate`).
 *
 * ## Binding grammar
 *
 * A `CaptionTemplate` is literal text with `{…}` bindings:
 *
 * ```text
 * template   := ( literal | '{{' | '}}' | binding )*
 * binding    := '{' path ( '|' format )? '}'
 * path       := root? segment ( '.' segment | '[' selector ']' )*
 * root       := ( 'result' | 'before' | 'after' | 'brief' | 'derived'
 *               | 'scene' | 'heroes' | 'assets' ) '.'
 * segment    := [A-Za-z_][A-Za-z0-9_]*
 * selector   := integer                      e.g. stallExposure[0]
 *             | "'" [^']* "'"                e.g. bySlice['05:30_DELIVERY']
 *             | segment '=' [^\]]+           first element whose field equals the
 *                                            value, compared as strings,
 *                                            e.g. bottlenecks[type=BOLLARD_BLOCKAGE]
 * format     := 'int' | 'num1' | 'clock' | 'text'
 * ```
 *
 * - A path without a root resolves against `BindingScope.result`, the active
 *   `SimulationResult`. `{personas.vendor.score}` equals
 *   `{result.personas.vendor.score}`. No `SimulationResult` field uses a root
 *   name, so roots never shadow engine fields.
 * - `{{` and `}}` render literal braces.
 * - Default format: finite numbers render as `int` (rounded half away from
 *   zero), strings render verbatim. `num1` renders one decimal. `clock` renders
 *   a `SimSec` number as `HH:MM` and passes strings through. `text` renders
 *   `String(value)`.
 * - A path that hits `undefined`, `null`, `NaN`, an object or an array, or a
 *   selector with no match, renders `—` and records a `BindingError`. The
 *   director also logs it with `console.error`. It never substitutes a number.
 * - The HUD renders each binding part of a `ResolvedCaption` as its own element
 *   carrying `data-bind="<path>"` (format suffix excluded) and, when the
 *   template names a format, `data-format="<format>"`. An absent `data-format`
 *   means the default format. RZ-live reads each `ResolvedBindingPart` from
 *   `window.__scene.state.captions` and checks, for its element,
 *   `el.textContent === part.text` and
 *   `part.text === formatBinding(resolve(state.scope, part.path), part.format)`
 *   (see `FormatBinding`). This verifies `{x|clock}`, `{x|int}` and `{x|num1}`
 *   from resolved state alone. For unrooted paths without a format this equals
 *   the plan's `format(get(window.__scene.state.result, path))`.
 * - Literal text must contain no digit. RZ-static enforces this. Clock labels
 *   bind `{scene.simSec|clock}`. Line names such as the U-Bahn line bind from
 *   `assets.arrivals`.
 */

import type {
  Bottleneck,
  Brief,
  PersonaId,
  Scenario,
  SimulationResult,
  TimeSlice,
} from '../../contracts';

/* ------------------------------------------------------------------------ */
/* Contract freeze proposal (13:20). Paste-ready text for B and D.           */
/* ------------------------------------------------------------------------ */
/*
 * Q1 · Time base of `trips[].path[i][2]`
 *   Proposal: `tSec` counts seconds since 00:00 local time (Europe/Berlin) on
 *   the simulated Saturday. 05:30 = 19800, 11:30 = 41400, 15:00 = 54000.
 *   Contract change: none. Add this sentence as a comment on `trips` in
 *   `src/contracts.ts`. Related: `Bottleneck.time` uses `HH:MM` on the same
 *   local clock.
 *   Scene use: `SceneState.simSec` feeds `TripsLayer.currentTime` unchanged.
 *
 * Q2 · Commuter outcome per trip
 *   Proposal: add optional `outcome?: 'served' | 'dropped'` to the trip object
 *   in `SimulationResult.trips`.
 *   Contract change: additive and optional. B and D must approve.
 *   Fallback without it: scene 2 shows `personas.commuter.droppedOut` and
 *   `personas.commuter.topFriction`, and the `lukas` hero rule picks the
 *   longest-duration commuter trip in the 11:30 window.
 *
 * Q3 · Trip altitude
 *   Proposal: no contract change. Paths stay `[lng, lat, tSec]`.
 *   `TerrainExtension` from `@deck.gl/extensions` drapes 2D paths, markers
 *   and outlines onto the `TerrainLayer` mesh.
 *
 * Q4 · Kiosk positions after a mitigation
 *   Option A (no contract change): the engine echoes each placed kiosk in
 *   `SimulationResult.mitigations` as `"kiosk:<lng>,<lat>"`, with `.` as the
 *   decimal separator and 6 decimals. The scene parses only strings with the
 *   `kiosk:` prefix and ignores every other entry.
 *   Option B (additive, optional): `kiosks?: [number, number][]` on
 *   `SimulationResult`.
 *   B decides. Scene code reads kiosks through one helper so either option
 *   lands in one place.
 *   Open point for D and B: scene 2 passes `brief.losers[].mitigation` into
 *   `SimClient.run(…, mitigations, seed)`. Those strings come from Claude. The
 *   freeze must fix a mitigation vocabulary that the engine parses (for
 *   example `kiosk:<lng>,<lat>`, `delivery-window:<HH:MM>-<HH:MM>`), and
 *   `/api/brief` must constrain `losers[].mitigation` to it.
 */

/* ------------------------------------------------------------------------ */
/* Time                                                                      */
/* ------------------------------------------------------------------------ */

/** Scene time in milliseconds from scene start. Advances only via `SceneApi`. */
export type SceneMs = number;

/** Sim clock in seconds since 00:00 local time, the Q1 time base of `trips[].path[i][2]`. */
export type SimSec = number;

/** Scene identifier, equal to the `?scene=` URL value. */
export type SceneId = '1' | '2';

/** Data source selected by `?data=`. The HUD shows a fixture chip for `fixtures`. */
export type SceneDataSource = 'fixtures' | 'worker';

/* ------------------------------------------------------------------------ */
/* Camera                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Camera pose. Structurally compatible with deck.gl `MapViewState`, declared
 * locally so this file depends only on `src/contracts.ts`.
 */
export interface SceneViewState {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

/** Zoom, pitch and bearing for a camera whose position comes from data. */
export type CameraPose = Pick<SceneViewState, 'zoom' | 'pitch' | 'bearing'>;

/**
 * A map point that the director resolves from engine data or scene assets at
 * render time, so scene files never copy engine coordinates.
 */
export type AnchorRef =
  /** First bottleneck of `type` in `result.bySlice[slice].bottlenecks`. */
  | { kind: 'bottleneck'; slice: TimeSlice; type: Bottleneck['type'] }
  /** Interpolated position of a hero trip at the current `simSec`. */
  | { kind: 'hero'; hero: HeroId }
  /** Centroid of the scene candidate's polygon. */
  | { kind: 'candidate' }
  /** A named node from `graph.json`. */
  | { kind: 'graphNode'; node: GraphNodeRole };

/** Where the camera aims at the end of a keyframe's transition. */
export type CameraSpec =
  /** A fixed pose. Coordinates are camera framing, not engine values. */
  | { kind: 'fixed'; viewState: SceneViewState }
  /** Aim at an anchor with the given pose. */
  | { kind: 'anchor'; anchor: AnchorRef; pose: CameraPose }
  /**
   * Follow-cam on a hero. The camera sits `offsetM` metres behind the hero
   * along `pose.bearing` and re-evaluates every frame from `simSec`.
   */
  | { kind: 'follow'; hero: HeroId; offsetM: number; pose: CameraPose };

/**
 * How the camera moves from the previous keyframe's end pose to this one.
 * `fly` uses `FlyToInterpolator#interpolateProps`, `linear` lerps each field,
 * `cut` jumps at the keyframe start. Progress is
 * `clamp((tMs - keyframe.t) / transitionMs, 0, 1)` with no easing beyond the
 * interpolator's own curve.
 */
export type CameraTransition = 'fly' | 'linear' | 'cut';

/* ------------------------------------------------------------------------ */
/* Sim clock                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Sim clock during a keyframe. Each keyframe states its clock in full, so the
 * clock at any `tMs` depends on one keyframe only. A "jump" is a `run` whose
 * `from` differs from the previous keyframe's end.
 */
export type SimClockSpec =
  /** Clock holds at `at`. Without `at` it holds at the previous keyframe's end value. */
  | { mode: 'paused'; at?: SimSec }
  /** Clock moves linearly from `from` to `to` across the keyframe's `durationMs`. */
  | { mode: 'run'; from: SimSec; to: SimSec };

/* ------------------------------------------------------------------------ */
/* Layers                                                                    */
/* ------------------------------------------------------------------------ */

/** Layers that take only on/off and opacity. */
export type SimpleLayerId =
  | 'terrain'
  | 'buildings'
  | 'candidateOutline'
  | 'arrivalTicks'
  | 'stepsEdges'
  | 'shelteredEdges'
  | 'rainOverlay';

/**
 * Point-marker layers. Each one also accepts a `PulseSpec`. Marker order is the
 * layer's data order: `graph.json` nodes of the layer's role in file order, or
 * kiosks in the order the Q4 helper returns them.
 */
export type MarkerLayerId = 'bollardMarkers' | 'elevatorMarkers' | 'loadingMarker' | 'kioskMarkers';

/** Every scene layer id. `SceneState.layers` holds one entry per id. */
export type SceneLayerId = SimpleLayerId | MarkerLayerId | 'trips' | 'heatmap' | 'bottlenecks' | 'heroProgress';

/** Opacity ramp from the layer's previous opacity to the toggle's target. */
export interface FadeSpec {
  /** Ramp length from the keyframe start. 0 or absent means an instant switch. */
  ms: number;
}

interface LayerToggleBase {
  on: boolean;
  /** Target opacity when `on`. Defaults to 1. */
  opacity?: number;
  fade?: FadeSpec;
}

/**
 * Which items of a marker or bottleneck layer pulse. The pulse radius and
 * opacity derive from `tMs` and `periodMs` only.
 */
export type PulseSpec = {
  /** One pulse cycle in scene time. The renderer picks a default when absent. */
  periodMs?: SceneMs;
} & (
  /** Every item pulses for the whole time the layer is on. */
  | { trigger: 'always' }
  /**
   * An item pulses while a hero passes it: the hero's interpolated position
   * lay within `withinM` haversine metres of the item at some sim time in
   * `[simSec - lingerSec, simSec]`. Pure in `simSec`, so `seek` stays pure.
   * The hero must have a `HeroRule` in `SceneDef.heroes`. A hero with no pick
   * pulses nothing.
   */
  | { trigger: 'heroNear'; hero: HeroId; withinM: number; lingerSec?: SimSec }
);

/**
 * Where a hero progress ring takes its full-circle duration from. Elapsed
 * time is `simSec` minus the hero trip's first `tSec`.
 * TODO(subagent): contract needs a per-persona time budget (Lukas's lunch
 * break) on `PersonaResult` or `SimulationResult`. Until then scenes use
 * `tripDuration`.
 */
export type HeroProgressBudget =
  /** The hero trip's last `tSec` minus its first `tSec`. */
  | { kind: 'tripDuration' }
  /** A binding path (grammar above, no format) that resolves to a duration in seconds. */
  | { kind: 'binding'; path: string };

/**
 * A change to one layer at a keyframe start. Toggles are deltas: the layer set
 * at keyframe `k` is the fold of toggles from keyframe 0 through `k`, in order.
 * A layer with no toggle so far is off. Folding from the start keeps `seek` pure.
 */
export type LayerToggle =
  | (LayerToggleBase & { layer: SimpleLayerId })
  | (LayerToggleBase & { layer: MarkerLayerId; pulse?: PulseSpec })
  | (LayerToggleBase & {
      layer: 'trips';
      /** Personas drawn, bottom to top in the fixed persona order. */
      personas: readonly PersonaId[];
      /** Hero trip drawn wider and on top. */
      highlight?: HeroId;
    })
  | (LayerToggleBase & { layer: 'heatmap'; slice: TimeSlice })
  | (LayerToggleBase & {
      layer: 'bottlenecks';
      slice: TimeSlice;
      /** Types shown. Absent means all types. */
      types?: readonly Bottleneck['type'][];
      /** Which bottlenecks pulse. Absent means none. */
      pulse?: PulseSpec;
    })
  | (LayerToggleBase & {
      /**
       * A ring around a hero's interpolated position that fills as the hero
       * spends its time budget. The ring shows no number or label.
       */
      layer: 'heroProgress';
      hero: HeroId;
      budget: HeroProgressBudget;
    });

/** Pulse state at the current `tMs`, computed by the director from a `PulseSpec`. */
export interface ResolvedPulse {
  /** Position in the pulse cycle, in `[0, 1)`, from `tMs` and `periodMs`. */
  phase: number;
  /** Indices into the layer's item order that pulse now, ascending. */
  active: readonly number[];
}

/** Progress ring state at the current `simSec`, computed by the director. */
export interface ResolvedProgress {
  hero: HeroId;
  /** Ring centre `[lng, lat]`. `null` when the hero has no pick or no position. */
  position: readonly [number, number] | null;
  /** Elapsed share of the budget, clamped to `[0, 1]`. Drives geometry only, never text. */
  fraction: number;
}

/**
 * Resolved layer state the layer builders consume. Builders read `pulse` and
 * `progress` as given and hold no scene- or hero-specific logic.
 */
export type ResolvedLayer = LayerToggle & {
  /** Opacity at the current `tMs`, after fades. 0 when off and fully faded. */
  currentOpacity: number;
  /** Set when the toggle carries a `PulseSpec`, else `null`. */
  pulseState: ResolvedPulse | null;
  /** Set for `heroProgress`, else `null`. */
  progress: ResolvedProgress | null;
};

/* ------------------------------------------------------------------------ */
/* Captions                                                                  */
/* ------------------------------------------------------------------------ */

/** Literal text with `{path|format}` bindings. See the binding grammar above. */
export type CaptionTemplate = string;

/** Binding format names. See the binding grammar above. */
export type BindingFormat = 'int' | 'num1' | 'clock' | 'text';

/** HUD regions. `SceneHUD.tsx` owns their layout. */
export type CaptionSlot = 'title' | 'subtitle' | 'clock' | 'personaChip' | 'frictionChip' | 'footer';

/**
 * One HUD caption. Captions belong to a keyframe and show for its whole span,
 * fading in and out over `fadeMs`.
 */
export interface CaptionBinding {
  /** Stable id, unique within the scene. Rendered as `data-caption-id`. */
  id: string;
  slot: CaptionSlot;
  template: CaptionTemplate;
  /** Colours the chip with the persona token (senior, vendor, commuter, retailer). */
  persona?: PersonaId;
  /** Fade length at both ends of the keyframe span. Defaults to 0. */
  fadeMs?: number;
}

/** A parsed template piece. `bind.ts` produces these. */
export type CaptionPart =
  | { kind: 'text'; text: string }
  | { kind: 'binding'; path: string; format?: BindingFormat };

/** A literal piece of a resolved caption. */
export interface ResolvedTextPart {
  kind: 'text';
  text: string;
}

/**
 * A formatted binding of a resolved caption. The HUD renders it as one element
 * with `data-bind={path}` and, when `format` is set, `data-format={format}`.
 */
export interface ResolvedBindingPart {
  kind: 'binding';
  /** Formatted value, or `—` when the binding did not resolve. */
  text: string;
  /** Path as written in the template, format suffix excluded. */
  path: string;
  /** Format as written in the template. Absent means the default format. */
  format?: BindingFormat;
}

export type ResolvedCaptionPart = ResolvedTextPart | ResolvedBindingPart;

/**
 * Formats a resolved binding value. `bind.ts` exports the one implementation.
 * The HUD and the RZ-live check both use it. Returns `—` for values the
 * grammar treats as unresolved.
 */
export type FormatBinding = (value: unknown, format?: BindingFormat) => string;

/** A caption ready to render at the current `tMs`. */
export interface ResolvedCaption {
  id: string;
  slot: CaptionSlot;
  persona?: PersonaId;
  opacity: number;
  /** Text pieces and formatted bindings in template order. */
  parts: readonly ResolvedCaptionPart[];
}

/** An unresolved binding, also logged with `console.error`. */
export interface BindingError {
  captionId: string;
  path: string;
  reason: 'missing' | 'not-scalar' | 'no-match' | 'parse';
}

/* ------------------------------------------------------------------------ */
/* Heroes                                                                    */
/* ------------------------------------------------------------------------ */

/** Named protagonists. Display names are literal caption text. */
export type HeroId = 'markus' | 'helga' | 'lukas';

/** `graph.json` nodes the scenes reference. */
export type GraphNodeRole = 'elevator' | 'loading';

/**
 * Picks one trip from `result.trips` by rule, never by trip id, so heroes
 * survive engine reruns and seed changes. Every rule filters by `persona`
 * first. Ties break by the lowest trip index. Distances are haversine metres
 * on `[lng, lat]`.
 */
export type HeroRule =
  /** Vendor trip whose last point lies nearest the first bottleneck of `type` in `slice`. */
  | {
      hero: HeroId;
      persona: PersonaId;
      pick: 'lastPointNearestBottleneck';
      slice: TimeSlice;
      type: Bottleneck['type'];
    }
  /** Trip whose last point lies nearest a `graph.json` node of `node` role. */
  | { hero: HeroId; persona: PersonaId; pick: 'lastPointNearestNode'; node: GraphNodeRole }
  /** Earliest-starting trip whose path passes within `withinM` of a node of `node` role. */
  | {
      hero: HeroId;
      persona: PersonaId;
      pick: 'earliestPassingNode';
      node: GraphNodeRole;
      withinM: number;
    }
  /**
   * Longest trip (last `tSec` minus first `tSec`) among trips that start
   * inside `window`. With the Q2 `outcome` field, `dropped` trips rank first.
   */
  | { hero: HeroId; persona: PersonaId; pick: 'longestInWindow'; window: readonly [SimSec, SimSec] };

/** Outcome of a hero rule on one result. `null` in `SceneState.heroes` means no trip qualified. */
export interface HeroPick {
  hero: HeroId;
  /** Index into `result.trips`. */
  tripIndex: number;
}

/* ------------------------------------------------------------------------ */
/* Keyframes and scenes                                                      */
/* ------------------------------------------------------------------------ */

/**
 * A gate halts scene time at the keyframe start until its action completes.
 * `step` and `seek` clamp to the gate time while `phase` is `awaiting-action`
 * or `rerunning`. After the action resolves, keyframes from the gate onward
 * read `after` as the active result, and `seek` before the gate reads `before`.
 */
export type SceneGate = {
  kind: 'mitigation';
  /**
   * Apply sequence: `BriefClient.brief` (cached fallback on failure), then
   * `SimClient.run(candidateId, scenario, brief.losers.map(l => l.mitigation), seed)`.
   */
};

export interface Keyframe {
  /** Stable id such as `K0`. Tests and screenshots refer to it. */
  id: string;
  /** Start time. Keyframes are sorted, contiguous and non-overlapping: `t[k+1] = t[k] + durationMs[k]`. */
  t: SceneMs;
  durationMs: SceneMs;
  camera: CameraSpec;
  transition: CameraTransition;
  /** Transition length from `t`. Clamped to `durationMs`. Ignored for `cut`. */
  transitionMs: SceneMs;
  sim: SimClockSpec;
  /** Deltas applied at `t`. See `LayerToggle`. */
  layers: readonly LayerToggle[];
  captions: readonly CaptionBinding[];
  gate?: SceneGate;
}

/**
 * One scripted scene. Pure data: no functions, no numbers derived from engine
 * output. Duration equals the last keyframe's `t + durationMs`.
 */
export interface SceneDef {
  id: SceneId;
  title: string;
  /** `Candidate.id` passed to `SimClient.run`. */
  candidateId: string;
  scenario: Scenario;
  /** Seed for every `SimClient.run` call. Live and recorded runs share it. */
  seed: number;
  keyframes: readonly Keyframe[];
  /**
   * Hero rules, at most one per `HeroId`. Every hero named by a camera,
   * anchor, `trips.highlight`, `heroNear` pulse or `heroProgress` toggle in
   * `keyframes` needs a rule here.
   */
  heroes: readonly HeroRule[];
}

/* ------------------------------------------------------------------------ */
/* Binding scope and state                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Values computed by existing project functions, never by scene code.
 * `marketScore` comes from D's `score(result.criteria, weights)` with the store
 * weights. `consensus` comes from the cockpit's consensus function.
 */
export interface DerivedValues {
  marketScore: number;
  consensus: number;
}

/**
 * Scene assets loaded from `public/data/` that the contract does not cover.
 * TODO(subagent): contract needs arrivals.json schema (proposed: `{ stopId,
 * route, tSec }[]` filtered to Saturday U1 at the Lorenzkirche stops).
 * TODO(subagent): contract needs graph.json node schema for `elevator` and
 * `loading` roles (proposed: `{ id, lng, lat, role }`).
 */
export interface SceneAssets {
  arrivals: unknown;
  graphNodes: unknown;
}

/** The object bindings resolve against. Root names match the grammar's `root`. */
export interface BindingScope {
  /** Active result: `after` once the gate resolved and `tMs` is past it, else `before`. */
  result: SimulationResult;
  before: SimulationResult;
  after: SimulationResult | null;
  brief: Brief | null;
  derived: { active: DerivedValues; before: DerivedValues; after: DerivedValues | null };
  scene: {
    simSec: SimSec;
    seed: number;
    scenario: Scenario;
    candidateId: string;
    dataSource: SceneDataSource;
  };
  heroes: Record<HeroId, HeroPick | null>;
  assets: SceneAssets;
}

/**
 * Director lifecycle. `loading` waits for the first result. `awaiting-action`
 * holds at a gate. `rerunning` waits for brief and rerun. `error` keeps the
 * last good frame and shows the message.
 */
export type ScenePhase = 'loading' | 'ready' | 'playing' | 'paused' | 'awaiting-action' | 'rerunning' | 'ended' | 'error';

/**
 * Full scene state. Plain JSON data, so `page.evaluate(() => window.__scene.state)`
 * returns it intact.
 */
export interface SceneState {
  sceneId: SceneId;
  phase: ScenePhase;
  tMs: SceneMs;
  durationMs: SceneMs;
  keyframeId: string;
  keyframeIndex: number;
  simSec: SimSec;
  viewState: SceneViewState;
  layers: Record<SceneLayerId, ResolvedLayer>;
  captions: readonly ResolvedCaption[];
  /** Active result, the same object as `scope.result`. RZ-live reads it. `null` while `loading`. */
  result: SimulationResult | null;
  scope: BindingScope | null;
  errors: readonly BindingError[];
  /** Message for `phase === 'error'`. */
  error?: string;
}

/** Keyframe metadata exposed so tests can seek to each keyframe. */
export interface KeyframeInfo {
  id: string;
  t: SceneMs;
  durationMs: SceneMs;
  gated: boolean;
}

/**
 * The director API on `window.__scene`. Live playback drives it from one rAF
 * loop. The recorder and Playwright drive it directly.
 */
export interface SceneApi {
  /** Advance scene time by `dtMs` and return the new state. Clamps at gates and at the end. */
  step(dtMs: SceneMs): SceneState;
  /** Jump to `tMs`, clamped to `[0, durationMs]` and to an unresolved gate. Pure in `tMs`. */
  seek(tMs: SceneMs): SceneState;
  /** Start the live rAF loop. The recorder never calls this. */
  play(): void;
  /** Stop the live rAF loop. Scene time stays where it is. */
  pause(): void;
  /**
   * Run the current gate action, the same path as clicking **Apply Claude
   * mitigation**. Resolves once `phase` leaves `rerunning`. Rejects when no
   * gate is pending.
   */
  apply(): Promise<SceneState>;
  readonly state: SceneState;
  readonly keyframes: readonly KeyframeInfo[];
}

declare global {
  interface Window {
    /** Present only when a scene is mounted. */
    __scene?: SceneApi;
  }
}

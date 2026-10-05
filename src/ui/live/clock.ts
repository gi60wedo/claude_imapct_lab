// Live sim clock for the market day. Pure helpers: the hook in useLiveSim.ts owns the state.
import type { PersonaId, SimulationResult, TimeSlice } from '../../contracts';
import { DAY_END, DAY_START, SLICES } from '../../sim/params';

/** The clock runs over the engine's simulated day, 05:30 to 15:00, in seconds since midnight. */
export const CLOCK_START = DAY_START;
export const CLOCK_END = DAY_END;

/** Sim seconds per wall second. */
export const SPEEDS = [1, 10, 60, 300] as const;
export type Speed = (typeof SPEEDS)[number];
export const DEFAULT_SPEED: Speed = 60;

/**
 * Trips the live view asks the engine for: the capacity of the instanced agent dots (one dot per
 * trip, see Trips in three/layers.tsx). bench.test.ts on public/data/world.json (node, SUNNY_SAT)
 * measured 36–68 ms per simulate for maxTrips 100, 300, 1000 and 2000, far under the 1.5 s worker
 * budget; rerun it with BENCH=1 once the engine returns full-scale runs. With vendor, senior and
 * commuter trips only, a benchmark site returned 151–270 trips at any maxTrips above 300.
 */
export const LIVE_MAX_TRIPS = 3000;

/** A wall-clock frame gap above this (background tab, debugger) advances the clock by this much only. */
const MAX_FRAME_SEC = 0.25;

/**
 * Offset that maps a result's trip timestamps onto the clock, in seconds.
 *
 * The engine stamps every trip vertex in seconds since midnight, starting at DAY_START (05:30), so
 * engine results map 1:1 and the offset is 0. The committed fixtures (src/ui/__fixtures__/gen.ts)
 * count seconds from the first departure instead; a result with any timestamp before DAY_START is
 * read that way and shifted to start at 05:30.
 */
export function tripOffset(result: SimulationResult | null): number {
  if (!result) return 0;
  for (const trip of result.trips) for (const p of trip.path) if (p[2] < DAY_START) return DAY_START;
  return 0;
}

/** The one place a trip timestamp becomes a clock time: tripTime + tripOffset(result). */
export const tripTimeToClock = (tripTime: number, offset: number) => tripTime + offset;

/** The result with every trip timestamp mapped onto the clock. Returns the same object when nothing moves. */
export function onClock(result: SimulationResult): SimulationResult {
  const offset = tripOffset(result);
  if (offset === 0) return result;
  return {
    ...result,
    trips: result.trips.map((t) => ({
      persona: t.persona,
      path: t.path.map(([lng, lat, s]) => [lng, lat, tripTimeToClock(s, offset)] as [number, number, number]),
    })),
  };
}

/** Advance the clock by a wall-clock delta. Past 15:00 it wraps to 05:30 when looping, else it stops there. */
export function advanceClock(t: number, wallSec: number, speed: number, loop: boolean): { t: number; ended: boolean } {
  const next = t + Math.min(Math.max(wallSec, 0), MAX_FRAME_SEC) * speed;
  if (next < CLOCK_END) return { t: Math.max(next, CLOCK_START), ended: false };
  if (!loop) return { t: CLOCK_END, ended: true };
  return { t: CLOCK_START + ((next - CLOCK_START) % (CLOCK_END - CLOCK_START)), ended: false };
}

/** The next faster (dir 1) or slower (dir -1) preset, clamped at the ends. */
export function stepSpeed(speed: number, dir: 1 | -1): Speed {
  const i = SPEEDS.findIndex((s) => s >= speed);
  const at = i < 0 ? SPEEDS.length - 1 : i;
  const exact = SPEEDS[at] === speed;
  const to = dir > 0 ? (exact ? at + 1 : at) : at - 1;
  return SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, to))];
}

/** Clock time a slice button jumps to: the slice window start from sim/params. */
export const sliceStart = (slice: TimeSlice) => SLICES[slice][0];

/** The slice whose window contains t, or null between windows. */
export function sliceAt(t: number): TimeSlice | null {
  for (const [id, [from, to]] of Object.entries(SLICES) as [TimeSlice, readonly [number, number]][]) {
    if (t >= from && t < to) return id;
  }
  return null;
}

/** 'HH:MM' (Bottleneck.time, formatClock) to seconds since midnight; NaN when it does not parse. */
export function parseClock(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 : NaN;
}

/** Clock with seconds, HH:MM:SS. */
export function formatClockSec(t: number): string {
  const s = Math.floor(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

export interface TripSpan { persona: PersonaId; start: number; end: number }

/** First and last clock time of every trip, for the per-frame counters. */
export function tripSpans(result: SimulationResult | null): TripSpan[] {
  if (!result) return [];
  return result.trips.filter((t) => t.path.length > 0)
    .map((t) => ({ persona: t.persona, start: t.path[0][2], end: t.path[t.path.length - 1][2] }));
}

export type PersonaCounts = Record<PersonaId, number>;
const zero = (): PersonaCounts => ({ senior: 0, vendor: 0, commuter: 0, retailer: 0 });

/** Sampled agents on their way at t, and those whose trip has ended by t, per persona. */
export function liveCounts(spans: TripSpan[], t: number): { enRoute: PersonaCounts; arrived: PersonaCounts } {
  const enRoute = zero(), arrived = zero();
  for (const s of spans) {
    if (s.end <= t) arrived[s.persona]++;
    else if (s.start <= t) enRoute[s.persona]++;
  }
  return { enRoute, arrived };
}

/** Steps the cross-fade is quantised to, so the trip list changes a few times per fade, not every frame. */
const BLEND_STEPS = 8;

/**
 * Trips shown while the view fades from `from` to `to`: the first share of the new trips joins
 * as the first share of the old ones leaves. Selection by index keeps it deterministic.
 */
export function blendTrips(from: SimulationResult['trips'], to: SimulationResult['trips'], blend: number): SimulationResult['trips'] {
  const k = quantiseBlend(blend);
  if (k >= 1) return to;
  return [...from.slice(Math.round(from.length * k)), ...to.slice(0, Math.round(to.length * k))];
}

export const quantiseBlend = (blend: number) => Math.round(Math.min(1, Math.max(0, blend)) * BLEND_STEPS) / BLEND_STEPS;

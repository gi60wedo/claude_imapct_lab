import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import type { SimulationResult } from '../../contracts';
import { DAY_END, DAY_START, SLICES } from '../../sim/params';
import {
  advanceClock, blendTrips, CLOCK_END, CLOCK_START, DEFAULT_SPEED, formatClockSec, liveCounts, onClock, parseClock,
  sliceAt, sliceStart, SPEEDS, stepSpeed, tripOffset, tripSpans, tripTimeToClock,
} from './clock';

const fixture = (name: string) =>
  JSON.parse(readFileSync(`${process.cwd()}/public/data/fixtures/${name}.json`, 'utf8')) as SimulationResult;

const withTrips = (trips: SimulationResult['trips']) => ({ ...fixture('result-KAUFHOF-SUNNY_SAT'), trips });

test('the clock spans the engine day, 05:30 to 15:00 in seconds since midnight', () => {
  expect(CLOCK_START).toBe(DAY_START);
  expect(CLOCK_END).toBe(DAY_END);
  expect(formatClockSec(CLOCK_START)).toBe('05:30:00');
  expect(formatClockSec(CLOCK_END)).toBe('15:00:00');
});

test('engine trips map 1:1; fixture trips counted from first departure start at 05:30', () => {
  const engine = withTrips([{ persona: 'vendor', path: [[11, 49, DAY_START], [11, 49, DAY_START + 90]] }]);
  expect(tripOffset(engine)).toBe(0);
  expect(onClock(engine)).toBe(engine);

  const fx = fixture('result-KAUFHOF-SUNNY_SAT');
  const offset = tripOffset(fx);
  expect(offset).toBe(DAY_START);
  const mapped = onClock(fx);
  expect(mapped.trips[0].path[0][2]).toBe(tripTimeToClock(fx.trips[0].path[0][2], offset));
  expect(Math.min(...mapped.trips.flatMap((t) => t.path.map((p) => p[2])))).toBeGreaterThanOrEqual(CLOCK_START);
  expect(tripOffset(null)).toBe(0);
});

test('advanceClock scales wall time by speed, caps long frames, and loops or stops at 15:00', () => {
  expect(advanceClock(CLOCK_START, 1, 60, true)).toEqual({ t: CLOCK_START + 15, ended: false }); // 1 s frame capped at 0.25 s
  expect(advanceClock(CLOCK_START, 0.1, 60, true).t).toBeCloseTo(CLOCK_START + 6);
  expect(advanceClock(CLOCK_START, 0.2, 300, true).t).toBeCloseTo(CLOCK_START + 60);
  expect(advanceClock(CLOCK_START, -1, 300, true).t).toBe(CLOCK_START);
  expect(advanceClock(CLOCK_END - 10, 0.1, 300, true)).toEqual({ t: CLOCK_START + 20, ended: false });
  expect(advanceClock(CLOCK_END - 10, 0.1, 300, false)).toEqual({ t: CLOCK_END, ended: true });
  expect(advanceClock(0, 0.1, 1, true).t).toBe(CLOCK_START);
});

test('speed presets step up and down and clamp at the ends', () => {
  expect(SPEEDS).toEqual([1, 10, 60, 300]);
  expect(DEFAULT_SPEED).toBe(60);
  expect(stepSpeed(60, 1)).toBe(300);
  expect(stepSpeed(300, 1)).toBe(300);
  expect(stepSpeed(60, -1)).toBe(10);
  expect(stepSpeed(1, -1)).toBe(1);
  expect(stepSpeed(30, 1)).toBe(60);
  expect(stepSpeed(30, -1)).toBe(10);
});

test('slice buttons jump to the slice start, and the clock maps back to its slice', () => {
  for (const [id, [from, to]] of Object.entries(SLICES)) {
    expect(sliceStart(id as keyof typeof SLICES)).toBe(from);
    expect(sliceAt(from)).toBe(id);
    expect(sliceAt(to - 1)).toBe(id);
  }
  expect(sliceAt(9 * 3600)).toBeNull();
  expect(parseClock('05:34')).toBe(5 * 3600 + 34 * 60);
  expect(parseClock('later')).toBeNaN();
});

test('live counts split sampled trips into en route and arrived per persona', () => {
  const r = withTrips([
    { persona: 'vendor', path: [[0, 0, 100], [0, 0, 200]] },
    { persona: 'vendor', path: [[0, 0, 150], [0, 0, 400]] },
    { persona: 'senior', path: [[0, 0, 300], [0, 0, 500]] },
    { persona: 'commuter', path: [] },
  ]);
  const spans = tripSpans(r);
  expect(spans).toHaveLength(3);
  expect(liveCounts(spans, 50)).toEqual({
    enRoute: { senior: 0, vendor: 0, commuter: 0, retailer: 0 }, arrived: { senior: 0, vendor: 0, commuter: 0, retailer: 0 } });
  expect(liveCounts(spans, 250)).toEqual({
    enRoute: { senior: 0, vendor: 1, commuter: 0, retailer: 0 }, arrived: { senior: 0, vendor: 1, commuter: 0, retailer: 0 } });
  expect(liveCounts(spans, 600).arrived).toEqual({ senior: 1, vendor: 2, commuter: 0, retailer: 0 });
});

test('blendTrips swaps old agents for new ones in quantised steps', () => {
  const trip = (n: number) => ({ persona: 'senior' as const, path: [[n, 0, 0]] as [number, number, number][] });
  const from = Array.from({ length: 8 }, (_, i) => trip(i));
  const to = Array.from({ length: 16 }, (_, i) => trip(100 + i));
  expect(blendTrips(from, to, 0)).toEqual(from);
  expect(blendTrips(from, to, 1)).toBe(to);
  const half = blendTrips(from, to, 0.5);
  expect(half).toEqual([...from.slice(4), ...to.slice(0, 8)]);
  expect(blendTrips(from, to, 0.51)).toEqual(half);
});

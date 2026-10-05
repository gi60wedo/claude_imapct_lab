import { describe, expect, it } from 'vitest';
import type { SimulationResult, TimeSlice } from '../../contracts';
import { HEAT_CELL_M } from '../../sim/params';
import { weatherOf } from './CityThree';
import { createLocalFrame, project } from './geometry';
import { heatField, heatReference, type HeatPoint } from './heat';
import { hash11 } from './shaders';
import { DOT, QUALITY, WEATHER, weatherLook } from './style';

describe('weather', () => {
  it('rains on a rainy Saturday, snows over the Christmas market and stays clear when sunny', () => {
    expect(WEATHER.RAINY_SAT.precipitation).toBe('rain');
    expect(WEATHER.RAINY_SAT.wet).toBeGreaterThan(0);
    expect(WEATHER.CHRISTMAS_MARKET.precipitation).toBe('snow');
    expect(WEATHER.CHRISTMAS_MARKET.snow).toBeGreaterThan(0);
    expect(WEATHER.SUNNY_SAT).toMatchObject({ precipitation: 'none', wet: 0, snow: 0, haze: 0, sun: 1 });
  });

  it('draws fewer particles on the fast tier', () => {
    for (const look of Object.values(WEATHER)) {
      expect(look.particles.fast).toBeLessThanOrEqual(look.particles.high);
      if (look.precipitation !== 'none') expect(look.particles.fast).toBeGreaterThan(0);
    }
    expect(Object.keys(QUALITY).sort()).toEqual(Object.keys(WEATHER.RAINY_SAT.particles).sort());
  });

  it('reads the weather from the prop, then the result, else clear', () => {
    const result = { scenario: 'RAINY_SAT' } as SimulationResult;
    expect(weatherOf({ result })).toBe('RAINY_SAT');
    expect(weatherOf({ result, weather: 'CHRISTMAS_MARKET' })).toBe('CHRISTMAS_MARKET');
    expect(weatherOf({ result: null })).toBe('SUNNY_SAT');
    expect(weatherLook(undefined)).toBe(WEATHER.SUNNY_SAT);
  });

  it('places particles by a seeded hash of the instance index: same index, same value, spread over [0, 1)', () => {
    const a = Array.from({ length: 4000 }, (_, i) => hash11(i * 1.37 + 0.5));
    const b = Array.from({ length: 4000 }, (_, i) => hash11(i * 1.37 + 0.5));
    expect(a).toEqual(b);
    expect(Math.min(...a)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...a)).toBeLessThan(1);
    // Roughly uniform: every tenth of the range gets 6–14 % of the samples.
    const bins = new Array(10).fill(0);
    for (const v of a) bins[Math.floor(v * 10)]++;
    for (const n of bins) expect(n / a.length).toBeGreaterThan(0.06);
    for (const n of bins) expect(n / a.length).toBeLessThan(0.14);
  });

  it('keeps the agent dots at 5–6 px with a halo around them', () => {
    expect(DOT.headPx).toBeGreaterThanOrEqual(5);
    expect(DOT.headPx).toBeLessThanOrEqual(6);
    expect(DOT.glow).toBeGreaterThan(1);
  });
});

describe('heat field', () => {
  const frame = createLocalFrame([11.077, 49.454]);
  const slice = (heat: HeatPoint[]) => ({ heat, bottlenecks: [] });
  const bySlice = (peak: HeatPoint[], quiet: HeatPoint[]): SimulationResult['bySlice'] => ({
    '05:30_DELIVERY': slice(quiet), '11:30_PEAK': slice(peak), '15:00_LULL': slice([]),
  } as Record<TimeSlice, { heat: HeatPoint[]; bottlenecks: [] }>);
  /** A 5 × 5 block of engine cells around the frame origin, `people` each. */
  const block = (people: number): HeatPoint[] => {
    const out: HeatPoint[] = [];
    const [lng0, lat0] = frame.origin;
    const dLng = 15 / (111_320 * Math.cos((lat0 * Math.PI) / 180)), dLat = 15 / 110_540;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) out.push([lng0 + i * dLng, lat0 + j * dLat, people]);
    return out;
  };
  const at = (field: NonNullable<ReturnType<typeof heatField>>, east: number, north: number) => {
    const x = Math.round((east - field.west) / field.texel), y = Math.round((north - field.south) / field.texel);
    return field.values[y * field.width + x];
  };

  it('is empty without heat or a scale', () => {
    expect(heatField([], frame, 1)).toBeNull();
    expect(heatField(block(1), frame, 0)).toBeNull();
    expect(heatField([[11, 49, 0], [11, 49, Number.NaN]], frame, 1)).toBeNull();
    expect(heatReference(null)).toBe(0);
  });

  it('glows where the cells are and fades to nothing around them', () => {
    const field = heatField(block(2), frame, 2)!;
    expect(field.cells).toBe(25);
    expect(at(field, 0, 0)).toBeGreaterThan(240);
    // Below the drape's 4 % alpha floor (HEAT_FRAGMENT), so the box edges never show.
    expect(at(field, field.west, field.south)).toBeLessThan(0.04 * 255);
    // Smooth: no texel jumps by more than a few steps from its neighbour across the block centre row.
    const y = Math.round((0 - field.south) / field.texel);
    for (let x = 1; x < field.width; x++) {
      expect(Math.abs(field.values[y * field.width + x] - field.values[y * field.width + x - 1])).toBeLessThan(60);
    }
  });

  it('shares one scale across slices, so a quiet slice reads quieter than the peak', () => {
    const peak = block(4), quiet = block(0.4);
    const reference = heatReference({ bySlice: bySlice(peak, quiet) });
    expect(reference).toBe(4);
    const hot = heatField(peak, frame, reference)!, calm = heatField(quiet, frame, reference)!;
    expect(at(calm, 0, 0)).toBeLessThan(at(hot, 0, 0));
    expect(at(calm, 0, 0)).toBeGreaterThan(0);
  });

  it('covers the cells with a margin, at a third of an engine cell per texel or coarser', () => {
    const cells = block(1);
    const field = heatField(cells, frame, 1)!;
    expect(field.texel).toBeGreaterThanOrEqual(HEAT_CELL_M / 3);
    for (const [lng, lat] of cells) {
      const [east, north] = project([lng, lat], frame);
      expect(east).toBeGreaterThan(field.west);
      expect(north).toBeGreaterThan(field.south);
      expect(east).toBeLessThan(field.west + (field.width - 1) * field.texel);
      expect(north).toBeLessThan(field.south + (field.height - 1) * field.texel);
    }
    expect(field.width).toBeLessThanOrEqual(512);
  });
});

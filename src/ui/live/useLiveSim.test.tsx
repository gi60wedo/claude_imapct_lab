import { readFileSync } from 'node:fs';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { Scenario } from '../../contracts';
import { setState } from '../state/store';
import { CLOCK_START, LIVE_MAX_TRIPS } from './clock';

const fixture = (name: string) =>
  JSON.parse(readFileSync(`${process.cwd()}/public/data/fixtures/${name}.json`, 'utf8'));

const run = vi.fn(async (id: string, scenario: string) => fixture(`result-${id}-${scenario}`));
vi.mock('../adapters', () => ({ sim: { run: (...a: Parameters<typeof run>) => run(...a) } }));

const { useLiveSim } = await import('./useLiveSim');

afterEach(() => { run.mockClear(); setState({ playing: false, timeSec: 0, slice: '11:30_PEAK' }); });

test('runs once per candidate × scenario, asks for the live trip budget, and keeps the old result until the new one lands', async () => {
  const { result, rerender } = renderHook((p: { id: string; scenario: Scenario }) =>
    useLiveSim({ candidateId: p.id, scenario: p.scenario, mitigations: [], seed: 42 }),
  { initialProps: { id: 'KAUFHOF', scenario: 'SUNNY_SAT' } });

  await waitFor(() => expect(result.current.runs).toBe(1));
  expect(run).toHaveBeenLastCalledWith('KAUFHOF', 'SUNNY_SAT', [], 42, { maxTrips: LIVE_MAX_TRIPS });
  expect(result.current.result?.candidateId).toBe('KAUFHOF');
  // Fixture trips land on the clock and autoplay starts from the active slice.
  expect(result.current.result!.trips[0].path[0][2]).toBeGreaterThanOrEqual(CLOCK_START);
  expect(result.current.playing).toBe(true);
  expect(result.current.timeSec).toBeGreaterThanOrEqual(11 * 3600);

  rerender({ id: 'KAUFHOF', scenario: 'SUNNY_SAT' });
  expect(run).toHaveBeenCalledTimes(1);

  rerender({ id: 'KAUFHOF', scenario: 'RAINY_SAT' });
  expect(result.current.result?.scenario).toBe('SUNNY_SAT');
  await waitFor(() => expect(result.current.runs).toBe(2));
  expect(result.current.result?.scenario).toBe('RAINY_SAT');
  await waitFor(() => expect(result.current.blend).toBe(1));
  expect(result.current.view).toBe(result.current.result);
});

test('speed presets, play/pause and seek drive the clock', async () => {
  const { result } = renderHook(() => useLiveSim({ candidateId: 'KAUFHOF', scenario: 'SUNNY_SAT', mitigations: [], seed: 42, autoplay: false }));
  await waitFor(() => expect(result.current.runs).toBe(1));
  expect(result.current.speed).toBe(60);
  act(() => result.current.faster());
  expect(result.current.speed).toBe(300);
  act(() => result.current.slower());
  act(() => result.current.slower());
  expect(result.current.speed).toBe(10);
  act(() => result.current.seek(6 * 3600));
  expect(result.current.timeSec).toBe(6 * 3600);
  act(() => result.current.toggle());
  const t0 = result.current.timeSec;
  await waitFor(() => expect(result.current.timeSec).toBeGreaterThan(t0));
  act(() => result.current.toggle());
  expect(result.current.playing).toBe(false);
});

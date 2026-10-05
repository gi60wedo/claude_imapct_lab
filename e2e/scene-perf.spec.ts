import { expect, test } from '@playwright/test';

test('scene sustains the frame budget with all buildings and at least a hundred trails', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await page.goto('/?scene=1&data=fixtures');
  await expect(page.getByTestId('scene-view')).toHaveAttribute('data-ready', 'true', { timeout: 45_000 });
  const load = await page.evaluate(async () => {
    const storePath = '/src/ui/state/store.ts';
    const { getState, setState } = await import(/* @vite-ignore */ storePath) as typeof import('../src/ui/state/store');
    const current = getState();
    const result = current.results[`${current.selectedId}:${current.scenario}`];
    const starts = result.trips.filter((trip) => trip.path.length > 1).map((trip) => trip.path[0][2]);
    starts.sort((a, b) => a - b);
    // Start within the recorded trip window, rather than manufacturing trip data.
    setState({ timeSec: starts[Math.floor(starts.length / 2)], playing: true });
    return { trails: starts.length };
  });
  expect(load.trails).toBeGreaterThanOrEqual(100);
  const intervals = await page.evaluate(() => new Promise<number[]>((resolve) => {
    const samples: number[] = [];
    let started: number | undefined;
    let previous: number | undefined;
    function sample(now: number) {
      started ??= now;
      if (previous !== undefined && now - started > 1000) samples.push(now - previous);
      previous = now;
      if (now - started >= 11_000) resolve(samples);
      else requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  }));
  intervals.sort((a, b) => a - b);
  const midpoint = Math.floor(intervals.length / 2);
  const medianMs = intervals.length % 2 ? intervals[midpoint] : (intervals[midpoint - 1] + intervals[midpoint]) / 2;
  const medianFps = 1000 / medianMs;
  await testInfo.attach('scene-performance', {
    body: JSON.stringify({ medianFps, samples: intervals.length, ...load }), contentType: 'application/json',
  });
  expect(medianFps).toBeGreaterThanOrEqual(50);
});

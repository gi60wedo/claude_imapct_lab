import { expect, test } from '@playwright/test';

test('simulation trails retain data and report rolling FPS', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.location().url.endsWith('/data/buildings.json')) errors.push(message.text());
  });
  // Keep the fixture harness entirely local, including aerial image requests.
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? route.continue() : route.abort();
  });
  await page.goto('/src/ui/controls/sim-harness.html?perf=1&e2e=1');
  await expect(page.getByRole('button', { name: 'Pause simulation' })).toBeVisible();
  await expect(page.locator('[data-testid="map"] canvas')).toBeVisible();
  await page.waitForFunction(() => {
    const deck = window.__deck && Reflect.get(window.__deck, '_deck');
    return deck?.props.layers.some((layer: { id: string }) => layer.id === 'sim-trips');
  });
  await page.waitForTimeout(2000);

  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    const fps = await page.evaluate(() => window.__fps);
    expect(fps).toBeDefined();
    expect(Number.isFinite(fps)).toBe(true);
    samples.push(fps!);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const median = (sorted[9] + sorted[10]) / 2;
  console.log(`Simulation FPS median: ${median.toFixed(2)}; samples: ${samples.map((fps) => fps.toFixed(1)).join(', ')}`);
  await testInfo.attach('fps', { body: JSON.stringify({ median, samples }), contentType: 'application/json' });
  expect(median).toBeGreaterThan(0);

  const tripCount = await page.evaluate(() => {
    const deck = Reflect.get(window.__deck!, '_deck');
    const layer = deck.props.layers.find((entry: { id: string }) => entry.id === 'sim-trips');
    if (layer.constructor.layerName !== 'TripsLayer') throw new Error('Simulation trips must use TripsLayer.');
    return layer.props.data.length as number;
  });
  expect(tripCount).toBeGreaterThanOrEqual(100);
  await page.screenshot({ path: 'e2e/__shots__/trails.png' });
  expect(errors).toEqual([]);
  expect(median).toBeGreaterThanOrEqual(55);
});

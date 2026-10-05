import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';



test('standalone terrain scene renders buildings and trails without console errors', async ({ page }, testInfo) => {
  const errors: string[] = [];
  const external: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') await route.fallback();
    else { external.push(url.origin); await route.abort(); }
  });
  await page.goto('/?scene=1&data=fixtures');
  const scene = page.getByTestId('scene-view');
  await expect(scene).toHaveAttribute('data-ready', 'true', { timeout: 45_000 });
  await expect(scene.locator('canvas')).toBeVisible();
  await expect(scene.getByRole('heading', { name: 'Lorenzkirche' })).toBeVisible();
  await expect(scene.getByRole('alert')).toHaveCount(0);
  expect(Number(await scene.getAttribute('data-building-count'))).toBeGreaterThan(0);
  expect(await page.locator('.maplibregl-map').count()).toBe(0);
  await scene.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(scene.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await scene.getByRole('button', { name: 'Pause', exact: true }).click();
  const screenshot = testInfo.outputPath('scene-k1.png');
  await page.screenshot({ path: screenshot });
  await testInfo.attach('scene-k1', { path: screenshot, contentType: 'image/png' });
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

test('layer geometry preserves building bases and separates trip time from altitude', async ({ page }) => {
  await page.goto('/?scene=1&data=fixtures');
  await expect(page.getByTestId('scene-view')).toHaveAttribute('data-ready', 'true', { timeout: 45_000 });
  const facts = await page.evaluate(async () => {
    const modulePath = '/src/ui/scenes/layers3d.ts';
    const builders = await import(/* @vite-ignore */ modulePath) as typeof import('../src/ui/scenes/layers3d');
    const geometry = await builders.loadSceneGeometry();
    const result = await (await fetch('/data/fixtures/result-LORENZKIRCHE-SUNNY_SAT.json')).json();
    const trips = builders.prepareTrips(result, ['vendor', 'senior', 'commuter', 'retailer']);
    const terrain = builders.buildTerrainLayer(geometry);
    const buildings = builders.buildBuildingsLayer(geometry.buildings);
    const trails = builders.buildTripsLayer(trips, trips[0].timestamps[0]);
    const building = geometry.buildings[0];
    const polygon = (buildings.props.getPolygon as (item: typeof building) => number[][])(building);
    const h = (buildings.props.getElevation as (item: typeof building) => number)(building);
    return {
      bounds: terrain.props.bounds, expectedBounds: geometry.terrain.bounds,
      decoder: terrain.props.elevationDecoder, expectedDecoder: geometry.terrain.elevationDecoder,
      polygon, expectedPolygon: building.polygon, h, expectedHeight: building.h,
      positions: trips[0].positions, timestamps: trips[0].timestamps,
      expectedPath: result.trips[trips[0].tripIndex].path,
      worker: terrain.props.loadOptions?.worker,
      hasTerrainParser: terrain.props.loaders?.some((loader) => loader.id === 'terrain' && typeof loader.parse === 'function'),
      texture: terrain.props.texture, expectedTexture: geometry.textureUrl,
      terrainDrawMode: trails.props.terrainDrawMode,
    };
  });
  expect(facts.bounds).toEqual(facts.expectedBounds);
  expect(facts.decoder).toEqual(facts.expectedDecoder);
  expect(facts.polygon).toEqual(facts.expectedPolygon);
  expect(facts.h).toBe(facts.expectedHeight);
  expect(facts.positions).toEqual(facts.expectedPath.map((point: number[]) => point.slice(0, 2)));
  expect(facts.timestamps).toEqual(facts.expectedPath.map((point: number[]) => point[2]));
  expect(facts.worker).toBe(false);
  expect(facts.hasTerrainParser).toBe(true);
  expect(facts.texture).toBe(facts.expectedTexture);
  expect(facts.terrainDrawMode).toBe('drape');
});

test('missing terrain reports an actionable asset error', async ({ page }) => {
  await page.route('**/data/terrain/terrain.json', (route) => route.fulfill({ status: 404, body: 'missing' }));
  await page.goto('/?scene=1&data=fixtures');
  await expect(page.getByRole('alert')).toContainText('terrain.json: HTTP 404');
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await expect(page.getByTestId('scene-view')).toHaveAttribute('data-ready', 'false');
});

for (const shape of ['legacy', 'envelope-with-holes'] as const) {
  test(`buildings loader accepts ${shape} and preserves its rings`, async ({ page }) => {
    const terrain = JSON.parse(await readFile(new URL('../public/data/terrain/terrain.json', import.meta.url), 'utf8'));
    const asset = JSON.parse(await readFile(new URL('../public/data/buildings3d.json', import.meta.url), 'utf8'));
    const original = (Array.isArray(asset) ? asset : asset.buildings)[0];
    const outer: [number, number, number][] = typeof original.polygon[0][0] === 'number'
      ? original.polygon : original.polygon[0];
    const center = outer.slice(0, -1).reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1]], [0, 0])
      .map((value) => value / (outer.length - 1));
    const hole = outer.map(([lng, lat, z]) => [
      center[0] + (lng - center[0]) / 4, center[1] + (lat - center[1]) / 4, z,
    ]).reverse();
    const building = { ...original, polygon: shape === 'legacy' ? outer : [outer, hole] };
    await page.route('**/data/buildings3d.json', (route) => route.fulfill({
      json: shape === 'legacy' ? [building] : { baseElevation: terrain.baseElevation, buildings: [building] },
    }));
    await page.goto('/?scene=1&data=fixtures');
    await expect(page.getByTestId('scene-view')).toHaveAttribute('data-ready', 'true', { timeout: 45_000 });
    const polygon = await page.evaluate(async () => {
      const modulePath = '/src/ui/scenes/layers3d.ts';
      const builders = await import(/* @vite-ignore */ modulePath) as typeof import('../src/ui/scenes/layers3d');
      const geometry = await builders.loadSceneGeometry();
      const layer = builders.buildBuildingsLayer(geometry.buildings);
      const accessor = layer.props.getPolygon as (item: typeof geometry.buildings[number]) => unknown;
      return accessor(geometry.buildings[0]);
    });
    expect(polygon).toEqual(building.polygon);
  });
}

import { expect, test } from '@playwright/test';

interface Found { x: number; y: number; name: string; rejectReason: string }

test('map renders aerial, buildings and candidate tooltips', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // MapView probes /data/buildings.json and falls back to OSM footprints on 404 by design.
    if (m.location().url.endsWith('/data/buildings.json')) return;
    errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/?e2e=1&data=fixtures');
  const canvas = page.locator('[data-testid="map"] canvas');
  await expect(canvas).toBeVisible();
  await page.waitForFunction(() => !!window.__deck);

  // Locate a rejected candidate on screen: subdivide the canvas with deck's pickObjects until a small cell holds one.
  const findRejected = () =>
    page.evaluate(() => {
      const deck = window.__deck!;
      const canvasEl = deck.getCanvas()!;
      const rejected = (x: number, y: number, w: number, h: number) =>
        deck.pickObjects({ x, y, width: w, height: h, layerIds: ['candidates'] })
          .map((i) => i.object as { name: string; passedFilter: boolean; rejectReason?: string })
          .find((o) => o && !o.passedFilter);
      const search = (x: number, y: number, w: number, h: number): Found | null => {
        const hit = rejected(x, y, w, h);
        if (!hit) return null;
        if (w <= 6 && h <= 6) {
          // Accept the cell only if its centre and a 4 px ring around it pick the same rejected candidate.
          const cx = Math.round(x + w / 2), cy = Math.round(y + h / 2);
          const at = (px: number, py: number) => deck.pickObject({ x: px, y: py, layerIds: ['candidates'] })?.object as typeof hit | undefined;
          const centre = at(cx, cy);
          if (!centre || centre.passedFilter) return null;
          const ring = [[cx - 4, cy], [cx + 4, cy], [cx, cy - 4], [cx, cy + 4]];
          if (!ring.every(([px, py]) => at(px, py) === centre)) return null;
          return { x: cx, y: cy, name: centre.name, rejectReason: centre.rejectReason ?? '' };
        }
        const hw = Math.ceil(w / 2), hh = Math.ceil(h / 2);
        for (const [cx, cy] of [[x, y], [x + hw, y], [x, y + hh], [x + hw, y + hh]]) {
          const r = search(cx, cy, hw, hh);
          if (r) return r;
        }
        return null;
      };
      return search(0, 0, canvasEl.clientWidth, canvasEl.clientHeight);
    });

  let found: Found | null = null;
  await expect.poll(async () => (found = await findRejected()), { timeout: 15_000 }).not.toBeNull();
  const box = (await canvas.boundingBox())!;
  const target = found!;
  expect(target.rejectReason).not.toBe('');

  await page.mouse.move(box.x + target.x, box.y + target.y);
  const tooltip = page.getByTestId('map-tooltip');
  await expect(tooltip).toContainText(target.name);
  await expect(tooltip).toContainText(target.rejectReason);

  // Let the aerial tiles and buildings finish drawing before the screenshot.
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'e2e/__shots__/map.png' });
  expect(errors).toEqual([]);
});

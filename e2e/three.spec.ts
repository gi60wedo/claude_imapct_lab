import { expect, test, type Page } from '@playwright/test';

const SHOTS = 'e2e/__shots__';

/** Text of every digit-bearing text node in the dashboard that has no [data-bind] ancestor. */
const unboundDigits = (page: Page) => page.evaluate(() => {
  const root = document.querySelector('[data-testid=dashboard]');
  if (!root) return ['dashboard root missing'];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const bad: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent ?? '';
    const parent = n.parentElement;
    if (!/\d/.test(text) || !parent || parent.closest('script,style')) continue;
    if (!parent.closest('[data-bind]')) bad.push(`${parent.tagName.toLowerCase()}: ${text.trim().slice(0, 80)}`);
  }
  return bad;
});

const personaNumbers = (page: Page) =>
  page.locator('[data-testid^=persona-card-] [data-bind^="result.personas."]').allTextContents();

test('three dashboard: camera modes, heatmap, candidate switch, rule zero', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/?view=three&data=fixtures');
  await expect(page.locator('[data-testid=city-three][data-ready=true]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('candidate-card').nth(1)).toBeVisible();
  await expect(page.locator('[data-testid=persona-card-senior] [data-bind="result.personas.senior.score"]')).toHaveText(/\d/);
  // The boot selection is highlighted and scrolled into view; the overlay fits without scrolling.
  await expect(page.locator('[data-testid=candidate-card][aria-pressed=true] [data-testid=candidate-viewing]')).toBeInViewport();
  await expect(page.getByTestId('time-bar')).toBeInViewport();
  // A persona without a verdict shows no verdict line at all, not a bare dash.
  await expect(page.locator('[data-testid^=persona-card-] [data-bind$=".verdict"]', { hasText: /^—$/ })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/three-initial.png` });

  for (const mode of ['side', 'top', 'perspective'] as const) {
    await page.getByTestId(`camera-${mode}`).click();
    await expect(page.getByTestId(`camera-${mode}`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('side-legend')).toHaveCount(mode === 'side' ? 1 : 0);
    await page.waitForTimeout(1500); // let the camera tween settle before the shot
    await page.screenshot({ path: `${SHOTS}/three-${mode}.png` });
  }

  const heat = page.getByTestId('heatmap-toggle');
  const heatBefore = await heat.getAttribute('aria-pressed');
  await heat.click();
  await expect(heat).not.toHaveAttribute('aria-pressed', heatBefore ?? '');
  await page.screenshot({ path: `${SHOTS}/three-heatmap-${heatBefore === 'true' ? 'off' : 'on'}.png` });
  await heat.click();
  await expect(heat).toHaveAttribute('aria-pressed', heatBefore ?? '');

  const before = await personaNumbers(page);
  const cards = page.getByTestId('candidate-card');
  // The second card, unless boot already selected it; then the first.
  const target = (await cards.nth(1).getAttribute('aria-pressed')) === 'true' ? cards.nth(0) : cards.nth(1);
  await target.click();
  await expect(target).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => personaNumbers(page)).not.toEqual(before);
  await page.screenshot({ path: `${SHOTS}/three-second-candidate.png` });

  // Live clock: playing by default; the slice button jumps the clock to the slice start, where
  // the fixture trips (counted from 05:30) are on their way.
  const play = page.getByTestId('play');
  const clock = page.locator('[data-testid=time-bar] [data-bind=timeSec]');
  await expect(play).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('slice-05:30_DELIVERY').click();
  await expect(page.getByTestId('slice-05:30_DELIVERY')).toHaveAttribute('aria-pressed', 'true');
  await expect(clock).toHaveText(/^05:3/);
  const t0 = await clock.textContent();
  await expect.poll(() => clock.textContent(), { timeout: 5_000 }).not.toBe(t0);

  // Agents move: two shots of the city a second apart differ while the clock runs.
  await page.getByTestId('speed-60').click();
  const city = page.getByTestId('city-three');
  const shotA = await city.screenshot();
  await page.waitForTimeout(1000);
  const shotB = await city.screenshot();
  expect(shotA.equals(shotB), 'trip dots move between frames while playing').toBe(false);
  await page.screenshot({ path: `${SHOTS}/three-delivery.png` });

  // One dot per agent on its way: the city reports how many it draws. The fixture trips (counted
  // from 05:30) fill up over the first sim minutes, so poll while the clock runs.
  await expect.poll(async () => Number(await city.getAttribute('data-agent-count')), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(50);
  await page.screenshot({ path: `${SHOTS}/three-agents.png` });

  // Agents: Colour / White.
  const colours = page.getByTestId('agent-colors');
  await expect(colours).toHaveText('Agents: Colour');
  await colours.click();
  await expect(colours).toHaveText('Agents: White');
  await expect(city).toHaveAttribute('data-agent-colors', 'white');
  await page.screenshot({ path: `${SHOTS}/three-agents-white.png` });
  await colours.click();
  await expect(city).toHaveAttribute('data-agent-colors', 'persona');

  // The grey road network is always drawn; the surface overlay sits behind the Streets toggle.
  await expect(city).toHaveAttribute('data-roads', 'true', { timeout: 30_000 });
  await expect(city).toHaveAttribute('data-streets', 'false');
  await expect(page.getByTestId('street-legend')).toHaveCount(0);
  await page.getByTestId('streets-toggle').click();
  await expect(city).toHaveAttribute('data-streets', 'true');
  await expect(page.getByTestId('street-legend')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/three-streets.png` });
  await page.getByTestId('streets-toggle').click();
  await expect(city).toHaveAttribute('data-streets', 'false');

  // Pause stops the clock.
  await play.click();
  await expect(play).toHaveAttribute('aria-pressed', 'false');
  const paused = await clock.textContent();
  await page.waitForTimeout(500);
  await expect(clock).toHaveText(paused ?? '');

  // A scenario change re-runs the engine for the selected site; the live result follows it.
  const bar = page.getByTestId('live-bar');
  const runs = Number(await bar.getAttribute('data-runs'));
  await page.getByTestId('scenario-RAINY_SAT').click();
  await expect(page.getByTestId('scenario-RAINY_SAT')).toHaveAttribute('aria-pressed', 'true');
  await expect(bar).toHaveAttribute('data-live-scenario', 'RAINY_SAT');
  await expect.poll(async () => Number(await bar.getAttribute('data-runs'))).toBeGreaterThan(runs);
  await expect(bar).toHaveAttribute('data-blend', '1');
  await page.screenshot({ path: `${SHOTS}/three-rainy.png` });

  // The site details collapse to a slim rail and come back.
  const side = page.getByTestId('side-panel');
  await page.getByTestId('side-collapse').click();
  await expect(side).toHaveAttribute('data-open', 'false');
  await expect(page.getByTestId('score-card')).toBeHidden();
  await page.screenshot({ path: `${SHOTS}/three-rail.png` });
  await page.getByTestId('side-collapse').click();
  await expect(side).toHaveAttribute('data-open', 'true');
  await expect(page.getByTestId('score-card')).toBeVisible();

  expect(await unboundDigits(page), 'every digit on screen must sit inside [data-bind]').toEqual([]);
  expect(errors, 'no console errors').toEqual([]);
});

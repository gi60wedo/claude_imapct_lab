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

const PERSONA_IDS = ['senior', 'vendor', 'commuter', 'retailer'] as const;

/** One citizen card per persona, each naming its binding constraint and the site it chooses. */
async function expectCitizenCards(page: Page) {
  await expect(page.locator('[data-testid^=citizen-card-]')).toHaveCount(PERSONA_IDS.length);
  for (const id of PERSONA_IDS) {
    const card = page.getByTestId(`citizen-card-${id}`);
    await expect(card.locator(`[data-bind="result.personas.${id}.topFriction"]`)).not.toHaveText('—');
    await expect(card.getByTestId('citizen-choice-score')).not.toHaveText('—');
  }
}

/** Collects page errors and console errors for the final assertion. */
function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return errors;
}

test('three dashboard (fixtures smoke): camera modes, heatmap, candidate switch, rule zero', async ({ page }) => {
  const errors = watchErrors(page);

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
  await expectCitizenCards(page);
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
  await expect(page.getByTestId('dashboard')).toHaveAttribute('data-weather', 'RAINY_SAT');
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

// The live engine (web worker, no fixtures): thousands of trips for the selected site, so boot and
// every scenario switch take longer than with fixtures.
const LIVE_READY_MS = 180_000;

async function openLive(page: Page) {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/?view=three');
  await expect(page.locator('[data-testid=city-three][data-ready=true]')).toBeVisible({ timeout: LIVE_READY_MS });
  await expect(page.locator('[data-testid=persona-card-senior] [data-bind="result.personas.senior.score"]'))
    .toHaveText(/\d/, { timeout: LIVE_READY_MS });
  const bar = page.getByTestId('live-bar');
  await expect.poll(async () => Number(await bar.getAttribute('data-runs')), { timeout: LIVE_READY_MS }).toBeGreaterThan(0);
  return { city: page.getByTestId('city-three'), bar };
}

test('three dashboard on the live engine: agents, citizen choice, street stats, weather, rule zero', async ({ page }) => {
  test.setTimeout(600_000);
  const errors = watchErrors(page);
  const { city, bar } = await openLive(page);

  // Agents: one dot per trip on its way at the peak slice.
  await page.getByTestId('slice-11:30_PEAK').click();
  await expect.poll(async () => Number(await city.getAttribute('data-agent-count')), { timeout: 60_000 })
    .toBeGreaterThanOrEqual(50);

  await expectCitizenCards(page);
  // Street slope and surface come from graph.json around the selected site.
  await expect(page.locator('[data-testid=kpi-slope] [data-bind="streetStats.meanSlope"]')).toHaveText(/^\d+\.\d$/, { timeout: 60_000 });
  await expect(page.locator('[data-testid=profile-slope] [data-bind="streetStats.p90Slope"]')).toHaveText(/^\d+\.\d$/);
  await expect(page.getByTestId('surface-bar').locator('[data-share]')).toHaveCount(4);
  await page.screenshot({ path: `${SHOTS}/three-live.png` });
  expect(await unboundDigits(page), 'every digit on screen must sit inside [data-bind]').toEqual([]);

  // Weather: the scenario switch re-runs the shortlist and the live run on the engine.
  const dashboard = page.getByTestId('dashboard');
  for (const scenario of ['RAINY_SAT', 'CHRISTMAS_MARKET'] as const) {
    const runs = Number(await bar.getAttribute('data-runs'));
    await page.getByTestId(`scenario-${scenario}`).click();
    await expect(page.getByTestId(`scenario-${scenario}`)).toHaveAttribute('aria-pressed', 'true', { timeout: LIVE_READY_MS });
    await expect(dashboard).toHaveAttribute('data-weather', scenario);
    await expect(bar).toHaveAttribute('data-live-scenario', scenario, { timeout: LIVE_READY_MS });
    await expect.poll(async () => Number(await bar.getAttribute('data-runs'))).toBeGreaterThan(runs);
    // The city mirrors the weather once the 3D view exposes it.
    if (await city.getAttribute('data-weather') !== null) await expect(city).toHaveAttribute('data-weather', scenario);
    await expectCitizenCards(page);
    await page.screenshot({ path: `${SHOTS}/three-live-${scenario.toLowerCase()}.png` });
    expect(await unboundDigits(page), `every digit bound after ${scenario}`).toEqual([]);
  }

  expect(errors, 'no console errors').toEqual([]);
});

test('three dashboard on the live engine: the heatmap toggle draws heat cells', async ({ page }) => {
  test.setTimeout(300_000);
  const { city } = await openLive(page);
  test.skip(await city.getAttribute('data-heat-cells') === null,
    'CityThree does not expose data-heat-cells yet; the 3D view adds it. Re-run once it lands.');

  const heat = page.getByTestId('heatmap-toggle');
  if (await heat.getAttribute('aria-pressed') === 'true') await heat.click();
  await expect(heat).toHaveAttribute('aria-pressed', 'false');
  await heat.click();
  await expect(heat).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => Number(await city.getAttribute('data-heat-cells')), { timeout: 60_000 }).toBeGreaterThan(0);
  await page.screenshot({ path: `${SHOTS}/three-live-heatmap.png` });
});

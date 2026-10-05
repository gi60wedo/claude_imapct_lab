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
  await page.screenshot({ path: `${SHOTS}/three-initial.png` });

  for (const mode of ['side', 'top', 'perspective'] as const) {
    await page.getByTestId(`camera-${mode}`).click();
    await expect(page.getByTestId(`camera-${mode}`)).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(800); // let the camera tween settle before the shot
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

  await page.getByTestId('slice-05:30_DELIVERY').click();
  await expect(page.getByTestId('slice-05:30_DELIVERY')).toHaveAttribute('aria-pressed', 'true');
  const clock = page.locator('[data-testid=time-bar] [data-bind=timeSec]');
  const t0 = await clock.textContent();
  await page.getByTestId('play').click();
  await expect.poll(() => clock.textContent(), { timeout: 5_000 }).not.toBe(t0);
  await page.getByTestId('play').click();
  await page.screenshot({ path: `${SHOTS}/three-delivery.png` });

  expect(await unboundDigits(page), 'every digit on screen must sit inside [data-bind]').toEqual([]);
  expect(errors, 'no console errors').toEqual([]);
});

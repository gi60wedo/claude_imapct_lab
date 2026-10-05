import { expect, test } from '@playwright/test';

// Needs `npm run server` (with a key, or BRIEF_OFFLINE=1 for cached/template output).
test.beforeAll(async ({ request }) => {
  const ok = await request.get('http://127.0.0.1:8787/api/health').then((r) => r.ok(), () => false);
  test.skip(!ok, 'Part D server is not running on :8787');
});

test('live brief: Claude brief, persona verdicts, mitigation loop, what-if delta', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?brief=live');
  const cockpit = page.getByTestId('cockpit');
  await expect(cockpit).toBeVisible();

  // initial live brief + verdicts for the selected site
  await expect(page.getByTestId('brief-source')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('persona-senior').locator('p')).not.toHaveText('verdict pending', { timeout: 60_000 });

  // propose → simulate → judge
  await page.getByRole('button', { name: 'Apply Claude mitigation' }).click();
  await expect(page.getByTestId('mitigation-note')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('applied')).toContainText(/kiosk|delivery window|layout/i);

  // what-if → "what changed and why"
  await page.getByRole('button', { name: 'Rainy' }).click();
  await expect(page.getByTestId('brief-delta')).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: 'e2e/__shots__/live-brief.png', fullPage: true });
});

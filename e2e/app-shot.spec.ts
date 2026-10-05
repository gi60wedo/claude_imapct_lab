import { expect, test } from '@playwright/test';

test('full app renders map, ranking and cockpit', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Rainy' })).toBeEnabled({ timeout: 20_000 });
  await expect(page.getByTestId('ranking-row').first()).toBeVisible();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'e2e/__shots__/app.png' });
});

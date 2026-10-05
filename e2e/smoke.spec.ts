import { expect, test } from '@playwright/test';

test('loads UrbanTwin', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('UrbanTwin', { exact: true })).toBeVisible();
});

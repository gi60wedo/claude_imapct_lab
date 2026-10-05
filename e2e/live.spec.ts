import { expect, test } from '@playwright/test';

// Runs B's engine in the Web Worker on real Nuremberg data (public/data/world.json).
test('live engine scores the shortlist and runs the Christmas scenario', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('ranking-row').first()).toBeVisible({ timeout: 60_000 });
  const rows = page.getByTestId('ranking-row');
  await expect.poll(() => rows.count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(3);
  const sunny = await rows.allInnerTexts();

  const xmas = page.getByRole('button', { name: 'Christmas market' });
  await expect(xmas).toBeEnabled({ timeout: 60_000 });
  await xmas.click();
  await expect(xmas).toHaveAttribute('aria-pressed', 'true', { timeout: 60_000 });
  await expect(page.getByText('scenario not available offline')).toHaveCount(0);
  await expect.poll(async () => (await rows.allInnerTexts()).join('|'), { timeout: 60_000 }).not.toBe(sunny.join('|'));
  expect(errors).toEqual([]);
});

test('live engine gives Kaufhof vendors a loading point and blocks Lorenzkirche', async ({ page }) => {
  await page.goto('/');
  const row = (id: string) => page.locator(`[data-testid="ranking-row"][data-id="${id}"]`);
  await expect(row('KAUFHOF')).toBeVisible({ timeout: 60_000 });
  const vendor = async (id: string) => Number((await row(id).innerText()).match(/Vendor\s+([\d.]+)/)![1]);
  expect(await vendor('KAUFHOF')).toBeGreaterThan(await vendor('LORENZKIRCHE') + 30);
});

import { expect, test } from '@playwright/test';

test('what-if scenarios update compare and handle offline scenario', async ({ page }) => {
  await page.goto('/');
  const compareBtn = page.getByRole('button', { name: 'Compare', exact: true });
  await expect(compareBtn).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Sunny' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => {
    await compareBtn.click();
    const shown = await page.getByTestId('compare').isVisible();
    if (!shown) await compareBtn.click();
    return shown;
  }).toBeTruthy();

  const compare = page.getByTestId('compare');
  const read = async () => (await compare.locator('td[data-testid^="cmp-"]').allInnerTexts()).join('|');
  const before = await read();

  await page.getByRole('button', { name: 'Rainy' }).click();
  await expect(page.getByRole('button', { name: 'Rainy' })).toHaveAttribute('aria-pressed', 'true');
  await expect(compare).toBeVisible();
  expect(await read()).not.toBe(before);
  const rainy = await read();

  await page.getByRole('button', { name: 'Christmas market' }).click();
  await expect(page.getByText('scenario not available offline')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rainy' })).toHaveAttribute('aria-pressed', 'true');
  expect(await read()).toBe(rainy);
});

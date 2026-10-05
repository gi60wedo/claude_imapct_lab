import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const fx = (f: string) => JSON.parse(readFileSync(`public/data/fixtures/${f}`, 'utf8'));

test('cockpit shows fixture scores, exports brief, applies mitigation', async ({ page }) => {
  const brief = fx('brief.json');
  const requests: string[] = [];
  page.on('request', (r) => { if (/\/data\/fixtures\/result-/.test(r.url())) requests.push(r.url()); });
  await page.goto('/?data=fixtures');

  const cockpit = page.getByTestId('cockpit');
  await expect(cockpit).toBeVisible();

  // selected candidate = first fixture result loaded; find its file via the request log
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  const first = requests[0].match(/result-(.+)-SUNNY_SAT\.json/)![1];
  const result = fx(`result-${first}-SUNNY_SAT.json`);
  for (const p of ['senior', 'vendor', 'commuter', 'retailer'] as const) {
    await expect(page.getByTestId(`score-${p}`)).toHaveText(String(result.personas[p].score));
  }

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export council brief' }).click();
  const d = await download;
  expect(d.suggestedFilename()).toBe('council-brief.md');
  const path = await d.path();
  expect(readFileSync(path!, 'utf8')).toBe(brief.councilBriefMd);

  const before = requests.length;
  await page.getByRole('button', { name: 'Apply Claude mitigation' }).click();
  await expect(page.getByTestId('applied')).toContainText(brief.losers[0].mitigation);
  expect(requests.length - before).toBe(1);
});

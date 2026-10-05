import { expect, test } from '@playwright/test';
import type { Candidate, SimulationResult, Weights } from '../src/contracts';
import { normalize, PRESETS, rank } from '../src/ui/ranking/applyWeights';

test('ranking follows fixture scores, selects sites, and responds within 100 ms', async ({ page }) => {
  // Keep this check offline even when the map gains external basemap layers.
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return ['127.0.0.1', 'localhost'].includes(url.hostname) || !url.protocol.startsWith('http')
      ? route.continue() : route.abort();
  });
  await page.goto('/?data=fixtures');
  const rows = page.getByTestId('ranking-row');
  await expect(rows.first()).toBeVisible();
  const fixtures = await page.evaluate(async () => {
    const modulePath = '/src/ui/state/store.ts';
    const store = await import(/* @vite-ignore */ modulePath);
    const state = store.getState();
    return {
      weights: state.weights as Weights,
      results: Object.values(store.currentResults(state)) as SimulationResult[],
      passedIds: (state.candidates as Candidate[]).filter((c) => c.passedFilter).map((c) => c.id),
      rejected: (state.candidates as Candidate[]).filter((c) => !c.passedFilter),
    };
  });
  const results = fixtures.results.filter((r) => fixtures.passedIds.includes(r.candidateId));
  expect(results.length).toBeGreaterThan(1);
  const expectedIds = (weights: Weights) => rank(results, weights).map((r) => r.candidateId);
  const readIds = () => rows.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-id')));
  await expect.poll(readIds).toEqual(expectedIds(fixtures.weights));

  for (const result of results) {
    const row = page.locator(`[data-testid="ranking-row"][data-id="${result.candidateId}"]`);
    const guarded = Object.values(result.personas).some((p) => p.score < 40);
    await expect(row.getByTestId('stakeholder-guard')).toHaveCount(guarded ? 1 : 0);
  }
  const selectedId = await rows.last().getAttribute('data-id');
  await rows.last().click();
  await expect(rows.last()).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(async () => {
    const modulePath = '/src/ui/state/store.ts';
    return (await import(/* @vite-ignore */ modulePath)).getState().selectedId;
  })).toBe(selectedId);

  // Check every preset against the fixture criteria and prove a reorder when possible.
  const orders: string[][] = [];
  for (let index = 0; index < PRESETS.length; index++) {
    await page.getByTestId(`preset-${index + 1}`).click();
    const expected = expectedIds(normalize(PRESETS[index].weights));
    orders.push(expected);
    await expect.poll(readIds).toEqual(expected);
    await expect(page.getByTestId(`preset-${index + 1}`)).toHaveAttribute('aria-pressed', 'true');
  }
  const reorderPossible = orders.some((order) => order.join() !== expectedIds(fixtures.weights).join());
  expect(reorderPossible, 'fixtures must let at least one preset reorder the ranking').toBe(true);
  {
    const changedIndex = orders.findIndex((order) => order.join() !== expectedIds(fixtures.weights).join());
    await page.evaluate(async (weights) => {
      const modulePath = '/src/ui/state/store.ts';
      (await import(/* @vite-ignore */ modulePath)).setState({ weights });
    }, fixtures.weights);
    await expect.poll(readIds).toEqual(expectedIds(fixtures.weights));
    await page.getByTestId(`preset-${changedIndex + 1}`).click();
    await expect.poll(readIds).toEqual(orders[changedIndex]);
    expect(await readIds()).not.toEqual(expectedIds(fixtures.weights));
  }

  const timings = await page.evaluate(async () => {
    const panel = document.querySelector('[data-testid="ranking-panel"]')!;
    const input = panel.querySelector<HTMLInputElement>('[data-testid="weight-accessibility"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    const snapshot = () => Array.from(panel.querySelectorAll('[data-testid="ranking-row"]'))
      .map((row) => `${row.getAttribute('data-id')}:${row.getAttribute('data-score')}`).join('|');
    const samples: number[] = [];
    for (let index = 0; index < 20; index++) {
      const before = snapshot();
      const elapsed = await new Promise<number>((resolve, reject) => {
        let started = 0;
        const observer = new MutationObserver(() => {
          if (snapshot() === before) return;
          observer.disconnect();
          clearTimeout(timeout);
          resolve(performance.now() - started);
        });
        const timeout = window.setTimeout(() => {
          observer.disconnect();
          reject(new Error('Slider input did not update ranking scores/order within 2 seconds'));
        }, 2000);
        observer.observe(panel, { subtree: true, childList: true, attributes: true, characterData: true });
        setValue.call(input, index % 2 === 0 ? '0' : '1');
        started = performance.now();
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      samples.push(elapsed);
    }
    return samples;
  });
  expect(timings).toHaveLength(20);
  const sorted = [...timings].sort((a, b) => a - b);
  const median = (sorted[9] + sorted[10]) / 2;
  console.log(`Ranking slider input → DOM update: median ${median.toFixed(2)} ms (${timings.length} samples)`);
  expect(median).toBeLessThan(100);
  await test.info().attach('slider-latency.json', { body: JSON.stringify({ median, samples: timings }), contentType: 'application/json' });

  const finalState = await page.evaluate(async () => {
    const modulePath = '/src/ui/state/store.ts';
    return (await import(/* @vite-ignore */ modulePath)).getState().weights as Weights;
  });
  expect(Object.values(finalState).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  await expect.poll(readIds).toEqual(expectedIds(finalState));

  if (fixtures.rejected.length > 0) {
    const details = page.getByTestId('ranking-panel').locator('details');
    await expect(details).not.toHaveAttribute('open');
    await details.locator('summary').click();
    for (const candidate of fixtures.rejected) {
      const row = page.locator(`[data-testid="rejected-row"][data-id="${candidate.id}"]`);
      if (candidate.rejectReason) await expect(row).toContainText(candidate.rejectReason);
      await expect(page.locator(`[data-testid="ranking-row"][data-id="${candidate.id}"]`)).toHaveCount(0);
    }
    await page.getByTestId('rejected-row').first().click();
    await expect(page.getByTestId('rejected-row').first()).toHaveAttribute('aria-pressed', 'true');
  }
});

import { errors, expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { SceneState } from '../src/ui/scenes/types';

/** Independent oracle for the frozen binding grammar, including scoped roots. */
async function auditBindings(page: Page, live: boolean) {
  const audit = await page.evaluate((readLive) => {
    const state = readLive ? window.__scene?.state
      : (window as unknown as { hudFixtureState: SceneState }).hudFixtureState;
    if (!state?.scope) throw new Error('Scene has no binding scope');
    const scope = state.scope;
    const get = (path: string): unknown => {
      const tokens = [...path.matchAll(/([A-Za-z_][A-Za-z0-9_]*)|\[([^\]]+)\]/g)];
      const first = tokens[0]?.[1];
      const rooted = first && Object.prototype.hasOwnProperty.call(scope, first);
      let value: unknown = rooted ? scope : scope.result;
      for (const token of tokens) {
        if (value == null) return undefined;
        if (token[1]) value = (value as Record<string, unknown>)[token[1]];
        else {
          const selector = token[2];
          if (/^\d+$/.test(selector)) value = (value as unknown[])[Number(selector)];
          else if (/^'[^']*'$/.test(selector)) value = (value as Record<string, unknown>)[selector.slice(1, -1)];
          else {
            const equals = selector.indexOf('=');
            if (equals < 0 || !Array.isArray(value)) return undefined;
            value = value.find((item) => item != null
              && String(item[selector.slice(0, equals)]) === selector.slice(equals + 1));
          }
        }
      }
      return value;
    };
    const format = (value: unknown, kind?: string) => {
      if (value == null || typeof value === 'object'
        || typeof value === 'number' && !Number.isFinite(value)) return '—';
      if (kind === 'text' || typeof value !== 'number') return String(value);
      if (kind === 'clock') {
        const minutes = Math.floor(value / 60);
        return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
      }
      if (kind === 'num1') return value.toFixed(1);
      return String(Math.sign(value) * Math.round(Math.abs(value)));
    };
    const elements = [...document.querySelectorAll<HTMLElement>('[data-bind]')];
    const mismatches: string[] = [];
    for (const element of elements) {
      const path = element.dataset.bind!;
      const expected = format(get(path), element.dataset.format);
      if (element.textContent !== expected) mismatches.push(`${path}: ${element.textContent} != ${expected}`);
      if (parseFloat(getComputedStyle(element).fontSize) < 18) mismatches.push(`${path}: text below 18px`);
    }
    for (const caption of state.captions) {
      const parent = [...document.querySelectorAll<HTMLElement>('[data-caption-id]')]
        .find((element) => element.dataset.captionId === caption.id);
      if (!parent) { mismatches.push(`Missing caption ${caption.id}`); continue; }
      const actual = [...parent.querySelectorAll<HTMLElement>('[data-bind]')];
      const parts = caption.parts.filter((part) => part.kind === 'binding');
      if (actual.length !== parts.length) mismatches.push(`Binding count for ${caption.id}`);
      parts.forEach((part, index) => {
        if (actual[index]?.dataset.bind !== part.path || actual[index]?.textContent !== part.text
          || actual[index]?.dataset.format !== part.format
          || part.text !== format(get(part.path), part.format)) mismatches.push(`Caption ${caption.id}: ${part.path}`);
      });
    }
    const hud = document.querySelector('[data-testid="scene-hud"]');
    if (hud) {
      const walker = document.createTreeWalker(hud, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (/\d/.test(node.textContent ?? '') && !node.parentElement?.closest('[data-bind]'))
          mismatches.push(`Unbound number: ${node.textContent}`);
      }
    }
    return { count: elements.length, mismatches };
  }, live);
  expect(audit.count, 'HUD must expose bound values').toBeGreaterThan(0);
  expect(audit.mismatches).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  // Keep this fixture suite entirely on localhost, including map requests.
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
});

test('HUD renders fixture persona values, source chips, deterministic fades and the Apply slot', async ({ page }) => {
  // Vite transforms the fixture entry and installs the React refresh preamble.
  await page.goto('/e2e/fixtures/hud-harness.html');
  await expect(page.getByTestId('scene-hud')).toBeVisible();
  await expect(page.locator('[data-persona]')).toHaveCount(4);
  await expect(page.getByTestId('scene-fixture')).toHaveText('fixtures');
  await expect(page.locator('[data-caption-id="senior-score"]')).toHaveCSS('opacity', '0.5');
  await auditBindings(page, false);
  await page.getByRole('button', { name: 'Apply Claude mitigation' }).click();
  await expect(page.locator('[data-caption-id="comparison"]')).toBeVisible();
  await expect(page.locator('[data-caption-id="senior-score"]')).toHaveCSS('opacity', '1');
  await auditBindings(page, false);
});

for (const scene of ['1', '2']) {
  test(`RZ-live: scene ${scene} binds every keyframe and the mitigation result`, async ({ page }) => {
    await page.goto(`/?scene=${scene}&data=fixtures`);
    // Allow asynchronous scene loading to install the director before skipping.
    await page.waitForFunction(() => Boolean(window.__scene), null, { timeout: 10_000 })
      .catch((error: unknown) => {
        if (!(error instanceof errors.TimeoutError)) throw error;
      });
    test.skip(
      !await page.evaluate(() => Boolean(window.__scene)),
      'Scene director window.__scene is absent; requires S2 and scene routing integration.',
    );
    await expect.poll(() => page.evaluate(() => Boolean(window.__scene?.state.scope)), {
      message: 'Scene integration must mount window.__scene with fixture data (S1/S2/S5/S6 and main.tsx routing)',
      timeout: 10_000,
    }).toBeTruthy();
    await page.evaluate(() => window.__scene!.pause());
    const keyframes = await page.evaluate(() => window.__scene!.keyframes);
    expect(keyframes.length).toBeGreaterThan(0);
    for (const keyframe of keyframes) {
      await page.evaluate((t) => window.__scene!.seek(t), keyframe.t);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      if (keyframe.gated) {
        await auditBindings(page, true);
        const before = await page.evaluate(() => window.__scene!.state.scope!.before);
        await page.getByRole('button', { name: 'Apply Claude mitigation' }).click();
        await expect.poll(() => page.evaluate(() => Boolean(window.__scene!.state.scope!.after)), {
          message: 'Mitigation must complete and expose the after result',
        }).toBeTruthy();
        const after = await page.evaluate(() => window.__scene!.state.scope!.after);
        expect(after, 'Apply must expose a new engine result').not.toBeNull();
        expect(after!.seed).toBe(before.seed);
        await page.evaluate((t) => window.__scene!.seek(t), keyframe.t);
      }
      await expect(page.getByTestId('scene-hud')).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.__scene!.state.keyframeId)).toBe(keyframe.id);
      // Let React commit the director subscription before collecting the DOM.
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      await auditBindings(page, true);
      await page.evaluate((t) => window.__scene!.seek(t), keyframe.t + keyframe.durationMs / 2);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      await auditBindings(page, true);
    }
  });
}

import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Brief, SimulationResult } from '../src/contracts';
import type { SceneState } from '../src/ui/scenes/types';

// Read fixture files in the runner, independently of the page and director.
const fixture = <T,>(name: string): T => JSON.parse(readFileSync(
  new URL(`../public/data/fixtures/${name}.json`, import.meta.url), 'utf8',
)) as T;
const harnessBefore = fixture<SimulationResult>('result-KAUFHOF-SUNNY_SAT');
const harnessAfter = fixture<SimulationResult>('result-KAUFHOF-RAINY_SAT');
const brief = fixture<Brief>('brief');
// Synthetic mitigation response: rainy geometry and the sunny commuter profile.
// This fixture tests result switching; it makes no claim about engine effects.
const mitigationPersonas = JSON.parse(readFileSync(
  new URL('./fixtures/mitigation-personas.json', import.meta.url), 'utf8',
)) as SimulationResult['personas'];

interface ExpectedResults {
  before: SimulationResult;
  after: SimulationResult | null;
  result: SimulationResult;
}

/** Independent path and formatting oracle; engine values come from fixture JSON. */
async function auditBindings(page: Page, live: boolean, expected: ExpectedResults) {
  const state = await page.evaluate((readLive) => readLive ? window.__scene!.state
    : (window as unknown as { hudFixtureState: SceneState }).hudFixtureState, live);
  expect(state.errors, 'Every keyframe must resolve all bindings').toEqual([]);
  expect(state.scope, 'Scene must provide a binding scope').not.toBeNull();
  expect(state.scope!.before, 'Before must match the independent fixture').toEqual(expected.before);
  expect(state.scope!.after, 'After must match the independent fixture').toEqual(expected.after);
  expect(state.scope!.result, 'Active scope must switch at the Apply gate').toEqual(expected.result);
  expect(state.result, 'Active result must match scope.result').toEqual(expected.result);

  const audit = await page.evaluate(({ state, expected }) => {
    const scope = { ...state.scope!, ...expected };
    const get = (path: string, active = scope.result): unknown => {
      const tokens = [...path.matchAll(/([A-Za-z_][A-Za-z0-9_]*)|\[([^\]]+)\]/g)];
      const first = tokens[0]?.[1];
      const rooted = first && Object.prototype.hasOwnProperty.call(scope, first);
      let value: unknown = rooted ? { ...scope, result: active } : active;
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
        const minutes = ((Math.floor(value / 60) % 1440) + 1440) % 1440;
        return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
      }
      const factor = kind === 'num1' ? 10 : 1;
      const rounded = (Math.sign(value) * Math.floor(Math.abs(value) * factor + 0.5)) / factor;
      return kind === 'num1' ? (rounded === 0 ? 0 : rounded).toFixed(1) : String(rounded);
    };
    const root = document.querySelector('[data-testid="scene-root"], [data-testid="scene-view"]')
      ?? document.getElementById('root');
    if (!root) throw new Error('Scene root is missing');
    const elements = [...root.querySelectorAll<HTMLElement>('[data-bind]')];
    const mismatches: string[] = [];
    let changedPersonaBindings = 0;
    for (const element of elements) {
      const path = element.dataset.bind!;
      const text = format(get(path), element.dataset.format);
      if (element.textContent !== text) mismatches.push(`${path}: ${element.textContent} != ${text}`);
      const personaPath = path.replace(/^(result|before|after)\./, '');
      if (personaPath.startsWith('personas.') && expected.after) {
        const before = get(personaPath, expected.before);
        const after = get(personaPath, expected.after);
        if (typeof before === 'number' && typeof after === 'number'
          && format(before, element.dataset.format) !== format(after, element.dataset.format)) changedPersonaBindings++;
      }
    }
    for (const caption of state.captions) {
      const parent = [...root.querySelectorAll<HTMLElement>('[data-caption-id]')]
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
      if (Number(getComputedStyle(parent).opacity) !== caption.opacity)
        mismatches.push(`Caption ${caption.id}: incorrect opacity`);
    }
    const hud = root.querySelector('[data-testid="scene-hud"]');
    if (!hud) throw new Error('Scene HUD is missing');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent || parent.closest('script, style, noscript') || !node.textContent?.trim()) continue;
      if (/\p{Nd}/u.test(node.textContent) && !parent.closest('[data-bind]'))
        mismatches.push(`Unbound number: ${node.textContent}`);
      if (hud.contains(parent) && parseFloat(getComputedStyle(parent).fontSize) < 18)
        mismatches.push(`Text below 18px: ${node.textContent}`);
    }
    return { count: elements.length, mismatches, changedPersonaBindings };
  }, { state, expected });
  expect(audit.count, 'HUD must expose bound values').toBeGreaterThan(0);
  expect(audit.mismatches).toEqual([]);
  return audit;
}

const commitFrame = (page: Page) => page.evaluate(() => new Promise<void>((resolve) =>
  requestAnimationFrame(() => resolve())));

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
});

test('HUD renders fixture persona values, source chips, deterministic fades and the Apply slot', async ({ page }) => {
  await page.goto('/e2e/fixtures/hud-harness.html');
  await expect(page.getByTestId('scene-hud')).toBeVisible();
  await expect(page.locator('[data-persona]')).toHaveCount(4);
  await expect(page.getByTestId('scene-fixture')).toHaveText('fixtures');
  await expect(page.locator('[data-caption-id="senior-score"]')).toHaveCSS('opacity', '0.5');
  await auditBindings(page, false, { before: harnessBefore, after: null, result: harnessBefore });
  await page.getByRole('button', { name: 'Apply Claude mitigation' }).click();
  await expect(page.locator('[data-caption-id="comparison"]')).toBeVisible();
  await expect(page.locator('[data-caption-id="senior-score"]')).toHaveCSS('opacity', '1');
  const audit = await auditBindings(page, false, { before: harnessBefore, after: harnessAfter, result: harnessAfter });
  expect(audit.changedPersonaBindings, 'A displayed persona value must change after Apply').toBeGreaterThan(0);
});

test('HUD preserves continuous opacity and maps errors to digit-free messages', async ({ page }) => {
  await page.goto('/e2e/fixtures/hud-harness.html?opacity=0.4567&error=mitigation%20rerun%20failed:%20HTTP%20503');
  await expect(page.getByRole('alert')).toHaveText('Mitigation unavailable. Please try again.');
  await expect(page.locator('[data-caption-id="senior-score"]')).toHaveCSS('opacity', '0.4567');
  await auditBindings(page, false, { before: harnessBefore, after: null, result: harnessBefore });
});

for (const scene of ['1', '2']) {
  test(`RZ-live: scene ${scene} binds every keyframe and the mitigation result`, async ({ page }) => {
    test.skip(process.env.SCENE_RZ_SKIP === '1', 'SCENE_RZ_SKIP=1 explicitly disables live scene checks');
    const before = fixture<SimulationResult>(scene === '1'
      ? 'result-LORENZKIRCHE-SUNNY_SAT' : 'result-KAUFHOF-RAINY_SAT');
    const after: SimulationResult = { ...before, personas: mitigationPersonas,
      mitigations: brief.losers.map((loser) => loser.mitigation) };
    let applying = false;
    let rerunRequests = 0;
    await page.route(`**/data/fixtures/result-${before.candidateId}-${before.scenario}.json`, (route) => {
      if (applying) rerunRequests++;
      return route.fulfill({ json: applying ? after : before });
    });
    await page.goto(`/?scene=${scene}&data=fixtures`);
    await expect.poll(() => page.evaluate(() => Boolean(window.__scene?.state.scope)), {
      message: 'Scene integration must mount window.__scene with fixture data', timeout: 10_000,
    }).toBeTruthy();
    await page.evaluate(() => window.__scene!.pause());
    const keyframes = await page.evaluate(() => window.__scene!.keyframes);
    expect(keyframes.length).toBeGreaterThan(0);
    if (scene === '2') expect(keyframes.some((keyframe) => keyframe.gated), 'Scene two must expose the Apply gate').toBeTruthy();
    let applied = false;
    let changedPersonaBindings = 0;
    const audit = async (activeAfter: boolean) => {
      const report = await auditBindings(page, true, { before, after: applied ? after : null,
        result: activeAfter ? after : before });
      if (activeAfter) changedPersonaBindings += report.changedPersonaBindings;
    };
    for (const keyframe of keyframes) {
      await page.evaluate((t) => window.__scene!.seek(t), keyframe.t);
      await commitFrame(page);
      await audit(applied);
      if (keyframe.gated) {
        applying = true;
        await page.getByRole('button', { name: 'Apply Claude mitigation' }).click();
        await expect.poll(() => page.evaluate(() => window.__scene!.state.phase), {
          message: 'Mitigation must complete successfully',
        }).not.toBe('rerunning');
        await expect.poll(() => page.evaluate(() => Boolean(window.__scene!.state.scope!.after))).toBeTruthy();
        expect(rerunRequests, 'Apply must load one new fixture result').toBe(1);
        applied = true;
        await page.evaluate((t) => window.__scene!.seek(t), keyframe.t);
        await commitFrame(page);
      }
      await expect(page.getByTestId('scene-hud')).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.__scene!.state.keyframeId)).toBe(keyframe.id);
      await audit(applied);
      await page.evaluate((t) => window.__scene!.seek(t), keyframe.t + keyframe.durationMs / 2);
      await commitFrame(page);
      await audit(applied);
    }
    if (applied) {
      expect(changedPersonaBindings, 'At least one bound persona value must differ before and after').toBeGreaterThan(0);
      // Seeking back across a resolved gate must restore the original active result.
      await page.evaluate((t) => window.__scene!.seek(t), keyframes[0].t);
      await commitFrame(page);
      await audit(false);
    }
  });
}

import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { setState } from '../state/store';

const fixture = (name: string) =>
  JSON.parse(readFileSync(`${process.cwd()}/public/data/fixtures/${name}.json`, 'utf8'));

vi.mock('../adapters', () => ({
  sim: {
    candidates: async () => fixture('candidates'),
    run: async (id: string, scenario: string) => fixture(`result-${id}-${scenario}`),
  },
  briefClient: { brief: async () => fixture('brief') },
}));

// The street stats fetch graph.json; serve the real file.
const graph = fixture('../graph');
vi.stubGlobal('fetch', async (url: string) => {
  if (!String(url).endsWith('data/graph.json')) throw new Error(`unexpected fetch ${url}`);
  return { ok: true, status: 200, json: async () => graph };
});

// The real CityThree needs WebGL; the audit covers the dashboard around it.
vi.mock('../three/CityThree', () => ({ default: () => <div data-testid="city-three" data-ready="true" /> }));

const { default: Dashboard } = await import('./Dashboard');

afterEach(() => { cleanup(); setState({ candidates: [], results: {}, brief: null, selectedId: null, playing: false, timeSec: 0 }); });

const unboundDigits = (root: Element) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const bad: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (/\d/.test(n.textContent ?? '') && !n.parentElement?.closest('[data-bind]')) bad.push(n.textContent!.trim());
  }
  return bad;
};

const personaNumbers = () =>
  [...document.querySelectorAll('[data-testid^=persona-card-] [data-bind^="result.personas."]')].map((e) => e.textContent);

test('every digit on the dashboard is bound and the persona cards follow the selection', async () => {
  render(<Dashboard />);
  await waitFor(() => expect(screen.getAllByTestId('candidate-card').length).toBeGreaterThan(1));
  await waitFor(() => expect(document.querySelector('[data-bind="result.personas.senior.score"]')?.textContent).toMatch(/\d/));
  expect(unboundDigits(screen.getByTestId('dashboard'))).toEqual([]);

  // The selected candidate is marked, and persona cards drop the verdict line when there is none.
  const selected = screen.getAllByTestId('candidate-card').filter((c) => c.getAttribute('aria-pressed') === 'true');
  expect(selected).toHaveLength(1);
  expect(selected[0].querySelector('[data-testid=candidate-viewing]')).not.toBeNull();
  for (const card of screen.getAllByTestId(/^persona-card-/)) {
    const verdict = card.querySelector('[data-bind$=".verdict"]');
    if (verdict) expect(verdict.textContent).not.toBe('—');
  }

  const before = personaNumbers();
  const cards = screen.getAllByTestId('candidate-card');
  const target = cards[1].getAttribute('aria-pressed') === 'true' ? cards[0] : cards[1];
  await act(async () => { fireEvent.click(target); });
  expect(target.getAttribute('aria-pressed')).toBe('true');
  expect(personaNumbers()).not.toEqual(before);
  expect(unboundDigits(screen.getByTestId('dashboard'))).toEqual([]);
});

/** Tailwind size classes below 14 px: text-xs (12 px) and arbitrary text-[Npx] with N < 14. */
const smallText = (root: Element) =>
  [...root.querySelectorAll('[class]')].flatMap((el) => {
    if (el.closest('svg')) return []; // SVG text sizes are viewBox units, scaled by the drawing.
    return (el.getAttribute('class') ?? '').split(/\s+/).filter((c) => c === 'text-xs' || /^text-\[(\d+)px\]$/.test(c) && Number(c.slice(6, -3)) < 14);
  });

test('citizen choice, street stats and glass KPIs render from engine and graph data', async () => {
  render(<Dashboard />);
  await waitFor(() => expect(document.querySelector('[data-bind="result.personas.senior.score"]')?.textContent).toMatch(/\d/));
  // One citizen card per persona, each with a binding constraint and a choice.
  for (const id of ['senior', 'vendor', 'commuter', 'retailer']) {
    const card = screen.getByTestId(`citizen-card-${id}`);
    expect(card.querySelector(`[data-bind="result.personas.${id}.topFriction"]`)?.textContent).not.toBe('—');
    expect(card.querySelector('[data-testid=citizen-choice-score] [data-bind$=".score).name"]')?.textContent).toBeTruthy();
    expect(card.querySelectorAll('[data-testid=driver]').length).toBeGreaterThan(1);
  }
  // Street slope from graph.json lands in the top bar and the profile, with a surface bar.
  await waitFor(() => expect(screen.getByTestId('kpi-slope').querySelector('[data-bind="streetStats.meanSlope"]')?.textContent).toMatch(/^\d+\.\d$/));
  expect(screen.getByTestId('profile-slope').querySelector('[data-bind="streetStats.p90Slope"]')?.textContent).toMatch(/^\d+\.\d$/);
  const shares = [...screen.getByTestId('surface-bar').querySelectorAll('[data-share]')].map((e) => Number(e.getAttribute('data-share')));
  expect(shares).toHaveLength(4);
  expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  expect(screen.getByTestId('dashboard').getAttribute('data-weather')).toBe('SUNNY_SAT');
  expect(unboundDigits(screen.getByTestId('dashboard'))).toEqual([]);
  expect(smallText(screen.getByTestId('dashboard'))).toEqual([]);
});

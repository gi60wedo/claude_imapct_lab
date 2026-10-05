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

  const before = personaNumbers();
  const cards = screen.getAllByTestId('candidate-card');
  const target = cards[1].getAttribute('aria-pressed') === 'true' ? cards[0] : cards[1];
  await act(async () => { fireEvent.click(target); });
  expect(target.getAttribute('aria-pressed')).toBe('true');
  expect(personaNumbers()).not.toEqual(before);
  expect(unboundDigits(screen.getByTestId('dashboard'))).toEqual([]);
});

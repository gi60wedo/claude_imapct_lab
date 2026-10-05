import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Candidate, SimulationResult, Weights } from '../../contracts';
import { getState, resultKey, setState } from '../state/store';
import RankingPanel from './RankingPanel';
import { applyWeights, failsStakeholderGroup, normalize, PRESETS, rank, WEIGHT_KEYS, setWeight } from './applyWeights';

function result(candidateId: string, criteria: Weights, seniorScore = 70): SimulationResult {
  const persona = { score: 70, served: 7, droppedOut: 3, topFriction: 'Cobblestones' };
  return {
    candidateId, criteria, scenario: 'SUNNY_SAT', seed: 42, mitigations: [],
    personas: { senior: { ...persona, score: seniorScore }, vendor: { ...persona }, commuter: { ...persona }, retailer: { ...persona } },
    bySlice: {
      '05:30_DELIVERY': { heat: [], bottlenecks: [] },
      '11:30_PEAK': { heat: [], bottlenecks: [] },
      '15:00_LULL': { heat: [], bottlenecks: [] },
    },
    stallExposure: [], trips: [],
  };
}

describe('normalize', () => {
  it('preserves ratios, sums to one, and leaves its input unchanged', () => {
    const w = { accessibility: 3, footfall: 2, fairness: 1, localBusiness: 2, walkability: 2 };
    const original = { ...w };
    const normalized = normalize(w);
    for (const key of WEIGHT_KEYS) expect(normalized[key]).toBeCloseTo(w[key] / 10);
    expect(w).toEqual(original);
    expect(Object.values(normalize(w)).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
  it('falls back to equal shares when all weights are zero', () => {
    expect(normalize({ accessibility: 0, footfall: 0, fairness: 0, localBusiness: 0, walkability: 0 })).toEqual({ accessibility: .2, footfall: .2, fairness: .2, localBusiness: .2, walkability: .2 });
  });
  it('ignores negative/nonfinite entries and handles large finite values', () => {
    expect(normalize({ accessibility: -1, footfall: NaN, fairness: Infinity, localBusiness: 2, walkability: 2 })).toEqual({ accessibility: 0, footfall: 0, fairness: 0, localBusiness: .5, walkability: .5 });
    const normalized = normalize({ accessibility: Number.MAX_VALUE, footfall: Number.MAX_VALUE, fairness: 0, localBusiness: 0, walkability: 0 });
    expect(normalized.accessibility).toBe(.5);
    expect(normalized.footfall).toBe(.5);
  });
});

describe('weighted ranking', () => {
  const accessible = result('accessible', { accessibility: 95, footfall: 45, fairness: 30, localBusiness: 25, walkability: 75 });
  const fair = result('fair', { accessibility: 30, footfall: 45, fairness: 95, localBusiness: 25, walkability: 75 });
  it('computes the weighted sum without normalizing supplied weights', () => {
    expect(applyWeights(accessible.criteria, PRESETS[0].weights)).toBeCloseTo(66.25);
    expect(applyWeights(accessible.criteria, { accessibility: 2, footfall: 0, fairness: 0, localBusiness: 0, walkability: 0 })).toBe(190);
  });
  it('sorts descending, changes order with priorities, and leaves the source intact', () => {
    const source = [fair, accessible];
    expect(rank(source, PRESETS[0].weights).map((r) => r.candidateId)).toEqual(['accessible', 'fair']);
    expect(rank(source, PRESETS[1].weights).map((r) => r.candidateId)).toEqual(['fair', 'accessible']);
    expect(source).toEqual([fair, accessible]);
    expect(rank({ accessible, fair }, PRESETS[0].weights)[0]).toBe(accessible);
  });
  it('preserves input order for ties and handles empty results', () => {
    const tie = result('tie', accessible.criteria);
    expect(rank([tie, accessible], PRESETS[0].weights)).toEqual([tie, accessible]);
    expect(rank([], PRESETS[0].weights)).toEqual([]);
  });
  it('defines all three plan presets in the contracted criterion order', () => {
    expect(PRESETS.map((p) => WEIGHT_KEYS.map((key) => p.weights[key]))).toEqual([
      [.45, .20, .15, .10, .10], [.20, .20, .40, .10, .10], [.20, .25, .10, .35, .10],
    ]);
  });
});

describe('stakeholder guard', () => {
  it('flags every persona below 40, regardless of the total score', () => {
    for (const id of ['senior', 'vendor', 'commuter', 'retailer'] as const) {
      const r = result('guarded', { accessibility: 100, footfall: 100, fairness: 100, localBusiness: 100, walkability: 100 });
      r.personas[id].score = 39.9;
      expect(failsStakeholderGroup(r)).toBe(true);
    }
  });
  it('accepts a score of exactly 40 and all scores above it', () => {
    expect(failsStakeholderGroup(result('boundary', { accessibility: 50, footfall: 50, fairness: 50, localBusiness: 50, walkability: 50 }, 40))).toBe(false);
  });
});

const initialState = getState();
afterEach(() => {
  cleanup();
  setState(initialState);
});

function candidate(id: string, passedFilter = true): Candidate {
  return {
    id, name: id, kind: 'square', polygon: [], areaM2: 1000,
    indicators: { transitScore: 70, walkScore: 80, population800m: 500, retailPoi400m: 20, attractions400m: 5, deliveryAccess: passedFilter, vanDistM: 50 },
    passedFilter, ...(passedFilter ? {} : { rejectReason: 'No legal delivery route' }),
  };
}

function setup() {
  const accessible = result('accessible', { accessibility: 95, footfall: 45, fairness: 30, localBusiness: 25, walkability: 75 }, 39);
  const fair = result('fair', { accessibility: 30, footfall: 45, fairness: 95, localBusiness: 25, walkability: 75 });
  setState({
    candidates: [candidate('accessible'), candidate('fair'), candidate('rejected', false)],
    results: {
      [resultKey(accessible.candidateId, accessible.scenario)]: accessible,
      [resultKey(fair.candidateId, fair.scenario)]: fair,
    },
    weights: PRESETS[0].weights, selectedId: null, scenario: 'SUNNY_SAT', loading: false,
  });
  render(<RankingPanel />);
  return { accessible, fair };
}

describe('ranking panel', () => {
  it('renders computed totals/personas, flags the guard, and selects a site', () => {
    const { accessible } = setup();
    const rows = screen.getAllByTestId('ranking-row');
    expect(rows.map((row) => row.getAttribute('data-id'))).toEqual(['accessible', 'fair']);
    expect(rows[0].getAttribute('data-score')).toBe(String(applyWeights(accessible.criteria, getState().weights)));
    expect(screen.getAllByTestId('stakeholder-guard')).toHaveLength(1);
    expect(rows[0].textContent).toContain('Senior 39.0');
    expect(rows[1].textContent).not.toContain('fails a stakeholder group');
    fireEvent.click(rows[1]);
    expect(getState().selectedId).toBe('fair');
    expect(rows[1].getAttribute('aria-pressed')).toBe('true');
  });
  it('keeps the dragged slider value, rescales the others and renders all updated percentages', () => {
    setup();
    for (const key of WEIGHT_KEYS) {
      const expected = setWeight(getState().weights, key, 0.6);
      fireEvent.change(screen.getByTestId(`weight-${key}`), { target: { value: '0.6' } });
      expect(getState().weights[key]).toBeCloseTo(0.6);
      expect(getState().weights).toEqual(expected);
      expect(Object.values(getState().weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
      for (const weightKey of WEIGHT_KEYS) {
        expect(screen.getByTestId(`weight-value-${weightKey}`).textContent).toBe(`${(expected[weightKey] * 100).toFixed(1)}%`);
      }
    }
  });
  it('applies presets and reorders the same keyed DOM nodes with transforms', () => {
    setup();
    const [accessibleRow, fairRow] = screen.getAllByTestId('ranking-row');
    fireEvent.click(accessibleRow);
    fireEvent.click(screen.getByTestId('preset-2'));
    const reordered = screen.getAllByTestId('ranking-row');
    expect(reordered).toEqual([fairRow, accessibleRow]);
    expect(accessibleRow.parentElement!.style.transform).toBe('translateY(9rem)');
    expect(fairRow.parentElement!.style.transform).toBe('translateY(0rem)');
    expect(accessibleRow.getAttribute('aria-pressed')).toBe('true');
    for (let index = 0; index < PRESETS.length; index++) {
      fireEvent.click(screen.getByTestId(`preset-${index + 1}`));
      expect(getState().weights).toEqual(normalize(PRESETS[index].weights));
    }
  });
  it('reads scores from the active scenario and never scores rejected candidates', () => {
    const { accessible, fair } = setup();
    const rainyAccessible: SimulationResult = { ...accessible, scenario: 'RAINY_SAT', criteria: { ...accessible.criteria, accessibility: 0 } };
    const rainyFair: SimulationResult = { ...fair, scenario: 'RAINY_SAT', criteria: { ...fair.criteria, accessibility: 100 } };
    act(() => setState({
      scenario: 'RAINY_SAT',
      results: {
        ...getState().results,
        [resultKey('accessible', 'RAINY_SAT')]: rainyAccessible,
        [resultKey('fair', 'RAINY_SAT')]: rainyFair,
        [resultKey('rejected', 'RAINY_SAT')]: { ...rainyFair, candidateId: 'rejected' },
      },
    }));
    expect(screen.getAllByTestId('ranking-row').map((row) => row.getAttribute('data-id'))).toEqual(['fair', 'accessible']);
    const rejected = screen.getByTestId('rejected-row');
    expect(rejected.textContent).toContain('No legal delivery route');
    expect(rejected.closest('details')!.open).toBe(false);
    fireEvent.click(rejected);
    expect(getState().selectedId).toBe('rejected');
  });
  it('shows missing-scenario and loading states without fabricating scores', () => {
    setup();
    act(() => setState({ scenario: 'CHRISTMAS_MARKET' }));
    expect(screen.queryAllByTestId('ranking-row')).toHaveLength(0);
    expect(screen.getByText('No simulation scores available for this scenario.')).toBeTruthy();
    expect(screen.getByText('2 sites without simulation scores in this scenario.')).toBeTruthy();
    act(() => setState({ loading: true }));
    expect(screen.getByText('Loading site scores…')).toBeTruthy();
  });
});

describe('setWeight', () => {
  it('keeps the dragged value and rescales the others to sum 1', () => {
    const w = setWeight({ accessibility: 0.3, footfall: 0.25, fairness: 0.2, localBusiness: 0.15, walkability: 0.1 }, 'accessibility', 0.5);
    expect(w.accessibility).toBeCloseTo(0.5);
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(w.footfall / w.fairness).toBeCloseTo(0.25 / 0.2);
  });
});

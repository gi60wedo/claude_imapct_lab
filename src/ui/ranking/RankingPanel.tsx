import { useMemo } from 'react';
import type { PersonaId, Weights } from '../../contracts';
import { currentResults, getState, setState, useStore } from '../state/store';
import { applyWeights, failsStakeholderGroup, normalize, PRESETS, rank, WEIGHT_KEYS, setWeight } from './applyWeights';

const LABELS: Record<keyof Weights, string> = {
  accessibility: 'Accessibility', footfall: 'Footfall', fairness: 'Fairness',
  localBusiness: 'Local business', walkability: 'Walkability',
};
const PERSONAS = [
  { id: 'senior', label: 'Senior', color: 'text-senior' },
  { id: 'vendor', label: 'Vendor', color: 'text-vendor' },
  { id: 'commuter', label: 'Commuter', color: 'text-commuter' },
  { id: 'retailer', label: 'Retailer', color: 'text-retailer' },
] as const satisfies readonly { id: PersonaId; label: string; color: string }[];
const ROW_HEIGHT_REM = 9;

export default function RankingPanel() {
  const candidates = useStore((s) => s.candidates);
  const results = useStore((s) => s.results);
  const scenario = useStore((s) => s.scenario);
  const weights = useStore((s) => s.weights);
  const selectedId = useStore((s) => s.selectedId);
  const loading = useStore((s) => s.loading);
  const accepted = new Map(candidates.filter((c) => c.passedFilter).map((c) => [c.id, c]));
  const activeResults = useMemo(() => currentResults(getState()), [results, scenario]);
  const ranked = rank(activeResults, weights)
    .filter((result) => accepted.has(result.candidateId));
  const rejected = candidates.filter((c) => !c.passedFilter);
  const pending = candidates.filter((c) => c.passedFilter && !ranked.some((r) => r.candidateId === c.id));

  function changeWeight(key: keyof Weights, value: number) {
    setState((s) => ({ weights: setWeight(s.weights, key, value) }));
  }

  return (
    <div className="border-b border-border p-4 text-foreground" data-testid="ranking-panel">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">MarketScore ranking</h2>
        <span className="text-xs text-muted">{ranked.length} scored sites</span>
      </div>
      <fieldset className="mb-4 space-y-3">
        <legend className="mb-2 text-xs text-muted">Adjust priorities</legend>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((preset, index) => (
            <button
              key={preset.name}
              type="button"
              data-testid={`preset-${index + 1}`}
              aria-pressed={WEIGHT_KEYS.every((key) => Math.abs(weights[key] - preset.weights[key]) < 1e-9)}
              onClick={() => setState({ weights: normalize(preset.weights) })}
              className="rounded border border-border bg-surface px-2 py-1 text-xs hover:border-commuter focus-visible:outline-2 focus-visible:outline-commuter aria-pressed:border-commuter"
            >
              {preset.name}
            </button>
          ))}
        </div>
        {WEIGHT_KEYS.map((key) => (
          <label key={key} className="block text-xs" htmlFor={`ranking-weight-${key}`}>
            <span className="flex justify-between gap-2">
              <span>{LABELS[key]}</span>
              <output htmlFor={`ranking-weight-${key}`} data-testid={`weight-value-${key}`} className="tabular-nums text-muted">
                {(weights[key] * 100).toFixed(1)}%
              </output>
            </span>
            <input
              id={`ranking-weight-${key}`}
              data-testid={`weight-${key}`}
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={weights[key]}
              onChange={(event) => changeWeight(key, Number(event.currentTarget.value))}
              className="mt-1 block w-full cursor-pointer accent-commuter focus-visible:outline-2 focus-visible:outline-commuter"
            />
          </label>
        ))}
      </fieldset>
      <p className="mb-2 text-xs text-muted">Footfall represents modeled exposure.</p>
      {ranked.length === 0 && (
        <p role="status" className="py-3 text-sm text-muted">
          {loading ? 'Loading site scores…' : 'No simulation scores available for this scenario.'}
        </p>
      )}
      <ol aria-label="Sites ranked by MarketScore" className="relative" style={{ height: `${ranked.length * ROW_HEIGHT_REM}rem` }}>
        {ranked.map((result, index) => {
          const candidate = accepted.get(result.candidateId)!;
          const score = applyWeights(result.criteria, weights);
          return (
            <li
              key={candidate.id}
              className="absolute inset-x-0 top-0 h-34 transition-transform duration-200 ease-out motion-reduce:transition-none"
              style={{ transform: `translateY(${index * ROW_HEIGHT_REM}rem)` }}
            >
              <button
                type="button"
                data-testid="ranking-row"
                data-id={candidate.id}
                data-score={score}
                aria-pressed={selectedId === candidate.id}
                onClick={() => setState({ selectedId: candidate.id })}
                className="h-full w-full rounded-lg border border-border bg-surface p-3 text-left hover:border-commuter focus-visible:outline-2 focus-visible:outline-commuter aria-pressed:border-commuter"
              >
                <span className="flex items-center gap-2 text-sm">
                  <span className="text-muted">{index + 1}.</span>
                  <span className="min-w-0 flex-1 truncate font-medium" title={candidate.name}>{candidate.name}</span>
                  <span className="tabular-nums font-semibold" data-testid="ranking-score">{score.toFixed(1)}</span>
                </span>
                <span role="meter" aria-label={`${candidate.name} MarketScore`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={score} className="my-2 block h-1.5 overflow-hidden rounded bg-background">
                  <span className="block h-full origin-left rounded bg-commuter transition-transform duration-200 motion-reduce:transition-none" style={{ transform: `scaleX(${Math.max(0, Math.min(1, score / 100))})` }} />
                </span>
                <span className="grid grid-cols-4 gap-1 text-[10px]">
                  {PERSONAS.map(({ id, label, color }) => (
                    <span key={id} className={color} title={result.personas[id].topFriction}>
                      {label} <span className="tabular-nums">{result.personas[id].score.toFixed(1)}</span>
                    </span>
                  ))}
                </span>
                <span className="mt-2 block min-h-4 text-xs text-vendor">
                  {failsStakeholderGroup(result) && <span data-testid="stakeholder-guard">fails a stakeholder group</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {pending.length > 0 && (
        <p role="status" className="mb-3 text-xs text-muted">
          {pending.length} sites {loading ? 'awaiting simulation' : 'without simulation scores'} in this scenario.
        </p>
      )}
      {rejected.length > 0 && (
        <details className="mt-2 rounded border border-border p-2 text-xs">
          <summary className="cursor-pointer text-muted">Rejected sites ({rejected.length})</summary>
          <ul className="mt-2 space-y-2">
            {rejected.map((candidate) => (
              <li key={candidate.id}>
                <button type="button" data-testid="rejected-row" data-id={candidate.id} aria-pressed={selectedId === candidate.id} onClick={() => setState({ selectedId: candidate.id })} className="w-full rounded p-1 text-left hover:bg-surface focus-visible:outline-2 focus-visible:outline-commuter aria-pressed:bg-surface">
                  <span className="block font-medium">{candidate.name}</span>
                  <span className="text-muted">{candidate.rejectReason ?? 'No rejection reason provided.'}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

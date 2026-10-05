import { useState } from 'react';
import type { Scenario, SimulationResult } from '../../contracts';
import Compare from '../compare/Compare';
import { sim } from '../adapters';
import { ScenarioUnavailableError } from '../adapters/types';
import { currentResults, getState, pickShortlist, resultKey, setState, useStore } from '../state/store';

const SCENARIOS: { id: Scenario; label: string }[] = [
  { id: 'SUNNY_SAT', label: 'Sunny' },
  { id: 'RAINY_SAT', label: 'Rainy' },
  { id: 'CHRISTMAS_MARKET', label: 'Christmas market' },
];

const OFFLINE_MSG = 'scenario not available offline';

export default function WhatIfBar() {
  const scenario = useStore((s) => s.scenario);
  const compareIds = useStore((s) => s.compareIds);
  const ready = useStore((s) => !s.loading && s.candidates.length > 0);
  const [running, setRunning] = useState<Scenario | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(next: Scenario) {
    if (running || !ready) return;
    setError(null);
    setRunning(next);
    try {
      const { candidates } = getState();
      const shortlist = pickShortlist(candidates);
      const settled = await Promise.allSettled(shortlist.map((c) => sim.run(c.id, next, [], 42)));
      const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) {
        setError(failed.reason instanceof ScenarioUnavailableError ? OFFLINE_MSG : 'simulation failed');
        return;
      }
      const fresh = settled.map((r) => (r as PromiseFulfilledResult<SimulationResult>).value);
      setState((s) => {
        const results = { ...s.results };
        for (const r of fresh) results[resultKey(r.candidateId, r.scenario)] = r;
        return { results, scenario: next };
      });
      if (getState().compareIds.length === 2) setState({ compareIds: topTwo() });
    } finally {
      setRunning(null);
    }
  }

  function toggleCompare() {
    setState(compareIds.length === 2 ? { compareIds: [] } : { compareIds: topTwo() });
  }

  const open = compareIds.length === 2;
  return (
    <div className="relative flex items-center gap-2">
      {SCENARIOS.map((s) => (
        <button
          key={s.id}
          type="button"
          disabled={running !== null || !ready}
          aria-pressed={scenario === s.id}
          onClick={() => choose(s.id)}
          className={`flex items-center gap-1 rounded border px-3 py-1 text-sm disabled:opacity-50 ${
            scenario === s.id ? 'border-foreground bg-surface' : 'border-border'
          }`}
        >
          {running === s.id && (
            <span role="status" aria-label="running" className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-transparent" />
          )}
          {s.label}
        </button>
      ))}
      {error && <span role="alert" className="text-sm text-vendor">{error}</span>}
      <button
        type="button"
        aria-pressed={open}
        onClick={toggleCompare}
        className={`ml-auto rounded border px-2 py-0.5 text-xs ${open ? 'border-foreground bg-surface' : 'border-border'}`}
      >
        Compare
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2">
          <Compare />
        </div>
      )}
    </div>
  );
}

/** Ids of the two candidates with the highest weighted criteria score in the active scenario. */
function topTwo(): string[] {
  const s = getState();
  const score = (r: SimulationResult) =>
    (Object.keys(s.weights) as (keyof typeof s.weights)[]).reduce((sum, k) => sum + s.weights[k] * r.criteria[k], 0);
  return Object.values(currentResults(s))
    .sort((a, b) => score(b) - score(a))
    .slice(0, 2)
    .map((r) => r.candidateId);
}

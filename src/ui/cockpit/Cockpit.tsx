import { useState } from 'react';
import type { PersonaId, SimulationResult, Weights } from '../../contracts';
import { LIVE_BRIEF, sim } from '../adapters';
import { applyLiveMitigation } from '../live/live';
import { currentResults, resultKey, setState, useStore } from '../state/store';

const PERSONAS: { id: PersonaId; label: string; text: string; border: string }[] = [
  { id: 'senior', label: 'Senior', text: 'text-senior', border: 'border-senior' },
  { id: 'vendor', label: 'Vendor', text: 'text-vendor', border: 'border-vendor' },
  { id: 'commuter', label: 'Commuter', text: 'text-commuter', border: 'border-commuter' },
  { id: 'retailer', label: 'Retailer', text: 'text-retailer', border: 'border-retailer' },
];

const WEIGHT_KEYS: (keyof Weights)[] = ['accessibility', 'footfall', 'fairness', 'localBusiness', 'walkability'];

function marketScore(r: SimulationResult, w: Weights): number {
  return WEIGHT_KEYS.reduce((sum, k) => sum + r.criteria[k] * w[k], 0);
}

const R = 42;
const CIRC = 2 * Math.PI * R;

function Dial({ score, min }: { score: number; min: number }) {
  const frac = Math.max(0, Math.min(1, score / 100));
  return (
    <div className="flex items-center gap-4" data-testid="dial">
      <svg viewBox="0 0 100 100" className="h-28 w-28 -rotate-90" role="img" aria-label="Consensus dial">
        <circle cx="50" cy="50" r={R} fill="none" strokeWidth="8" className="stroke-border" />
        <circle
          cx="50" cy="50" r={R} fill="none" strokeWidth="8" strokeLinecap="round"
          className="stroke-foreground"
          strokeDasharray={CIRC} strokeDashoffset={CIRC * (1 - frac)}
        />
        <text
          x="50" y="50" textAnchor="middle" dominantBaseline="central"
          className="rotate-90 origin-center fill-foreground text-[22px] font-semibold"
          data-testid="market-score"
        >
          {score.toFixed(1)}
        </text>
      </svg>
      <div className="text-xs text-muted">
        <div className="uppercase tracking-wide">MarketScore</div>
        <div className="mt-1">
          Min persona score: <span className="text-foreground" data-testid="min-score">{min.toFixed(1)}</span>
        </div>
      </div>
    </div>
  );
}

export default function Cockpit() {
  const selectedId = useStore((s) => s.selectedId);
  const scenario = useStore((s) => s.scenario);
  const weights = useStore((s) => s.weights);
  const brief = useStore((s) => s.brief);
  const meta = useStore((s) => s.briefMeta);
  const result = useStore((s) => (s.selectedId ? currentResults(s)[s.selectedId] : undefined));
  const name = useStore((s) => s.candidates.find((c) => c.id === s.selectedId)?.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!selectedId || !result) {
    return <div className="p-3 text-sm text-muted">Select a candidate to open the cockpit.</div>;
  }

  const scores = PERSONAS.map((p) => result.personas[p.id].score);
  const min = Math.min(...scores);
  const total = marketScore(result, weights);

  const apply = async () => {
    if (!brief || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (LIVE_BRIEF) { await applyLiveMitigation(selectedId); return; }
      const next = await sim.run(selectedId, scenario, brief.losers.map((l) => l.mitigation), result.seed);
      setState((s) => ({ results: { ...s.results, [resultKey(next.candidateId, next.scenario)]: next } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const exportBrief = () => {
    if (!brief) return;
    const url = URL.createObjectURL(new Blob([brief.councilBriefMd], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'council-brief.md';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-3 p-3 text-sm" data-testid="cockpit">
      <h2 className="text-base font-semibold" data-testid="cockpit-title">{name ?? selectedId}</h2>
      <Dial score={total} min={min} />

      <div className="grid grid-cols-2 gap-2">
        {PERSONAS.map((p) => {
          const r = result.personas[p.id];
          return (
            <div key={p.id} className={`rounded border bg-surface p-2 ${p.border}`} data-testid={`persona-${p.id}`}>
              <div className="flex items-baseline justify-between">
                <span className={`font-medium ${p.text}`}>{p.label}</span>
                <span className="text-lg font-semibold" data-testid={`score-${p.id}`}>{r.score}</span>
              </div>
              <div className="text-xs text-muted">
                served {r.served} · dropped out {r.droppedOut}
              </div>
              <span className={`mt-1 inline-block rounded-full border px-2 py-0.5 text-[11px] ${p.border} ${p.text}`}>
                {r.topFriction}
              </span>
              <p className="mt-1 text-xs italic">{r.verdict ?? 'verdict pending'}</p>
            </div>
          );
        })}
      </div>

      {result.mitigations.length > 0 && (
        <div className="text-xs text-muted" data-testid="applied">
          Applied mitigations ({result.mitigations.length}): {result.mitigations.join('; ')}
        </div>
      )}

      {brief && (
        <section className="rounded border border-border bg-surface p-2" data-testid="brief">
          <div className="font-medium">Recommended: {brief.recommended}</div>
          {meta && (
            <div className="text-[11px] text-muted" data-testid="brief-source">
              {meta.source === 'claude' ? `Claude · ${(meta.ms / 1000).toFixed(1)} s` : meta.source === 'template' ? 'offline summary from engine numbers' : 'cached brief'}
            </div>
          )}
          {meta?.delta && <p className="mt-1 text-xs italic" data-testid="brief-delta">{meta.delta}</p>}
          {meta?.mitigation && (
            <p className="mt-1 text-xs" data-testid="mitigation-note">
              <b>{meta.mitigation.id}</b>: {meta.mitigation.rationale}
            </p>
          )}
          <ul className="mt-1 list-disc pl-4 text-xs">
            {brief.why.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
          <div className="mt-2 text-xs font-medium text-muted">Comparisons</div>
          <ul className="text-xs">
            {brief.comparisons.map((c, i) => (
              <li key={i}><b>{c.site}</b>: better at {c.betterAt}; worse at {c.worseAt}</li>
            ))}
          </ul>
          <div className="mt-2 text-xs font-medium text-muted">Losers</div>
          <ul className="text-xs">
            {brief.losers.map((l, i) => (
              <li key={i}><b>{l.persona}</b>: {l.mitigation}</li>
            ))}
          </ul>
        </section>
      )}

      {error && <div className="text-xs text-vendor" role="alert">{error}</div>}

      <div className="flex gap-2">
        <button
          type="button" onClick={apply} disabled={!brief || busy}
          className="flex-1 rounded bg-commuter px-3 py-1.5 font-medium text-foreground disabled:opacity-50"
        >
          {busy ? 'Applying…' : 'Apply Claude mitigation'}
        </button>
        <button
          type="button" onClick={exportBrief} disabled={!brief}
          className="flex-1 rounded border border-border bg-surface px-3 py-1.5 font-medium disabled:opacity-50"
        >
          Export council brief
        </button>
      </div>
    </div>
  );
}

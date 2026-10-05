// Live clock bar: the market-day clock, play/pause, speed presets, loop, the slice buttons, a
// scenario switch and per-persona counters. Every count comes from the live result and the clock.
import { useMemo, useState } from 'react';
import type { Scenario, SimulationResult, TimeSlice } from '../../contracts';
import { PERSONAS, SLICE_IDS, sliceParts } from '../dash/model';
import { B, Card, Label } from '../dash/ui';
import { formatClockSec, liveCounts, sliceStart, SPEEDS, tripSpans } from './clock';
import { SCENARIOS, switchScenario } from './scenario';
import type { LiveSim } from './useLiveSim';

const btn = 'rounded-lg border px-3 py-1.5 text-sm font-semibold transition';
const on = 'border-cyan-400/70 bg-cyan-400/15 text-foreground';
const off = 'border-border bg-background/60 text-muted hover:text-foreground';

function ScenarioSwitch({ scenario, disabled }: { scenario: Scenario; disabled: boolean }) {
  const [busy, setBusy] = useState<Scenario | null>(null);
  const [error, setError] = useState<string | null>(null);
  const choose = async (next: Scenario) => {
    if (busy) return;
    setBusy(next);
    setError(await switchScenario(next).finally(() => setBusy(null)));
  };
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="live-scenario">
      {SCENARIOS.map((s) => (
        <button key={s.id} type="button" data-testid={`scenario-${s.id}`} aria-pressed={scenario === s.id}
          disabled={disabled || busy !== null} onClick={() => choose(s.id)}
          className={`${btn} disabled:opacity-50 ${scenario === s.id ? on : off}`}>
          {busy === s.id ? '…' : s.label}
        </button>
      ))}
      {error && <span role="alert" className="text-sm text-vendor">{error}</span>}
    </div>
  );
}

export function LiveBar({ live, slice, scenario, ready, onSlice }: {
  live: LiveSim; slice: TimeSlice; scenario: Scenario; ready: boolean; onSlice: (s: TimeSlice) => void;
}) {
  const r: SimulationResult | null = live.result;
  const spans = useMemo(() => tripSpans(r), [r]);
  const { enRoute, arrived } = liveCounts(spans, live.timeSec);
  const sampled = useMemo(() => new Set(spans.map((s) => s.persona)), [spans]);

  return (
    <Card className="flex flex-col gap-2 p-3" testId="time-bar">
      <div className="flex flex-wrap items-center gap-3" data-testid="live-bar" data-runs={live.runs}
        data-running={live.running} data-blend={live.blend} data-live-scenario={r?.scenario ?? ''} data-live-candidate={r?.candidateId ?? ''}>
        <div className="w-32 shrink-0">
          <Label>Saturday schedule</Label>
          <div className="text-2xl text-cyan-300" data-testid="live-clock"><B k="timeSec">{formatClockSec(live.timeSec)}</B></div>
        </div>
        {SLICE_IDS.map((s) => {
          const { clock, phase } = sliceParts(s);
          const hot = r?.bySlice[s].bottlenecks.length;
          return (
            <button key={s} type="button" data-testid={`slice-${s}`} aria-pressed={s === slice}
              onClick={() => { onSlice(s); live.seek(sliceStart(s)); }}
              className={`min-w-28 rounded-lg border px-3 py-1.5 text-center text-sm font-semibold ${s === slice ? on : off}`}>
              <B k="slice">{clock}</B> {phase}
              {hot !== undefined && <div className="font-normal text-muted"><B k={`bySlice.${s}.bottlenecks.length`}>{hot}</B> bottlenecks</div>}
            </button>
          );
        })}
        <button type="button" data-testid="play" aria-pressed={live.playing} aria-label={live.playing ? 'Pause trips' : 'Play trips'}
          onClick={live.toggle}
          className="rounded-lg border border-cyan-400/50 bg-cyan-400/10 px-4 py-2 text-sm font-semibold text-cyan-300 hover:bg-cyan-400/20">
          {live.playing ? '❚❚ Pause' : '▶ Play'}
        </button>
        <div className="flex items-center gap-1" role="group" aria-label="Speed">
          {SPEEDS.map((s, i) => (
            <button key={s} type="button" data-testid={`speed-${s}`} aria-pressed={live.speed === s} onClick={() => live.setSpeed(s)}
              className={`${btn} px-2 ${live.speed === s ? on : off}`}>
              <B k={`SPEEDS[${i}]`}>{s}</B>×
            </button>
          ))}
          <button type="button" data-testid="loop" aria-pressed={live.loop} onClick={() => live.setLoop(!live.loop)}
            className={`${btn} px-2 ${live.loop ? on : off}`}>
            ⟳ Loop
          </button>
        </div>
        <div className="ml-auto text-right text-sm text-cyan-300">
          {live.running ? <span data-testid="live-running">Re-running engine…</span>
            : live.error ? <span role="alert" className="text-vendor">{live.error}</span>
            : <><B k="result.trips.length">{r?.trips.length}</B> sampled agents</>}
          <div className="text-muted"><B k="result.stallExposure.length">{r?.stallExposure.length}</B> stalls live</div>
        </div>
      </div>
      <div className="flex items-stretch gap-2" data-testid="live-counters">
        {PERSONAS.map((p) => {
          const res = r?.personas[p.id];
          return (
            <div key={p.id} className={`min-w-0 flex-1 rounded-lg border-l-2 ${p.border} bg-background/60 px-3 py-1.5 text-sm`} data-testid={`live-${p.id}`}>
              <div className={`font-semibold uppercase tracking-wider ${p.text}`}>{p.label}</div>
              {sampled.has(p.id) ? (
                <div>
                  en route <B k={`liveCounts(result.trips, timeSec).enRoute.${p.id}`} className="text-foreground">{enRoute[p.id]}</B>
                  {' '}· arrived <B k={`liveCounts(result.trips, timeSec).arrived.${p.id}`} className="text-foreground">{arrived[p.id]}</B>
                </div>
              ) : <div className="text-muted">no sampled trips</div>}
              <div className="text-muted">
                served <B k={`result.personas.${p.id}.served`}>{res?.served}</B>
                {' '}· dropped <B k={`result.personas.${p.id}.droppedOut`}>{res?.droppedOut}</B>
              </div>
            </div>
          );
        })}
        <div className="flex flex-col justify-center gap-1">
          <Label>What-if</Label>
          <ScenarioSwitch scenario={scenario} disabled={!ready} />
        </div>
      </div>
    </Card>
  );
}

// Live clock bar, one slim row: the market-day clock, play/pause, speed presets, loop, the slice
// buttons and the scenario switch. Every count comes from the live result and the clock.
import { useState } from 'react';
import type { Scenario, SimulationResult, TimeSlice } from '../../contracts';
import { SLICE_IDS, sliceParts } from '../dash/model';
import { B, Card } from '../dash/ui';
import { formatClockSec, sliceStart, SPEEDS } from './clock';
import { SCENARIOS, switchScenario } from './scenario';
import type { LiveSim } from './useLiveSim';

const btn = 'rounded-xl border px-2.5 py-0.5 text-sm font-semibold transition';
const on = 'border-cyan-300/50 bg-cyan-300/10 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]';
const off = 'border-transparent text-zinc-300 hover:text-white';

function Divider() {
  return <span className="h-5 w-px bg-white/10" aria-hidden="true" />;
}

function ScenarioSwitch({ scenario, disabled }: { scenario: Scenario; disabled: boolean }) {
  const [busy, setBusy] = useState<Scenario | null>(null);
  const [error, setError] = useState<string | null>(null);
  const choose = async (next: Scenario) => {
    if (busy) return;
    setBusy(next);
    setError(await switchScenario(next).finally(() => setBusy(null)));
  };
  return (
    <div className="flex items-center gap-0.5" data-testid="live-scenario" role="group" aria-label="Scenario">
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
  return (
    <Card className="px-2 py-1" testId="time-bar">
      <div className="flex flex-wrap items-center gap-2" data-testid="live-bar" data-runs={live.runs}
        data-running={live.running} data-blend={live.blend} data-live-scenario={r?.scenario ?? ''} data-live-candidate={r?.candidateId ?? ''}>
        <div className="w-[5.5rem] shrink-0 text-base text-cyan-300" data-testid="live-clock" title="Saturday schedule">
          <B k="timeSec">{formatClockSec(live.timeSec)}</B>
        </div>
        <button type="button" data-testid="play" aria-pressed={live.playing} aria-label={live.playing ? 'Pause trips' : 'Play trips'}
          onClick={live.toggle}
          className="rounded-md border border-cyan-400/50 bg-cyan-400/10 px-2.5 py-0.5 text-sm font-semibold text-cyan-300 hover:bg-cyan-400/20">
          {live.playing ? '❚❚ Pause' : '▶ Play'}
        </button>
        <div className="flex items-center gap-0.5" role="group" aria-label="Speed">
          {SPEEDS.map((s, i) => (
            <button key={s} type="button" data-testid={`speed-${s}`} aria-pressed={live.speed === s} onClick={() => live.setSpeed(s)}
              className={`${btn} ${live.speed === s ? on : off}`}>
              <B k={`SPEEDS[${i}]`}>{s}</B>×
            </button>
          ))}
          <button type="button" data-testid="loop" aria-pressed={live.loop} onClick={() => live.setLoop(!live.loop)}
            className={`${btn} ${live.loop ? on : off}`}>
            ⟳ Loop
          </button>
        </div>
        <Divider />
        <div className="flex items-center gap-0.5" role="group" aria-label="Time slice">
          {SLICE_IDS.map((s) => {
            const { clock, phase } = sliceParts(s);
            const hot = r?.bySlice[s].bottlenecks.length;
            return (
              <button key={s} type="button" data-testid={`slice-${s}`} aria-pressed={s === slice}
                onClick={() => { onSlice(s); live.seek(sliceStart(s)); }}
                className={`${btn} ${s === slice ? on : off}`}>
                <B k="slice">{clock}</B> {phase}
                {hot !== undefined && hot > 0 && (
                  <span className="ml-1 font-normal text-zinc-500" title="bottlenecks in this slice">
                    ⚠<B k={`bySlice.${s}.bottlenecks.length`}>{hot}</B>
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <Divider />
        <ScenarioSwitch scenario={scenario} disabled={!ready} />
        <div className="ml-auto text-right text-sm text-zinc-400">
          {live.running ? <span data-testid="live-running">Re-running engine…</span>
            : live.error ? <span role="alert" className="text-vendor">{live.error}</span>
            : <><B k="result.trips.length">{r?.trips.length}</B> sampled agents · <B k="result.stallExposure.length">{r?.stallExposure.length}</B> stalls live</>}
        </div>
      </div>
    </Card>
  );
}

// The live run behind the ?view=three dashboard: one engine result for the selected candidate,
// scenario and mitigations, a sim clock over the market day, and a cross-fade between results.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Scenario, SimulationResult } from '../../contracts';
import { sim } from '../adapters';
import { getState, setState, useStore } from '../state/store';
import {
  advanceClock, blendTrips, CLOCK_END, CLOCK_START, DEFAULT_SPEED, LIVE_MAX_TRIPS, onClock, quantiseBlend,
  sliceAt, sliceStart, stepSpeed, type Speed,
} from './clock';

/** Wall seconds the view takes to fade from the previous result's agents to the new ones. */
export const FADE_SEC = 0.8;

export interface LiveSimInput {
  candidateId: string | null;
  scenario: Scenario;
  mitigations: string[];
  seed: number;
  /** Start playing when the first result arrives (default true). */
  autoplay?: boolean;
}

export interface LiveSim {
  /** Latest result, trips on the clock. Counters and events read this one. */
  result: SimulationResult | null;
  /** What the city draws: `result`, with the previous result's trips mixed in while fading. */
  view: SimulationResult | null;
  /** 0..1 fade from the previous result to `result`; 1 when settled. */
  blend: number;
  /** A run is in flight; the old agents keep moving meanwhile. */
  running: boolean;
  /** Completed runs since mount. */
  runs: number;
  error: string | null;
  timeSec: number;
  playing: boolean;
  speed: Speed;
  loop: boolean;
  toggle(): void;
  setSpeed(s: Speed): void;
  faster(): void;
  slower(): void;
  setLoop(on: boolean): void;
  seek(t: number): void;
}

interface Pair { from: SimulationResult | null; to: SimulationResult | null }

export function useLiveSim({ candidateId, scenario, mitigations, seed, autoplay = true }: LiveSimInput): LiveSim {
  const timeSec = useStore((s) => s.timeSec);
  const playing = useStore((s) => s.playing);
  const [speed, setSpeed] = useState<Speed>(DEFAULT_SPEED);
  const [loop, setLoop] = useState(true);
  const [pair, setPair] = useState<Pair>({ from: null, to: null });
  const [blend, setBlend] = useState(1);
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const settings = useRef({ speed, loop });
  settings.current = { speed, loop };
  const autoStarted = useRef(false);

  // Open on the active slice so the first frame shows that slice's agents.
  useEffect(() => {
    const t = getState().timeSec;
    if (t < CLOCK_START || t > CLOCK_END) setState((s) => ({ timeSec: sliceStart(s.slice) }));
  }, []);

  // One run per candidate × scenario × mitigations × seed. A stale reply is dropped.
  const mitigationKey = mitigations.join('\u0001');
  const mitigationList = useRef(mitigations);
  mitigationList.current = mitigations;
  useEffect(() => {
    if (!candidateId) return;
    let stale = false;
    setRunning(true);
    setError(null);
    sim.run(candidateId, scenario, mitigationList.current, seed, { maxTrips: LIVE_MAX_TRIPS })
      .then((r) => {
        if (stale) return;
        const next = onClock(r);
        setPair((p) => ({ from: p.to, to: next }));
        setBlend(0);
        setRuns((n) => n + 1);
        if (autoplay && !autoStarted.current) {
          autoStarted.current = true;
          setState({ playing: true });
        }
      })
      .catch((e: unknown) => { if (!stale) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!stale) setRunning(false); });
    return () => { stale = true; };
  }, [candidateId, scenario, mitigationKey, seed, autoplay]);

  // Cross-fade on wall time from the first frame after the result lands, playing or paused.
  useEffect(() => {
    if (!pair.from) { setBlend(1); return; }
    let frame = 0;
    let start: number | undefined;
    const tick = (now: number) => {
      start ??= now;
      const b = Math.min(1, (now - start) / 1000 / FADE_SEC);
      setBlend(quantiseBlend(b));
      if (b < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [pair]);

  // The clock: requestAnimationFrame deltas times the speed preset. The active slice follows it.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let previous: number | undefined;
    const tick = (now: number) => {
      if (previous !== undefined) {
        const { speed: sp, loop: lp } = settings.current;
        const { t, ended } = advanceClock(getState().timeSec, (now - previous) / 1000, sp, lp);
        const slice = sliceAt(t);
        setState((s) => ({ timeSec: t, ...(ended && { playing: false }), ...(slice && slice !== s.slice && { slice }) }));
      }
      previous = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const view = useMemo(() => {
    const { from, to } = pair;
    if (!to || !from || blend >= 1) return to;
    return { ...to, trips: blendTrips(from.trips, to.trips, blend) };
  }, [pair, blend]);

  const toggle = useCallback(() => setState((s) => {
    // Play from the end of a non-looping day restarts it.
    const restart = !s.playing && s.timeSec >= CLOCK_END;
    return { playing: !s.playing, ...(restart && { timeSec: CLOCK_START }) };
  }), []);
  const seek = useCallback((t: number) => {
    const clamped = Math.min(CLOCK_END, Math.max(CLOCK_START, t));
    const slice = sliceAt(clamped);
    setState((s) => ({ timeSec: clamped, ...(slice && slice !== s.slice && { slice }) }));
  }, []);
  const faster = useCallback(() => setSpeed((s) => stepSpeed(s, 1)), []);
  const slower = useCallback(() => setSpeed((s) => stepSpeed(s, -1)), []);

  return {
    result: pair.to, view, blend, running, runs, error, timeSec, playing, speed, loop,
    toggle, setSpeed, faster, slower, setLoop, seek,
  };
}

import { useEffect } from 'react';
import type { TimeSlice } from '../../contracts';
import { sliceDurationSec } from '../map/simLayers';
import { getState, setState, useStore } from '../state/store';

const SLICES: { value: TimeSlice; label: string }[] = [
  { value: '05:30_DELIVERY', label: '05:30' },
  { value: '11:30_PEAK', label: '11:30' },
  { value: '15:00_LULL', label: '15:00' },
];
const SPEED = 60;

export default function TimeControls() {
  const slice = useStore((s) => s.slice);
  const playing = useStore((s) => s.playing);

  useEffect(() => {
    if (!playing) return;
    let frame: number;
    let previous: number | undefined;
    const tick = (now: number) => {
      if (!getState().playing) return;
      if (previous !== undefined) {
        const elapsed = (now - previous) / 1000;
        setState((s) => ({ timeSec: (s.timeSec + elapsed * SPEED) % sliceDurationSec(s.slice) }));
      }
      previous = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-surface/95 p-3 text-sm text-foreground shadow-lg" data-testid="time-controls">
      <fieldset className="flex gap-1">
        <legend className="sr-only">Time slice</legend>
        {SLICES.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            aria-pressed={slice === value}
            className={`rounded px-3 py-2 focus-visible:outline-2 focus-visible:outline-commuter ${slice === value ? 'bg-commuter text-foreground' : 'text-muted hover:bg-background'}`}
            onClick={() => setState({ slice: value, timeSec: 0 })}
          >
            {label}
          </button>
        ))}
      </fieldset>
      <button
        type="button"
        aria-label={playing ? 'Pause simulation' : 'Play simulation'}
        aria-pressed={playing}
        className="rounded border border-border px-3 py-2 hover:bg-background focus-visible:outline-2 focus-visible:outline-commuter"
        onClick={() => setState((s) => ({ playing: !s.playing }))}
      >
        {playing ? 'Pause' : 'Play'}
      </button>
    </div>
  );
}

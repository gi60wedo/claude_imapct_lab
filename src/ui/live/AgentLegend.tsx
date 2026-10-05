// Key for the agent dots: persona colours with en-route and arrived counts on the clock, and the
// Colour / White switch. The dots follow the same clock, one per trip in the live run.
import { useMemo } from 'react';
import type { SimulationResult } from '../../contracts';
import { PERSONAS } from '../dash/model';
import { Accent, B, Card } from '../dash/ui';
import { AGENT_WHITE, PERSONA_COLORS, type AgentColors } from '../three/style';
import { liveCounts, tripSpans } from './clock';

export function AgentLegend({ result, view, timeSec, colors, onColors }: {
  /** Latest live result: the counters read it on the real clock. */
  result: SimulationResult | null;
  /** What the city draws, one dot per trip; it differs from `result` only during a cross-fade. */
  view: SimulationResult | null;
  timeSec: number; colors: AgentColors; onColors: (colors: AgentColors) => void;
}) {
  const spans = useMemo(() => tripSpans(result), [result]);
  const { enRoute, arrived } = liveCounts(spans, timeSec);
  const sampled = useMemo(() => new Set(spans.map((s) => s.persona)), [spans]);
  return (
    <Card className="p-2" testId="agent-legend">
      <div className="mb-1 flex items-center justify-between gap-2">
        <Accent>Agents</Accent>
        <button type="button" data-testid="agent-colors" aria-pressed={colors === 'persona'}
          onClick={() => onColors(colors === 'persona' ? 'white' : 'persona')}
          className="rounded-md border border-white/20 px-2 py-px text-[11px] font-semibold text-zinc-200 hover:border-white/50">
          Agents: {colors === 'persona' ? 'Colour' : 'White'}
        </button>
      </div>
      <ul className="flex flex-col gap-0.5 text-[11px]" data-testid="live-counters">
        {PERSONAS.map((p) => (
          <li key={p.id} className="flex items-center gap-1.5" data-testid={`live-${p.id}`}>
            <span className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ background: colors === 'persona' ? PERSONA_COLORS[p.id] : AGENT_WHITE }} />
            <span className={`w-16 shrink-0 font-semibold ${p.text}`}>{p.label}</span>
            {sampled.has(p.id) ? (
              <span className="truncate text-zinc-400">
                en route <B k={`liveCounts(result.trips, timeSec).enRoute.${p.id}`} className="text-zinc-100">{enRoute[p.id]}</B>
                {' '}· arrived <B k={`liveCounts(result.trips, timeSec).arrived.${p.id}`} className="text-zinc-100">{arrived[p.id]}</B>
              </span>
            ) : <span className="text-zinc-500">no sampled trips</span>}
          </li>
        ))}
      </ul>
      {view && view.trips.length > 0 && (
        <div className="mt-1 text-[10px] leading-snug text-zinc-500">
          One dot per agent on its way · <B k="view.trips.length">{view.trips.length}</B> trips in the run
        </div>
      )}
    </Card>
  );
}

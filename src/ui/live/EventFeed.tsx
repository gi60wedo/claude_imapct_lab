// Corner ticker of engine events the clock has passed, newest first, at most three rows.
import { useMemo } from 'react';
import type { SimulationResult } from '../../contracts';
import { Accent, B, Card } from '../dash/ui';
import { deriveEvents, EVENT_LABEL, passedEvents, type LiveEventKind } from './events';

/** Rows the corner feed shows. */
export const FEED_ROWS = 3;

const TONE: Record<LiveEventKind, string> = {
  van_blocked: 'border-vendor text-vendor',
  crowding: 'border-cyan-400 text-cyan-300',
  elevator: 'border-senior text-senior',
};

export function EventFeed({ result, timeSec }: { result: SimulationResult | null; timeSec: number }) {
  const events = useMemo(() => deriveEvents(result), [result]);
  const shown = passedEvents(events, timeSec, FEED_ROWS);
  return (
    <Card className="p-2" testId="event-feed">
      <Accent className="mb-1">Live events</Accent>
      {shown.length === 0 ? (
        <div className="text-[11px] text-zinc-500" data-testid="event-empty">No engine events before this time yet.</div>
      ) : (
        <ol className="flex flex-col gap-0.5">
          {shown.map((e) => (
            <li key={e.id} data-testid="event" data-kind={e.kind} title={e.bottleneck.cause}
              className={`truncate border-l-2 pl-1.5 text-[11px] ${TONE[e.kind]}`}>
              <B k="bottleneck.time">{e.bottleneck.time}</B>{' '}
              <span className="font-semibold">{EVENT_LABEL[e.kind]}</span>
              {e.kind !== 'van_blocked' && <> · <B k="bottleneck.severity">{Math.round(e.bottleneck.severity * 100)}</B>%</>}
              <span className="text-zinc-400"> · <B k="bottleneck.cause" mono={false}>{e.bottleneck.cause}</B></span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

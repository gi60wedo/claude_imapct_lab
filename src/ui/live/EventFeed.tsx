// Ticker of engine events the clock has passed, newest first.
import { useMemo } from 'react';
import type { SimulationResult } from '../../contracts';
import { Accent, B, Card } from '../dash/ui';
import { deriveEvents, EVENT_LABEL, passedEvents, type LiveEventKind } from './events';

const TONE: Record<LiveEventKind, string> = {
  van_blocked: 'border-vendor text-vendor',
  crowding: 'border-cyan-400 text-cyan-300',
  elevator: 'border-senior text-senior',
};

export function EventFeed({ result, timeSec }: { result: SimulationResult | null; timeSec: number }) {
  const events = useMemo(() => deriveEvents(result), [result]);
  const shown = passedEvents(events, timeSec);
  return (
    <Card className="w-[380px] p-3" testId="event-feed">
      <Accent className="mb-2">Live events</Accent>
      {shown.length === 0 ? (
        <div className="text-sm text-muted" data-testid="event-empty">No engine events before this time yet.</div>
      ) : (
        <ol className="flex flex-col gap-1">
          {shown.map((e) => (
            <li key={e.id} data-testid="event" data-kind={e.kind} className={`border-l-2 pl-2 text-sm ${TONE[e.kind]}`}>
              <B k="bottleneck.time">{e.bottleneck.time}</B>{' '}
              <span className="font-semibold">{EVENT_LABEL[e.kind]}</span>
              {e.kind !== 'van_blocked' && <> · severity <B k="bottleneck.severity">{Math.round(e.bottleneck.severity * 100)}</B>%</>}
              <div className="text-muted"><B k="bottleneck.cause" mono={false}>{e.bottleneck.cause}</B></div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

// Ticker events derived from a SimulationResult. Each event carries the bottleneck fields it
// came from, so the feed binds its time, cause and severity to data instead of composing numbers.
import type { Bottleneck, SimulationResult, TimeSlice } from '../../contracts';
import { parseClock } from './clock';

export type LiveEventKind = 'van_blocked' | 'crowding' | 'elevator';

export interface LiveEvent {
  id: string;
  kind: LiveEventKind;
  /** Clock time the event fires, seconds since midnight, from Bottleneck.time. */
  tSec: number;
  slice: TimeSlice;
  bottleneck: Bottleneck;
}

const KIND: Partial<Record<Bottleneck['type'], LiveEventKind>> = {
  BOLLARD_BLOCKAGE: 'van_blocked',
  CROWDING: 'crowding',
  ELEVATOR_CONGESTION: 'elevator',
};

export const EVENT_LABEL: Record<LiveEventKind, string> = {
  van_blocked: 'Van stopped before the site',
  crowding: 'Crowding',
  elevator: 'Elevator congestion',
};

/**
 * Bollard blockages (a van trip ending before the site), crowding and elevator congestion from
 * every slice, in clock order. Bottlenecks repeated across slices count once; a time that does not
 * parse drops the bottleneck, since the ticker cannot place it.
 */
export function deriveEvents(result: SimulationResult | null): LiveEvent[] {
  if (!result) return [];
  const seen = new Set<string>();
  const out: LiveEvent[] = [];
  for (const [slice, { bottlenecks }] of Object.entries(result.bySlice) as [TimeSlice, SimulationResult['bySlice'][TimeSlice]][]) {
    for (const b of bottlenecks) {
      const kind = KIND[b.type];
      const tSec = parseClock(b.time);
      if (!kind || !Number.isFinite(tSec)) continue;
      const id = `${b.type}:${b.time}:${b.lng}:${b.lat}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, kind, tSec, slice, bottleneck: b });
    }
  }
  return out.sort((a, b) => a.tSec - b.tSec || a.id.localeCompare(b.id));
}

/** Events the clock has passed, newest first, at most `limit`. */
export function passedEvents(events: LiveEvent[], t: number, limit = 6): LiveEvent[] {
  const out: LiveEvent[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < limit; i--) if (events[i].tSec <= t) out.push(events[i]);
  return out;
}

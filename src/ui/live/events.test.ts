import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import type { Bottleneck, SimulationResult } from '../../contracts';
import { parseClock } from './clock';
import { deriveEvents, passedEvents } from './events';

const fixture = (name: string) =>
  JSON.parse(readFileSync(`${process.cwd()}/public/data/fixtures/${name}.json`, 'utf8')) as SimulationResult;

const b = (type: Bottleneck['type'], time: string, cause = 'cause'): Bottleneck =>
  ({ lat: 49.45, lng: 11.07, severity: 0.5, type, time, cause });

const withBottlenecks = (delivery: Bottleneck[], peak: Bottleneck[] = []): SimulationResult => {
  const r = fixture('result-LORENZKIRCHE-SUNNY_SAT');
  return {
    ...r,
    bySlice: {
      '05:30_DELIVERY': { heat: [], bottlenecks: delivery },
      '11:30_PEAK': { heat: [], bottlenecks: peak },
      '15:00_LULL': { heat: [], bottlenecks: [] },
    },
  };
};

test('bollard blockages, crowding and elevator congestion become events at their bottleneck time', () => {
  const bollard = b('BOLLARD_BLOCKAGE', '05:34', 'bollard on Karolinenstraße stops the 3.5 t van');
  const crowd = b('CROWDING', '11:42');
  const lift = b('ELEVATOR_CONGESTION', '06:10');
  const events = deriveEvents(withBottlenecks([bollard, lift, b('COBBLESTONE_FRICTION', '05:40')], [crowd]));
  expect(events.map((e) => e.kind)).toEqual(['van_blocked', 'elevator', 'crowding']);
  expect(events[0].tSec).toBe(parseClock('05:34'));
  expect(events[0].bottleneck).toBe(bollard);
  expect(events[0].slice).toBe('05:30_DELIVERY');
  expect(events[2].slice).toBe('11:30_PEAK');
});

test('a bottleneck listed in two slices counts once; an unparsable time is dropped', () => {
  const same = b('CROWDING', '11:00');
  expect(deriveEvents(withBottlenecks([same, b('CROWDING', '??')], [same]))).toHaveLength(1);
  expect(deriveEvents(null)).toEqual([]);
});

test('the feed shows only events the clock has passed, newest first', () => {
  const events = deriveEvents(withBottlenecks([b('BOLLARD_BLOCKAGE', '05:34'), b('ELEVATOR_CONGESTION', '06:10')], [b('CROWDING', '11:42')]));
  expect(passedEvents(events, parseClock('05:33'))).toEqual([]);
  expect(passedEvents(events, parseClock('05:34')).map((e) => e.kind)).toEqual(['van_blocked']);
  expect(passedEvents(events, parseClock('12:00')).map((e) => e.kind)).toEqual(['crowding', 'elevator', 'van_blocked']);
  expect(passedEvents(events, parseClock('12:00'), 2)).toHaveLength(2);
});

test('every fixture bollard blockage yields a van event bound to its own time', () => {
  const r = fixture('result-HAUPTMARKT-SUNNY_SAT');
  const bollards = Object.values(r.bySlice).flatMap((s) => s.bottlenecks).filter((x) => x.type === 'BOLLARD_BLOCKAGE');
  const vans = deriveEvents(r).filter((e) => e.kind === 'van_blocked');
  expect(vans.length).toBe(new Set(bollards.map((x) => `${x.time}:${x.lng}:${x.lat}`)).size);
  for (const e of vans) expect(e.tSec).toBe(parseClock(e.bottleneck.time));
});

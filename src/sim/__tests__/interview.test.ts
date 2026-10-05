import { describe, expect, it } from 'vitest';
import { runInterviews, templateAnswers } from '../interview';
import { prepareWorld } from '../prepare';
import { EAST, gridWorld, WEST } from './fixtures';

const pw = prepareWorld(gridWorld());

describe('interviews', () => {
  const ivs = runInterviews(pw, [EAST, WEST], 'SUNNY_SAT', 7, 2);

  it('draws one young commuter and one senior per pair, each visiting every site', () => {
    expect(ivs.map((iv) => iv.who)).toEqual(['young', 'senior', 'young', 'senior']);
    for (const iv of ivs) expect(iv.trips.map((t) => t.siteId)).toEqual(['east', 'west']);
  });

  it('marks out of 10 stay in range and the preferred site has the higher mark', () => {
    for (const iv of ivs) {
      for (const t of iv.trips) { expect(t.rating).toBeGreaterThanOrEqual(1); expect(t.rating).toBeLessThanOrEqual(10); }
      const best = Math.max(...iv.trips.map((t) => t.rating));
      expect(iv.trips.find((t) => t.siteId === iv.preferred)!.rating).toBe(best);
    }
  });

  it('is reproducible from the seed', () => {
    expect(JSON.stringify(runInterviews(pw, [EAST, WEST], 'SUNNY_SAT', 7, 2))).toEqual(JSON.stringify(ivs));
  });

  it('answers quote the trip numbers', () => {
    for (const iv of ivs) {
      const a = templateAnswers(iv);
      for (const t of iv.trips) expect(a.rating).toContain(`${t.rating} out of 10`);
    }
  });
});

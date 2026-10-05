import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ApproachesFile, Candidate, CandidatesFile, GraphFile, PreferenceFile } from '../contracts.ts';
import { DEFAULT_THRESHOLDS, quickScores, rankCandidates, rejectReasons, shortlist } from './index.ts';

function cand(id: string, over: Partial<Candidate> = {}, ind: Partial<Candidate['indicators']> = {},
              ev: Partial<NonNullable<Candidate['evidence']>> = {}): Candidate {
  return {
    id, name: id, kind: 'square', polygon: [[11.07, 49.45], [11.071, 49.45], [11.071, 49.451], [11.07, 49.45]],
    areaM2: 2000, passedFilter: false,
    indicators: { transitScore: 50, walkScore: 70, population800m: 10000, retailPoi400m: 100, attractions400m: 10,
                  deliveryAccess: true, vanDistM: 10, ...ind },
    evidence: { baseKind: 'square', osm: [], centroid: [11.07, 49.45], builtAreaM2: 0, outlineAreaM2: 2000,
                siteNode: 0, accessNodes: [0], nearestStop: { name: 'Lorenzkirche', walkM: 100 },
                stopsWithin300m: [], departures300m: 100, subwayDepartures300m: 0,
                walk: { cobbleShare: 0, stepShare: 0, meanGradePct: 1, crossings: 0, networkM: 1000 },
                seniorShare800m: 0.17, food400m: 5, ...ev },
    ...over,
  };
}

describe('rejectReasons', () => {
  it('passes a site that meets every threshold', () => {
    expect(rejectReasons(cand('ok'))).toEqual([]);
  });

  it('states each failing rule with the measured value', () => {
    const c = cand('bad', { areaM2: 420 }, { vanDistM: 140, deliveryAccess: false },
      { nearestStop: { name: 'Hallertor', walkM: 520 },
        blockedBy: { restriction: 'bollard (removable) (node 1)', street: 'Lorenzer Platz', at: [11.08, 49.45] } });
    expect(rejectReasons(c)).toEqual([
      'Too small: 420 m² open area (needs 800 m²)',
      'No transit stop within a 400 m walk (nearest: Hallertor, 520 m)',
      'Van can only stop 140 m away (max 80 m); bollard (removable) (node 1) on Lorenzer Platz',
    ]);
  });

  it('reports a missing legal van stop', () => {
    const c = cand('novan', {}, { vanDistM: -1, deliveryAccess: false },
      { blockedBy: { restriction: 'pedestrian zone', street: 'Burg', at: [11.07, 49.45] } });
    expect(rejectReasons(c)).toEqual(['No van access at 05:30: pedestrian zone on Burg']);
  });

  it('calls a building floor area what it is, and honours the manual deny list', () => {
    const c = cand('gf', { areaM2: 300 }, {}, { baseKind: 'ground_floor', manualExclusion: 'private courtyard' });
    expect(rejectReasons(c)).toEqual(['Excluded by hand: private courtyard', 'Too small: 300 m² floor area (needs 800 m²)']);
  });

  it('follows custom thresholds', () => {
    const c = cand('edge', { areaM2: 900 }, { vanDistM: 95 });
    expect(rejectReasons(c)).toHaveLength(1);
    expect(rejectReasons(c, { ...DEFAULT_THRESHOLDS, maxVanDistM: 100 })).toEqual([]);
  });
});

describe('rankCandidates', () => {
  const pool = [
    cand('b', {}, { transitScore: 90, population800m: 20000 }),
    cand('a', {}, { transitScore: 40 }),
    cand('small', { areaM2: 100 }),
    cand('bench', { kind: 'benchmark' }, { vanDistM: -1, deliveryAccess: false }),
  ];

  it('ranks passing sites by quick score and keeps rejected ones with reasons', () => {
    const r = rankCandidates(pool);
    expect(r.map(c => [c.id, c.quickRank])).toEqual([['b', 1], ['a', 2], ['bench', undefined], ['small', undefined]]);
    expect(r.find(c => c.id === 'small')!.rejectReason).toMatch(/^Too small/);
    expect(r.find(c => c.id === 'bench')!.passedFilter).toBe(false);
  });

  it('is pure and idempotent', () => {
    const before = JSON.stringify(pool);
    const once = rankCandidates(pool);
    expect(JSON.stringify(pool)).toBe(before);
    expect(rankCandidates(once)).toEqual(once);
  });

  it('reorders when the quick weights change', () => {
    const p = [cand('transit', {}, { transitScore: 100, retailPoi400m: 0 }), cand('retail', {}, { transitScore: 0, retailPoi400m: 500 })];
    const w = { transit: 0, population: 0, retail: 0, attractions: 0, walk: 0, area: 0 };
    expect(rankCandidates(p, { weights: { ...w, transit: 1 } })[0].id).toBe('transit');
    expect(rankCandidates(p, { weights: { ...w, retail: 1 } })[0].id).toBe('retail');
  });

  it('scores on a 0–100 scale', () => {
    const s = quickScores([cand('x'), cand('y', {}, { transitScore: 100, walkScore: 100, population800m: 1e6 })]);
    for (const v of s.values()) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(100); }
  });

  it('shortlists the top n discovered sites plus every benchmark, pass or fail', () => {
    const s = shortlist(rankCandidates(pool), 1);
    expect(s.map(c => c.id)).toEqual(['b', 'bench']);
  });

  it('with a focus, shortlists exactly the focus sites then the baseline, whatever their rank', () => {
    const s = shortlist(rankCandidates(pool), 3, { sites: ['bench', 'a'], baseline: 'small' });
    expect(s.map(c => c.id)).toEqual(['bench', 'a', 'small']);
    expect(() => shortlist(rankCandidates(pool), 3, { sites: ['nope'] })).toThrow(/nope/);
  });
});

describe('public/data/candidates.json (real Nuremberg data)', () => {
  const file: CandidatesFile = JSON.parse(readFileSync(new URL('../../public/data/candidates.json', import.meta.url), 'utf8'));
  const byId = new Map(file.candidates.map(c => [c.id, c]));

  it('contains the three organiser benchmarks', () => {
    for (const id of ['hauptmarkt', 'lorenzkirche', 'kaufhof']) expect(byId.get(id)?.kind).toBe('benchmark');
  });

  it('discovers a must-ship sized candidate set (~15–25 that pass)', () => {
    expect(file.candidates.filter(c => c.kind !== 'benchmark').length).toBeGreaterThanOrEqual(15);
  });

  it('gives every rejected site a reason and every passing site a rank', () => {
    for (const c of file.candidates) {
      if (c.passedFilter) expect(c.quickRank).toBeGreaterThan(0);
      else expect(c.rejectReason?.length).toBeGreaterThan(0);
    }
  });

  it('is exactly what src/rank produces from the indicators', () => {
    expect(rankCandidates(file.candidates)).toEqual(file.candidates);
  });

  it('backs every delivery verdict with a route or a blocker', () => {
    for (const c of file.candidates) {
      const ev = c.evidence!;
      // a stop on the arterial road where vans enter the study area has a one-point route
      if (c.indicators.vanDistM >= 0) {
        expect(ev.vanRoute!.length).toBeGreaterThanOrEqual(1);
        expect(ev.vanRoute!.at(-1)).toEqual(ev.loadingPoint);
      }
      if (!c.indicators.deliveryAccess) expect(ev.blockedBy).toBeTruthy();
    }
  });

  it('focuses on the two relocation options with Hauptmarkt as the baseline', () => {
    expect(file.meta.focus).toEqual({ sites: ['lorenzkirche', 'kaufhof'], baseline: 'hauptmarkt' });
    expect(file.meta.rank?.shortlist).toEqual(['lorenzkirche', 'kaufhof', 'hauptmarkt']);
  });

  it('has approach indicators for every candidate', () => {
    for (const c of file.candidates) {
      const ev = c.evidence!;
      expect(Object.keys(ev.stepFreeArrival!)).toEqual(['07:30', '11:30']);
      expect(ev.climbHomeM).toBeGreaterThanOrEqual(0);
      expect(ev.rainCover!.site).toBe(ev.baseKind === 'ground_floor' ? 'indoor' : 'open');
    }
  });

  it('uses the corrected former-Kaufhof footprint (OSM way 144721687, Königstraße 42-52)', () => {
    const k = byId.get('kaufhof')!;
    expect(k.evidence!.osm).toContain('way/144721687');
    const [lng, lat] = k.evidence!.centroid;
    expect(lat).toBeCloseTo(49.4498, 3);
    expect(lng).toBeCloseTo(11.0783, 3);
  });
});

describe('approaches, preference and graph overrides (real data)', () => {
  const read = <T,>(f: string): T => JSON.parse(readFileSync(new URL(`../../public/data/${f}`, import.meta.url), 'utf8'));
  const ap = read<ApproachesFile>('approaches.json');
  const pref = read<PreferenceFile>('preference.json');
  const graph = read<GraphFile>('graph.json');

  it('routes every focus site from stations and from all 8 resident directions', () => {
    expect(ap.sites.map(s => s.id)).toEqual(['lorenzkirche', 'kaufhof', 'hauptmarkt']);
    for (const s of ap.sites) {
      expect(s.origins.filter(o => o.type === 'transit').length).toBeGreaterThanOrEqual(1);
      expect(s.origins.filter(o => o.type === 'residents').map(o => o.sector))
        .toEqual(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']);
      for (const o of s.origins) expect(o.shortest.path.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('the Galeria lift is a sourced, time-limited edge that only helps once Galeria is open', () => {
    const lift = graph.edges.find(e => e.override === 'galeria-lift-lorenzkirche')!;
    expect(lift.openingHours).toBe('Mo-Sa 09:30-20:00');
    expect(lift.source).toMatch(/VAG/);
    const ev = read<CandidatesFile>('candidates.json').candidates.find(c => c.id === 'lorenzkirche')!.evidence!;
    expect(ev.stepFreeArrival!['07:30']!.station).not.toBe('Lorenzkirche');
    expect(ev.stepFreeArrival!['11:30']!.station).toBe('Lorenzkirche');
  });

  it('preference shares add up to all residents counted', () => {
    for (const mode of ['walk', 'senior'] as const) {
      const sum = Object.values(pref.summary[mode]).reduce((s, v) => s + v.residents, 0);
      expect(sum).toBe(pref.summary.residents);
    }
    expect(pref.cells.reduce((s, c) => s + c[2], 0)).toBe(pref.summary.residents);
  });
});

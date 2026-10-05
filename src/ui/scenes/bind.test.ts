import { describe, expect, it } from 'vitest';
import type { SimulationResult } from '../../contracts';
import {
  formatBinding,
  formatClock,
  parsePath,
  parseTemplate,
  resolve,
  resolveCaption,
  resolveDetailed,
  templateLiteralText,
  TemplateParseError,
  UNRESOLVED,
} from './bind';
import type { BindingScope } from './types';

const persona = (score: number, topFriction: string) => ({ score, served: 41, droppedOut: 7, topFriction });

function makeResult(over: Partial<SimulationResult> = {}): SimulationResult {
  return {
    candidateId: 'kaufhof', scenario: 'RAINY_SAT', seed: 42, mitigations: [],
    criteria: { accessibility: 61.5, footfall: 70, fairness: 55, localBusiness: 40, walkability: 66 },
    personas: {
      senior: persona(37.5, 'steps without elevator'),
      vendor: persona(22.49, 'bollard at Königstraße 05:34'),
      commuter: persona(-2.5, 'long walk'),
      retailer: persona(80, 'none'),
    },
    bySlice: {
      '05:30_DELIVERY': {
        heat: [],
        bottlenecks: [
          { lat: 49.45, lng: 11.07, severity: 0.4, type: 'CROWDING', time: '05:31', cause: 'crowd' },
          { lat: 49.451, lng: 11.078, severity: 0.9, type: 'BOLLARD_BLOCKAGE', time: '05:34', cause: 'bollard' },
        ],
      },
      '11:30_PEAK': { heat: [], bottlenecks: [] },
      '15:00_LULL': { heat: [], bottlenecks: [] },
    },
    stallExposure: [12, 30.25, 7],
    trips: [],
    ...over,
  };
}

function makeScope(): BindingScope {
  const before = makeResult();
  const after = makeResult({ personas: { ...before.personas, commuter: persona(64, 'kiosk queue') } });
  return {
    result: after,
    before,
    after,
    brief: null,
    derived: { active: { marketScore: 71.26, consensus: 0.5 }, before: { marketScore: 60, consensus: 0.4 }, after: null },
    scene: { simSec: 19800 + 4 * 60 + 59, seed: 42, scenario: 'RAINY_SAT', candidateId: 'kaufhof', dataSource: 'fixtures' },
    heroes: { markus: { hero: 'markus', tripIndex: 3 }, helga: null, lukas: null },
    assets: { arrivals: null, graphNodes: null },
  };
}

describe('parseTemplate', () => {
  it('splits literals, bindings, formats and escaped braces', () => {
    expect(parseTemplate('Markus: {personas.vendor.score} at {scene.simSec|clock} {{x}}')).toEqual([
      { kind: 'text', text: 'Markus: ' },
      { kind: 'binding', path: 'personas.vendor.score' },
      { kind: 'text', text: ' at ' },
      { kind: 'binding', path: 'scene.simSec', format: 'clock' },
      { kind: 'text', text: ' {x}' },
    ]);
  });

  it('rejects unclosed, stray, empty and unknown-format bindings', () => {
    for (const bad of ['a {b', 'a } b', 'a {} b', '{x|pct}']) {
      expect(() => parseTemplate(bad), bad).toThrow(TemplateParseError);
    }
  });

  it('extracts literal text for RZ-static', () => {
    expect(templateLiteralText('Served {personas.commuter.served} · dropped {personas.commuter.droppedOut|int}')).toBe(
      'Served  · dropped ',
    );
  });
});

describe('parsePath', () => {
  it('detects roots only when followed by a dot', () => {
    expect(parsePath('personas.vendor.score')?.root).toBe('result');
    expect(parsePath('before.personas.vendor.score')?.root).toBe('before');
    expect(parsePath('scene')?.root).toBe('result');
  });

  it('parses index, quoted and field-match selectors', () => {
    expect(parsePath("bySlice['05:30_DELIVERY'].bottlenecks[type=BOLLARD_BLOCKAGE].cause")?.steps).toEqual([
      { kind: 'key', key: 'bySlice' },
      { kind: 'key', key: '05:30_DELIVERY' },
      { kind: 'key', key: 'bottlenecks' },
      { kind: 'match', field: 'type', value: 'BOLLARD_BLOCKAGE' },
      { kind: 'key', key: 'cause' },
    ]);
    expect(parsePath('stallExposure[1]')?.steps[1]).toEqual({ kind: 'index', index: 1 });
  });

  it('returns null for malformed paths', () => {
    for (const bad of ['1abc', 'a..b', 'a[', 'a[]', "a['x]", 'a b', 'a[=x]']) expect(parsePath(bad), bad).toBeNull();
  });
});

describe('resolve', () => {
  const scope = makeScope();

  it('resolves unrooted paths against the active result', () => {
    expect(resolve(scope, 'personas.commuter.score')).toBe(64);
    expect(resolve(scope, 'result.personas.commuter.score')).toBe(64);
    expect(resolve(scope, 'before.personas.commuter.score')).toBe(-2.5);
  });

  it('resolves nested selectors', () => {
    expect(resolve(scope, "bySlice['05:30_DELIVERY'].bottlenecks[type=BOLLARD_BLOCKAGE].time")).toBe('05:34');
    expect(resolve(scope, "bySlice['05:30_DELIVERY'].bottlenecks[0].cause")).toBe('crowd');
    expect(resolve(scope, 'stallExposure[1]')).toBe(30.25);
    expect(resolve(scope, 'heroes.markus.tripIndex')).toBe(3);
    expect(resolve(scope, 'derived.active.marketScore')).toBe(71.26);
    expect(resolve(scope, 'scene.scenario')).toBe('RAINY_SAT');
  });

  it('reports why a path does not resolve', () => {
    expect(resolveDetailed(scope, 'personas.vendor.nope')).toEqual({ ok: false, reason: 'missing' });
    expect(resolveDetailed(scope, 'brief.recommended')).toEqual({ ok: false, reason: 'missing' });
    expect(resolveDetailed(scope, 'heroes.helga.tripIndex')).toEqual({ ok: false, reason: 'missing' });
    expect(resolveDetailed(scope, 'personas.vendor')).toEqual({ ok: false, reason: 'not-scalar' });
    expect(resolveDetailed(scope, 'stallExposure')).toEqual({ ok: false, reason: 'not-scalar' });
    expect(resolveDetailed(scope, "bySlice['11:30_PEAK'].bottlenecks[type=CROWDING].cause")).toEqual({
      ok: false, reason: 'no-match',
    });
    expect(resolveDetailed(scope, 'personas.vendor[type=x]')).toEqual({ ok: false, reason: 'no-match' });
    expect(resolveDetailed(scope, 'a..b')).toEqual({ ok: false, reason: 'parse' });
  });

  it('never resolves prototype members', () => {
    expect(resolve(scope, 'personas.constructor')).toBeUndefined();
    expect(resolve(scope, 'stallExposure.length')).toBeUndefined();
  });

  it('treats NaN as unresolved', () => {
    const s = { ...makeScope(), derived: { ...makeScope().derived, active: { marketScore: NaN, consensus: NaN } } };
    expect(resolveDetailed(s, 'derived.active.marketScore')).toEqual({ ok: false, reason: 'not-scalar' });
  });
});

describe('formatBinding', () => {
  it('rounds int half away from zero by default', () => {
    expect(formatBinding(22.49)).toBe('22');
    expect(formatBinding(37.5)).toBe('38');
    expect(formatBinding(-2.5)).toBe('-3');
    expect(formatBinding(-0.4)).toBe('0');
    expect(formatBinding(37.5, 'int')).toBe('38');
  });

  it('formats num1, clock and text', () => {
    expect(formatBinding(30.25, 'num1')).toBe('30.3');
    expect(formatBinding(-0.04, 'num1')).toBe('0.0');
    expect(formatBinding(19800 + 4 * 60 + 59, 'clock')).toBe('05:34');
    expect(formatBinding('05:34', 'clock')).toBe('05:34');
    expect(formatBinding(30.25, 'text')).toBe('30.25');
    expect(formatClock(86400 + 60)).toBe('00:01');
    expect(formatClock(-60)).toBe('23:59');
  });

  it('renders strings and booleans verbatim and unresolved values as a dash', () => {
    expect(formatBinding('bollard at Königstraße 05:34')).toBe('bollard at Königstraße 05:34');
    expect(formatBinding(true)).toBe('true');
    for (const v of [undefined, null, NaN, Infinity, {}, [1]]) expect(formatBinding(v)).toBe(UNRESOLVED);
  });
});

describe('resolveCaption', () => {
  const scope = makeScope();

  it('renders each binding as its own part with path and format', () => {
    const { caption, errors } = resolveCaption(
      { id: 'c1', slot: 'personaChip', persona: 'vendor', template: 'Markus: {before.personas.vendor.score} · {scene.simSec|clock}' },
      scope,
      0.5,
    );
    expect(errors).toEqual([]);
    expect(caption).toEqual({
      id: 'c1', slot: 'personaChip', persona: 'vendor', opacity: 0.5,
      parts: [
        { kind: 'text', text: 'Markus: ' },
        { kind: 'binding', text: '22', path: 'before.personas.vendor.score' },
        { kind: 'text', text: ' · ' },
        { kind: 'binding', text: '05:34', path: 'scene.simSec', format: 'clock' },
      ],
    });
  });

  it('renders a dash and records an error for each unresolved binding', () => {
    const { caption, errors } = resolveCaption(
      { id: 'c2', slot: 'footer', template: '{personas.vendor.nope} / {personas.vendor.served}' },
      scope,
      1,
    );
    expect(caption.parts.map((p) => p.text)).toEqual([UNRESOLVED, ' / ', '41']);
    expect(errors).toEqual([{ captionId: 'c2', path: 'personas.vendor.nope', reason: 'missing' }]);
  });

  it('turns a malformed template into one dash with a parse error', () => {
    const { caption, errors } = resolveCaption({ id: 'c3', slot: 'title', template: 'broken {x' }, scope, 1);
    expect(caption.parts).toEqual([{ kind: 'binding', text: UNRESOLVED, path: 'broken {x' }]);
    expect(errors[0].reason).toBe('parse');
  });
});

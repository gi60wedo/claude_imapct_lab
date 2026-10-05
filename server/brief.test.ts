// @vitest-environment node
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Candidate, SimulationResult } from '../src/contracts';
import { DEFAULT_WEIGHTS } from '../src/score/score';
import { computeDelta, explainDelta, generateBrief, generateVerdicts, proposeMitigation, recommendedId, templateBrief } from './brief';
import { allowedNumbers, buildPayload, type BriefRequest } from './briefInput';
import { BriefCache } from './cache';
import type { LlmClient, ToolCall } from './llm';
import { findInventedNumbers } from './numberCheck';

const fx = (f: string) => JSON.parse(readFileSync(join(__dirname, '..', 'public', 'data', 'fixtures', f), 'utf8'));
const candidates: Candidate[] = fx('candidates.json');
const ids = ['LORENZKIRCHE', 'KAUFHOF', 'HAUPTMARKT', 'KORNMARKT'];
const load = (scenario: string) => ids.map((id) => fx(`result-${id}-${scenario}.json`) as SimulationResult);
const req = (scenario: 'SUNNY_SAT' | 'RAINY_SAT' = 'SUNNY_SAT'): BriefRequest => ({ candidates, results: load(scenario), weights: DEFAULT_WEIGHTS, scenario });
const tmpCache = () => new BriefCache(join(mkdtempSync(join(tmpdir(), 'brief-')), 'briefs.json'));

/** Fake model that answers by tool name; records every call. */
function fakeLlm(answers: Record<string, (c: ToolCall, n: number) => unknown>): LlmClient & { calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  return { calls, async callTool(c) { calls.push(c); return answers[c.tool.name](c, calls.length); } };
}

describe('numberCheck', () => {
  it('passes engine numbers and ignores clock times', () => {
    expect(findInventedNumbers('Score 92 at 05:30, weight 30%.', [92, 30])).toEqual([]);
  });
  it('flags invented numbers', () => {
    expect(findInventedNumbers('Vendors drop by 28% and 45 stalls', [28])).toEqual([45]);
  });
});

describe('payload', () => {
  it('ranks by the active weights and carries only engine numbers', () => {
    const p = buildPayload(req());
    expect(p.ranking.map((s) => s.rank)).toEqual([1, 2, 3, 4]);
    expect(p.ranking[0].marketScore).toBeGreaterThanOrEqual(p.ranking[1].marketScore);
    expect(Object.values(p.weightsPct).reduce((a, b) => a + b, 0)).toBe(100);
    expect(p.rejected.length).toBe(candidates.filter((c) => !c.passedFilter).length);
  });
  it('recommends the best site that fails no stakeholder group', () => {
    const p = buildPayload(req());
    const pick = p.ranking.find((s) => s.id === recommendedId(p))!;
    if (p.ranking.some((s) => !s.failsStakeholderGroup)) expect(pick.failsStakeholderGroup).toBe(false);
  });
});

describe('templateBrief (offline)', () => {
  it('uses only engine numbers', () => {
    const p = buildPayload(req());
    const b = templateBrief(p);
    const text = [...b.why, ...b.comparisons.flatMap((c) => [c.betterAt, c.worseAt]), b.councilBriefMd].join('\n');
    expect(findInventedNumbers(text, allowedNumbers(p))).toEqual([]);
    expect(b.comparisons.length).toBeGreaterThanOrEqual(2);
  });
});

describe('generateBrief', () => {
  const good = (r: BriefRequest) => {
    const p = buildPayload(r);
    return {
      recommended: 'WRONG_ID', // engine overrides this
      why: [`${p.ranking[0].name} scores ${p.ranking[0].marketScore}.`],
      comparisons: p.ranking.slice(1, 3).map((s) => ({ site: s.name, betterAt: `rank ${s.rank}`, worseAt: `score ${s.marketScore}` })),
      losers: [{ persona: 'vendor', mitigation: 'Open a delivery window.' }],
      councilBriefMd: `# Brief\n${p.ranking[0].name}: ${p.ranking[0].marketScore}`,
    };
  };

  it('returns a validated brief, pins the engine pick, and caches it', async () => {
    const cache = tmpCache();
    const llm = fakeLlm({ write_recommendation: () => good(req()) });
    const r = await generateBrief(req(), { llm, cache });
    expect(r.source).toBe('claude');
    expect(r.brief.recommended).toBe(recommendedId(buildPayload(req())));
    expect(llm.calls[0].tool.schema).toMatchObject({ additionalProperties: false });
    expect(cache.get(buildPayload(req()))?.exact).toBe(true);
  });

  it('retries once when Claude invents a number, naming it', async () => {
    const llm = fakeLlm({
      write_recommendation: (c, n) => (n === 1 ? { ...good(req()), why: ['Footfall is up 777%.'] } : good(req())),
    });
    const r = await generateBrief(req(), { llm, cache: tmpCache() });
    expect(r.source).toBe('claude');
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1].user).toContain('777');
  });

  it('falls back to the cache, then to the template, when the model fails (network unplugged)', async () => {
    const cache = tmpCache();
    const down: LlmClient = { callTool: async () => { throw new Error('ENOTFOUND'); } };
    const cold = await generateBrief(req(), { llm: down, cache });
    expect(cold.source).toBe('template');
    expect(cold.warning).toContain('ENOTFOUND');
    await generateBrief(req(), { llm: fakeLlm({ write_recommendation: () => good(req()) }), cache });
    expect((await generateBrief(req(), { llm: down, cache })).source).toBe('cache');
    // different weights → not an exact hit, but the scenario's latest brief is still served
    const moved = { ...req(), weights: { ...DEFAULT_WEIGHTS, fairness: 0.9 } };
    expect((await generateBrief(moved, { cache })).source).toBe('cache-latest');
  });

  it('keeps cached briefs per scenario separate', async () => {
    const cache = tmpCache();
    await generateBrief(req('SUNNY_SAT'), { llm: fakeLlm({ write_recommendation: () => good(req()) }), cache });
    expect((await generateBrief(req('RAINY_SAT'), { cache })).source).toBe('template');
  });
});

describe('verdicts, mitigation, delta', () => {
  it('writes one verdict per persona and falls back per persona', async () => {
    const llm = fakeLlm({ write_verdict: (c) => { if (c.user.includes('Markus')) throw new Error('boom'); return { verdict: 'Fine for me.' }; } });
    const v = await generateVerdicts(req(), 'KAUFHOF', { llm });
    expect(llm.calls).toHaveLength(4);
    expect(v.senior).toEqual({ verdict: 'Fine for me.', source: 'claude' });
    expect(v.vendor.source).toBe('template');
  });

  it('turns a structured proposal into an engine mitigation id', async () => {
    const llm = fakeLlm({ propose_mitigation: () => ({ kind: 'KIOSKS', persona: 'commuter', count: 3, window: '', rationale: 'Shorter walk from the exit.' }) });
    const { mitigation, source } = await proposeMitigation(req(), 'KAUFHOF', { llm });
    expect(source).toBe('claude');
    expect(mitigation.id).toBe('Express kiosk (3) near the transit exit');
  });

  it('rejects malformed proposals and uses the deterministic one', async () => {
    const llm = fakeLlm({ propose_mitigation: () => ({ kind: 'DELIVERY_WINDOW', persona: 'vendor', count: 0, window: 'early', rationale: 'x' }) });
    const { source, mitigation } = await proposeMitigation(req(), 'LORENZKIRCHE', { llm });
    expect(source).toBe('template');
    expect(mitigation.id).toMatch(/^(Express kiosk|Delivery window \d\d:\d\d-\d\d:\d\d|Stall layout)/);
  });

  it('computes a delta between sunny and rainy runs and explains it offline', async () => {
    const d = computeDelta(buildPayload(req('SUNNY_SAT')), buildPayload(req('RAINY_SAT')));
    expect(d.personaChanges.length).toBeGreaterThan(0);
    const out = await explainDelta(req('SUNNY_SAT'), req('RAINY_SAT'));
    expect(out.source).toBe('template');
    expect(out.summary.length).toBeGreaterThan(0);
  });
});

// Dev-only: asks Claude for a plain-language recommendation per weather × fix × priority preset, from the
// twin's computed numbers only. Every number in the reply is checked against the input facts.
// D's server/brief.ts can reuse buildFacts() and the prompt; this file only feeds the offline viewer.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { PersonaId, Scenario, SimulationResult, Weights } from '../../contracts';
import type { Interview } from '../interview';
import { REPO } from './osmWorld';

export const BRIEF_MODEL = process.env.CLAUDE_MODEL ?? 'claude-sonnet-5-5';   // IMPLEMENTATION_PLAN.md header
const CACHE = resolve(REPO, 'sim-viz/.cache/briefs.json');
const PROMPT_VERSION = 3;

export const PRESETS: Record<string, number[]> = {   // §6, order: accessibility, footfall, fairness, localBusiness, walkability
  Balanced: [0.30, 0.25, 0.20, 0.15, 0.10],
  'Accessibility first': [0.45, 0.20, 0.15, 0.10, 0.10],
  'Trader fairness first': [0.20, 0.20, 0.40, 0.10, 0.10],
  'Local business first': [0.20, 0.25, 0.10, 0.35, 0.10],
};
const CRITERIA: (keyof Weights)[] = ['accessibility', 'footfall', 'fairness', 'localBusiness', 'walkability'];
const PERSONA_NAMES: Record<PersonaId, string> = {
  senior: 'Oma Helga (senior with rollator)', vendor: 'Markus (market vendor with a van)',
  commuter: 'Lukas (lunch-break commuter)', retailer: 'Frau Weber (owns a shop nearby)',
};

export interface Brief {
  headline: string; recommended: string; why: string[]; tradeoff: string; nextStep: string;
  model: string; verified: boolean; unverified: string[];
}

const r1 = (x: number) => Math.round(x * 10) / 10;
export const marketScore = (r: SimulationResult, w: number[]) => {
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  return CRITERIA.reduce((acc, k, i) => acc + (w[i] / sum) * r.criteria[k], 0);
};

/** The numbers Claude may use: one weather × fix × preset, all sites, plus each fix's effect. */
export function buildFacts(runs: Record<string, SimulationResult>, sites: { id: string; name: string }[], scenario: Scenario,
                           mit: string, preset: string, fixLabels: Record<string, string>,
                           roadNearby: Record<string, string[]> = {}) {
  const w = PRESETS[preset];
  const get = (site: string, m = mit) => runs[`${site}|${scenario}|${m}`];
  const rows = sites.map((s) => {
    const r = get(s.id);
    return {
      site: s.id, name: s.name, marketScore: r1(marketScore(r, w)),
      criteria: Object.fromEntries(CRITERIA.map((k) => [k, r1(r.criteria[k])])),
      stakeholders: Object.fromEntries((Object.keys(PERSONA_NAMES) as PersonaId[]).map((p) => [p, {
        who: PERSONA_NAMES[p], score: r1(r.personas[p].score), mainProblem: r.personas[p].topFriction,
      }])),
      failsStakeholderGuard: (Object.keys(PERSONA_NAMES) as PersonaId[]).filter((p) => r.personas[p].score < 40),
      roadConditionsNearby: roadNearby[s.id] ?? [],
    };
  }).sort((a, b) => b.marketScore - a.marketScore);
  const fixOptions = mit !== 'none' ? undefined : Object.fromEntries(sites.map((s) => [s.id,
    ['delivery', 'loop', 'kiosk'].map((m) => {
      const before = get(s.id, 'none'), after = get(s.id, m);
      const changes: Record<string, [number, number]> = {};
      for (const k of CRITERIA) if (Math.abs(after.criteria[k] - before.criteria[k]) >= 0.5) changes[k] = [r1(before.criteria[k]), r1(after.criteria[k])];
      for (const p of Object.keys(PERSONA_NAMES) as PersonaId[]) {
        if (Math.abs(after.personas[p].score - before.personas[p].score) >= 0.5) changes[p] = [r1(before.personas[p].score), r1(after.personas[p].score)];
      }
      return { fix: fixLabels[`${s.id}|${m}`], marketScoreBefore: r1(marketScore(before, w)), marketScoreAfter: r1(marketScore(after, w)), changes };
    })]));
  return {
    weather: scenario === 'RAINY_SAT' ? 'rainy Saturday' : scenario === 'SNOWY_SAT' ? 'snowy Saturday' : 'sunny Saturday',
    fixAppliedToAllSites: mit === 'none' ? 'none' : fixLabels[`${sites[0].id}|${mit}`],
    priorities: { preset, weightsPercent: Object.fromEntries(CRITERIA.map((k, i) => [k, Math.round((w[i] / w.reduce((a, b) => a + b, 0)) * 100)])) },
    scale: 'all scores are 0-100, higher is better; a stakeholder below 40 fails the guard',
    roadConditions: 'current roadworks from the city of Nuremberg and VAG (Oct 2026); they already slow or block routes in the scores',
    sitesRankedByMarketScore: rows,
    ...(fixOptions ? { fixOptions } : {}),
  };
}

const SYSTEM = `You advise Nuremberg's city council on where to move the weekly vegetable market.
You receive scores that a simulation computed from real city data. Write for a busy council member who will not read tables.

Rules:
- Use only numbers that appear in the data. Never estimate, round differently, or invent a number.
- Cite at least two numbers, and compare the recommended site with at least one alternative.
- Recommend the site that best fits the given priorities. If the top MarketScore site fails a stakeholder guard, say so plainly and weigh it.
- Name stakeholders by their first name (Oma Helga, Markus, Lukas, Frau Weber).
- headline: one sentence, at most 16 words. why: 2 or 3 short bullets. tradeoff: one sentence on who loses and why.
- nextStep: one concrete action. If fixOptions are given, pick the fix with the largest useful gain and quote its before and after numbers; otherwise say what the applied fix achieved.
- If roadConditionsNearby lists roadworks or a closed lift, mention the one that matters most and who it affects.
- Plain English, no jargon such as "MarketScore weighting" or "Gini".`;

const SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    recommended: { type: 'string', enum: ['lorenzkirche', 'kaufhof', 'hauptmarkt'] },
    why: { type: 'array', items: { type: 'string' } },
    tradeoff: { type: 'string' },
    nextStep: { type: 'string' },
  },
  required: ['headline', 'recommended', 'why', 'tradeoff', 'nextStep'],
  additionalProperties: false,
};

/** Every number in the texts must appear in the facts (±0.1 for rounding). Small counts like "2 of 3" are allowed. */
export function uncheckedNumbers(reply: Record<string, unknown>, facts: unknown): string[] {
  const allowed = [...JSON.stringify(facts).matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  const text = Object.values(reply).flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v) => typeof v === 'string').join(' ');
  const bad = new Set<string>();
  for (const m of text.matchAll(/\d+(?:\.\d+)?/g)) {
    const x = Number(m[0]);
    if (Number.isInteger(x) && x <= 10) continue;
    if (!allowed.some((a) => Math.abs(a - x) <= 0.1)) bad.add(m[0]);
  }
  return [...bad];
}

type Checked<T> = T & { model: string; verified: boolean; unverified: string[] };

async function askClaude<T extends Record<string, unknown>>(client: Anthropic, system: string, schema: object, intro: string, facts: unknown): Promise<Checked<T>> {
  const response = await client.beta.messages.create({
    model: BRIEF_MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: schema as Record<string, unknown> } },
    system,
    messages: [{ role: 'user', content: `${intro}
${JSON.stringify(facts, null, 1)}` }],
  });
  if (response.stop_reason === 'refusal') throw new Error(`refused: ${response.stop_details?.category ?? 'unknown'}`);
  if (response.stop_reason === 'max_tokens') throw new Error('reply cut off at max_tokens');
  const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  const parsed = JSON.parse(text) as T;
  const unverified = uncheckedNumbers(parsed, facts);
  return { ...parsed, model: response.model, verified: unverified.length === 0, unverified };
}

/** Ask Claude for each job, reusing cached replies. Without credentials, returns only what's cached. */
async function generateCached<T extends Record<string, unknown>>(label: string, system: string, schema: object, intro: string,
                                                                 jobs: { key: string; facts: unknown }[]): Promise<Record<string, Checked<T>>> {
  const cache: Record<string, Checked<T>> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
  const hash = (facts: unknown) => createHash('sha256').update(`${PROMPT_VERSION}|${BRIEF_MODEL}|${system}|${JSON.stringify(facts)}`).digest('hex').slice(0, 16);
  const out: Record<string, Checked<T>> = {};
  const todo = jobs.filter((j) => {
    const hit = cache[hash(j.facts)];
    if (hit) out[j.key] = hit;
    return !hit;
  });
  const hasCredentials = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (todo.length && !hasCredentials) {
    console.log(`${label}: ${Object.keys(out).length} cached, ${todo.length} not generated (set ANTHROPIC_API_KEY to ask Claude)`);
    return out;
  }
  if (todo.length) {
    const client = new Anthropic();
    let failed = 0;
    const queue = [...todo];
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let j = queue.shift(); j; j = queue.shift()) {
        try {
          const reply = await askClaude<T>(client, system, schema, intro, j.facts);
          cache[hash(j.facts)] = reply;
          out[j.key] = reply;
        } catch (e) {
          failed++;
          if (e instanceof Anthropic.AuthenticationError) { console.error(`${label}: invalid API key`); queue.length = 0; }
          else if (e instanceof Anthropic.RateLimitError) console.error(`${label}: rate limited on ${j.key}`);
          else if (e instanceof Anthropic.APIError) console.error(`${label}: API error ${e.status} on ${j.key}: ${e.message}`);
          else console.error(`${label}: ${j.key}: ${e instanceof Error ? e.message : e}`);
        }
      }
    }));
    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, JSON.stringify(cache));
    const flagged = Object.values(out).filter((b) => !b.verified).length;
    console.log(`${label}: ${todo.length - failed} generated by ${BRIEF_MODEL}, ${failed} failed, ${flagged} with unverified numbers`);
  }
  return out;
}

export function generateBriefs(jobs: { key: string; facts: unknown }[]): Promise<Record<string, Brief>> {
  return generateCached<Omit<Brief, 'model' | 'verified' | 'unverified'>>('briefs', SYSTEM, SCHEMA, 'Simulation results:', jobs);
}

// ── Interview voices ───────────────────────────────────────────────────────────

const VOICE_SYSTEM = `You voice a person who just travelled through Nuremberg's old town to two possible locations for the weekly vegetable market.
You get the facts of their two trips from a city simulation. Give their spoken feedback in first person, as one short statement (no questions, no interviewer).

Rules:
- Sound like this person: a young student talks casually; an elderly woman with a rollator talks warmly and a little slower, with short sentences.
- Use only facts and numbers from the data. Never invent a number, street, stop or experience that is not in the data.
- commute: how the trips went, 2 or 3 sentences covering both places, mentioning what made each easy or hard.
- rating: give exactly the two ratings from the data as "X out of 10", one short sentence each with the main reason.
- future: which place is better for her in future and why, 1 or 2 sentences. It must match the place with the higher rating (or say they are equal).
- No stage directions, no emojis.`;

const VOICE_SCHEMA = {
  type: 'object',
  properties: { commute: { type: 'string' }, rating: { type: 'string' }, future: { type: 'string' } },
  required: ['commute', 'rating', 'future'],
  additionalProperties: false,
};

export interface VoiceAnswers { commute: string; rating: string; future: string; model: string; verified: boolean; unverified: string[] }

/** Interview facts without the map path (Claude does not need coordinates). */
export function voiceFacts(iv: Interview) {
  return {
    person: `${iv.name}, ${iv.age}, ${iv.about}`,
    weather: iv.scenario === 'RAINY_SAT' ? 'rainy Saturday' : iv.scenario === 'SNOWY_SAT' ? 'snowy Saturday' : 'sunny Saturday',
    trips: iv.trips.map(({ path: _path, siteId: _id, ...rest }) => rest),
    higherRated: iv.preferred,
  };
}

export function generateVoices(jobs: { key: string; facts: unknown }[]): Promise<Record<string, VoiceAnswers>> {
  return generateCached<Omit<VoiceAnswers, 'model' | 'verified' | 'unverified'>>('interviews', VOICE_SYSTEM, VOICE_SCHEMA, 'Trip facts:', jobs);
}

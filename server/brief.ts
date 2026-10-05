import type { Brief, PersonaId } from '../src/contracts';
import { PERSONA_GUARD_THRESHOLD, PERSONA_IDS } from '../src/score/score';
import { BriefCache } from './cache';
import { allowedNumbers, buildPayload, type BriefPayload, type BriefRequest, type SitePayload } from './briefInput';
import type { LlmClient, ToolSpec } from './llm';
import { findInventedNumbers } from './numberCheck';

export const PERSONA_LABEL: Record<PersonaId, string> = {
  senior: 'Oma Helga (senior, rollator)',
  vendor: 'Markus (vendor, 3.5 t van)',
  commuter: 'Lukas (lunch-break commuter)',
  retailer: 'Frau Weber (boutique owner)',
};

const SYSTEM = `You are the analyst behind UrbanTwin, a decision tool for the city of Nuremberg's market relocation.
A simulation engine has already computed every number you will see. You explain and recommend; you never calculate or invent.
Rules:
- Quote numbers exactly as they appear in the input (scores, percentages, counts). Never round differently, estimate, extrapolate or add figures that are not in the input.
- Name the real friction from the input (topFriction) instead of generic praise.
- A site with failsStakeholderGroup=true has a persona below ${PERSONA_GUARD_THRESHOLD}: say so plainly even if its marketScore is high.
- The weights are the planner's value judgment, not a fact. Say which weights drive the ranking.
- Write for a city council: short, concrete, neutral.`;

// ───────────────────────── schemas ─────────────────────────

const str = { type: 'string' } as const;
const personaEnum = { type: 'string', enum: [...PERSONA_IDS] } as const;

const BRIEF_TOOL: ToolSpec = {
  name: 'write_recommendation',
  description: 'Write the council recommendation from the engine results.',
  schema: {
    type: 'object', additionalProperties: false,
    required: ['recommended', 'why', 'comparisons', 'losers'],
    properties: {
      recommended: { ...str, description: 'Candidate id of the recommended site (must be recommendedId from the input).' },
      why: { type: 'array', items: str, description: '2–3 reasons, one short sentence each, citing engine numbers.' },
      comparisons: {
        type: 'array', description: 'At least two alternatives compared with the recommended site.',
        items: { type: 'object', additionalProperties: false, required: ['site', 'betterAt', 'worseAt'], properties: { site: str, betterAt: str, worseAt: str } },
      },
      losers: {
        type: 'array', description: 'Personas that fare worst on the recommended site, each with a concrete mitigation.',
        items: { type: 'object', additionalProperties: false, required: ['persona', 'mitigation'], properties: { persona: personaEnum, mitigation: str } },
      },
    },
  },
};

const VERDICT_TOOL: ToolSpec = {
  name: 'write_verdict',
  description: 'Write one first-person sentence for a persona.',
  schema: { type: 'object', additionalProperties: false, required: ['verdict'], properties: { verdict: { ...str, description: 'One or two first-person sentences, max 35 words.' } } },
};

export const MITIGATION_KINDS = ['KIOSKS', 'DELIVERY_WINDOW', 'STALL_LAYOUT'] as const;
export interface Mitigation {
  kind: (typeof MITIGATION_KINDS)[number];
  persona: PersonaId;
  /** KIOSKS / STALL_LAYOUT: how many nodes or stall slots to change. DELIVERY_WINDOW: ignored (0). */
  count: number;
  /** DELIVERY_WINDOW: "HH:MM-HH:MM". Otherwise "". */
  window: string;
  rationale: string;
  /** Engine-readable label, e.g. "Express kiosk (3) near the transit exit". */
  id: string;
}

const MITIGATION_TOOL: ToolSpec = {
  name: 'propose_mitigation',
  description: 'Propose one structured intervention the simulation engine can apply and re-run.',
  schema: {
    type: 'object', additionalProperties: false, required: ['kind', 'persona', 'count', 'window', 'rationale'],
    properties: {
      kind: { type: 'string', enum: [...MITIGATION_KINDS], description: 'KIOSKS = express kiosks near the transit exit; DELIVERY_WINDOW = restrict/shift vehicle access times; STALL_LAYOUT = rearrange stall slots.' },
      persona: { ...personaEnum, description: 'The persona this mainly helps.' },
      count: { type: 'integer', description: 'Nodes or stall slots to change, 0–8.' },
      window: { ...str, description: 'HH:MM-HH:MM for DELIVERY_WINDOW, otherwise an empty string.' },
      rationale: { ...str, description: 'One sentence tying the choice to engine friction; no new numbers.' },
    },
  },
};

const DELTA_TOOL: ToolSpec = {
  name: 'write_delta',
  description: 'Explain in two sentences what changed between two engine runs and why.',
  schema: { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { ...str, description: 'Max 45 words. Only numbers from the input.' } } },
};

// ───────────────────────── helpers ─────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** The engine, not the model, decides the pick: best MarketScore among sites that fail no persona, else the best overall. */
export function recommendedId(p: BriefPayload): string {
  return (p.ranking.find((s) => !s.failsStakeholderGroup) ?? p.ranking[0]).id;
}

function parseBrief(raw: unknown, p: BriefPayload): Brief {
  if (!isObj(raw)) throw new Error('brief is not an object');
  const { why, comparisons, losers } = raw;
  if (!isStrArr(why) || why.length === 0) throw new Error('why must be a non-empty string[]');
  if (!Array.isArray(comparisons) || !comparisons.every((c) => isObj(c) && ['site', 'betterAt', 'worseAt'].every((k) => typeof c[k] === 'string'))) throw new Error('bad comparisons');
  const need = Math.min(2, p.ranking.length - 1);
  if (comparisons.length < need) throw new Error(`need at least ${need} comparisons`);
  if (!Array.isArray(losers) || !losers.every((l) => isObj(l) && PERSONA_IDS.includes(l.persona as PersonaId) && typeof l.mitigation === 'string')) throw new Error('bad losers');
  const parts = { why, comparisons: comparisons as Brief['comparisons'], losers: losers as Brief['losers'] };
  return { recommended: recommendedId(p), ...parts, councilBriefMd: composeCouncilMd(p, parts) }; // pick is overridden even if Claude chose differently
}

function briefText(b: Brief): string {
  return [...b.why, ...b.comparisons.flatMap((c) => [c.site, c.betterAt, c.worseAt]), ...b.losers.map((l) => l.mitigation)].join('\n');
}

const siteJson = (p: BriefPayload) => JSON.stringify(p);

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms} ms`)), ms); });
  try { return await Promise.race([work, timeout]); } finally { clearTimeout(timer!); }
}

/** Ask, verify every number against the engine, retry once with the offending numbers named. */
async function askVerified<T>(
  llm: LlmClient, tool: ToolSpec, user: string, allowed: number[],
  parse: (raw: unknown) => T, textOf: (v: T) => string, effort: 'low' | 'medium' = 'low',
): Promise<T> {
  let feedback = '';
  let invented: number[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const value = parse(await llm.callTool({ system: SYSTEM, user: user + feedback, tool, effort }));
    invented = findInventedNumbers(textOf(value), allowed);
    if (invented.length === 0) return value;
    console.warn(`[brief] ${tool.name} attempt ${attempt + 1} used numbers not in the input: ${invented.join(', ')}`);
    feedback = `\n\nYour previous answer used numbers that are not in the input: ${invented.join(', ')}. Rewrite using only numbers from the input.`;
  }
  throw new Error(`model kept inventing numbers: ${invented.join(', ')}`);
}

// ───────────────────────── offline / deterministic fallbacks ─────────────────────────

const worstPersona = (s: SitePayload): PersonaId => [...PERSONA_IDS].sort((a, b) => s.personas[a].score - s.personas[b].score)[0];

/** Council brief assembled in code from the structured fields, so Claude writes fewer tokens and the text can't drift from them. */
export function composeCouncilMd(p: BriefPayload, b: Pick<Brief, 'why' | 'comparisons' | 'losers'>, footer = ''): string {
  const top = p.ranking.find((s) => s.id === recommendedId(p))!;
  return [
    `# Market relocation brief (${p.scenario})`,
    `**Recommended: ${top.name}** (MarketScore ${top.marketScore}, consensus ${top.consensus}).`,
    '', ...b.why.map((x) => `- ${x}`),
    '', '## Alternatives', ...b.comparisons.map((c) => `- **${c.site}**: better at ${c.betterAt}; worse at ${c.worseAt}.`),
    '', '## Who loses and what to do', ...b.losers.map((l) => `- ${PERSONA_LABEL[l.persona]}: ${l.mitigation}`),
    ...(footer ? ['', footer] : []),
  ].join('\n');
}

/** Pure function of the engine numbers: the offline brief, true by construction. */
export function templateBrief(p: BriefPayload): Brief {
  const top = p.ranking.find((s) => s.id === recommendedId(p))!;
  const others = p.ranking.filter((s) => s.id !== top.id);
  const comparisons = others.slice(0, 3).map((o) => {
    const best = [...PERSONA_IDS].sort((a, b) => (o.personas[b].score - top.personas[b].score) - (o.personas[a].score - top.personas[a].score))[0];
    const worst = [...PERSONA_IDS].sort((a, b) => (top.personas[b].score - o.personas[b].score) - (top.personas[a].score - o.personas[a].score))[0];
    return {
      site: o.name,
      betterAt: `${PERSONA_LABEL[best]}: ${o.personas[best].score} vs ${top.personas[best].score}`,
      worseAt: `${PERSONA_LABEL[worst]}: ${o.personas[worst].score} vs ${top.personas[worst].score} (${o.personas[worst].topFriction})`,
    };
  });
  const w = worstPersona(top);
  const guardNote = top.failsStakeholderGroup
    ? `No candidate clears every stakeholder group; ${top.name} still has ${top.failedPersonas.map((f) => PERSONA_LABEL[f]).join(', ')} below ${PERSONA_GUARD_THRESHOLD}.`
    : `No stakeholder group falls below ${PERSONA_GUARD_THRESHOLD}.`;
  const why = [
    `${top.name} has the highest MarketScore (${top.marketScore}) among sites that fail no stakeholder group under the current weights.`,
    `Persona scores: ${PERSONA_IDS.map((id) => `${PERSONA_LABEL[id]} ${top.personas[id].score}`).join('; ')}.`,
    guardNote,
  ];
  const losers = [{ persona: w, mitigation: `Reduce "${top.personas[w].topFriction}" for ${PERSONA_LABEL[w]} (score ${top.personas[w].score}).` }];
  const councilBriefMd = composeCouncilMd(p, { why, comparisons, losers }, '*Offline summary generated directly from the simulation numbers.*');
  return { recommended: top.id, why, comparisons, losers, councilBriefMd };
}

export function templateVerdict(s: SitePayload, persona: PersonaId): string {
  const x = s.personas[persona];
  return x.score < PERSONA_GUARD_THRESHOLD
    ? `At ${s.name} I only get a ${x.score}: ${x.topFriction}.`
    : `${s.name} works for me at ${x.score}; my biggest friction is ${x.topFriction}.`;
}

// ───────────────────────── public API ─────────────────────────

export interface BriefDeps {
  llm?: LlmClient;
  cache?: BriefCache;
  timeoutMs?: number;
}

export type BriefSource = 'claude' | 'cache' | 'cache-latest' | 'template';
export interface BriefResponse { brief: Brief; source: BriefSource; ms: number; warning?: string }

export async function generateBrief(req: BriefRequest, deps: BriefDeps = {}): Promise<BriefResponse> {
  const t0 = Date.now();
  const cache = deps.cache ?? new BriefCache();
  const p = buildPayload(req);
  if (p.ranking.length === 0) throw new Error('no simulation results to brief');
  let warning: string | undefined;
  if (deps.llm) {
    try {
      const user = `Input (engine output, ${p.ranking.length} sites ranked best first):\n${siteJson(p)}\n\nrecommendedId: ${recommendedId(p)}\nCompare the recommendation with at least ${Math.min(2, p.ranking.length - 1)} alternatives.`;
      const brief = await withTimeout(
        askVerified(deps.llm, BRIEF_TOOL, user, allowedNumbers(p), (r) => parseBrief(r, p), briefText, 'low'),
        deps.timeoutMs ?? 20_000, 'brief',
      );
      cache.put(p, brief);
      return { brief, source: 'claude', ms: Date.now() - t0 };
    } catch (e) {
      warning = e instanceof Error ? e.message : String(e);
    }
  }
  const cached = cache.get(p);
  if (cached) return { brief: cached.brief, source: cached.exact ? 'cache' : 'cache-latest', ms: Date.now() - t0, warning };
  return { brief: templateBrief(p), source: 'template', ms: Date.now() - t0, warning };
}

/** One call per persona (not per agent); falls back per persona to a template line. */
export async function generateVerdicts(
  req: BriefRequest, candidateId: string, deps: Pick<BriefDeps, 'llm' | 'timeoutMs'> = {},
): Promise<Record<PersonaId, { verdict: string; source: 'claude' | 'template' }>> {
  const p = buildPayload(req);
  const site = p.ranking.find((s) => s.id === candidateId);
  if (!site) throw new Error(`unknown candidate ${candidateId}`);
  const allowed = allowedNumbers(p);
  const entries = await Promise.all(PERSONA_IDS.map(async (persona) => {
    const fallback = { verdict: templateVerdict(site, persona), source: 'template' as const };
    if (!deps.llm) return [persona, fallback] as const;
    try {
      const user = `You are ${PERSONA_LABEL[persona]}. Speak as them, first person, about ${site.name} on a ${p.scenario} Saturday.\nTheir engine metrics: ${JSON.stringify(site.personas[persona])}\nOther sites for context: ${JSON.stringify(p.ranking.filter((s) => s.id !== site.id).map((s) => ({ name: s.name, score: s.personas[persona].score })))}`;
      const verdict = await withTimeout(
        askVerified(deps.llm, VERDICT_TOOL, user, allowed, (r) => {
          if (!isObj(r) || typeof r.verdict !== 'string' || !r.verdict.trim()) throw new Error('bad verdict');
          return r.verdict;
        }, (v) => v),
        deps.timeoutMs ?? 12_000, `verdict:${persona}`,
      );
      return [persona, { verdict, source: 'claude' as const }] as const;
    } catch {
      return [persona, fallback] as const;
    }
  }));
  return Object.fromEntries(entries) as Record<PersonaId, { verdict: string; source: 'claude' | 'template' }>;
}

/** Text handed to the engine as a `mitigations[]` entry. The UI's toMitigation() maps it by keyword (kiosk / delivery window / layout). */
export const mitigationId = (m: Pick<Mitigation, 'kind' | 'count' | 'window'>) =>
  m.kind === 'DELIVERY_WINDOW' ? `Delivery window ${m.window}: removable bollards lowered`
  : m.kind === 'KIOSKS' ? `Express kiosk (${m.count}) near the transit exit`
  : `Stall layout: loop with one circulation route (${m.count} slots)`;

/** Deterministic mitigation for the worst persona, used when Claude is unreachable. */
export function templateMitigation(s: SitePayload): Mitigation {
  const persona = worstPersona(s);
  const base = { persona, rationale: `Targets "${s.personas[persona].topFriction}".` };
  const m: Omit<Mitigation, 'id'> =
    persona === 'vendor' ? { ...base, kind: 'DELIVERY_WINDOW', count: 0, window: '05:00-06:30' }
    : persona === 'retailer' ? { ...base, kind: 'STALL_LAYOUT', count: 2, window: '' }
    : { ...base, kind: 'KIOSKS', count: 3, window: '' };
  return { ...m, id: mitigationId(m) };
}

/** Propose step of propose → simulate → judge. The engine applies `id`, re-runs, and the caller re-briefs. */
export async function proposeMitigation(
  req: BriefRequest, candidateId: string, deps: Pick<BriefDeps, 'llm' | 'timeoutMs'> = {},
): Promise<{ mitigation: Mitigation; source: 'claude' | 'template' }> {
  const p = buildPayload(req);
  const site = p.ranking.find((s) => s.id === candidateId);
  if (!site) throw new Error(`unknown candidate ${candidateId}`);
  if (deps.llm) {
    try {
      const user = `Site ${site.name} under ${p.scenario}. Engine result:\n${JSON.stringify(site)}\nPersonas below ${PERSONA_GUARD_THRESHOLD} or lowest: ${worstPersona(site)}. Already applied: ${JSON.stringify(site.mitigations)}.\nPropose ONE intervention for the worst-served persona.`;
      const mitigation = await withTimeout(
        askVerified(deps.llm, MITIGATION_TOOL, user, allowedNumbers(p), (r) => {
          if (!isObj(r) || !MITIGATION_KINDS.includes(r.kind as never) || !PERSONA_IDS.includes(r.persona as never)
            || typeof r.count !== 'number' || typeof r.window !== 'string' || typeof r.rationale !== 'string') throw new Error('bad mitigation');
          if (r.kind === 'DELIVERY_WINDOW' && !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(r.window)) throw new Error('bad delivery window');
          const base = { kind: r.kind as Mitigation['kind'], persona: r.persona as PersonaId, count: r.kind === 'DELIVERY_WINDOW' ? 0 : Math.min(8, Math.max(0, Math.round(r.count))), window: r.kind === 'DELIVERY_WINDOW' ? r.window : '', rationale: r.rationale };
          return { ...base, id: mitigationId(base) } satisfies Mitigation;
        }, (m) => m.rationale),
        deps.timeoutMs ?? 12_000, 'mitigation',
      );
      return { mitigation, source: 'claude' };
    } catch { /* fall through to the deterministic proposal */ }
  }
  return { mitigation: templateMitigation(site), source: 'template' };
}

// ───────────────────────── what-if delta ─────────────────────────

export interface Delta {
  recommendedBefore: string; recommendedAfter: string;
  siteChanges: { id: string; name: string; marketScoreBefore: number; marketScoreAfter: number; rankBefore: number; rankAfter: number }[];
  personaChanges: { siteId: string; persona: PersonaId; before: number; after: number }[];
}

/** Pure diff of two engine payloads: the facts a "what changed and why" line is allowed to cite. */
export function computeDelta(before: BriefPayload, after: BriefPayload): Delta {
  const prev = new Map(before.ranking.map((s) => [s.id, s]));
  const delta: Delta = { recommendedBefore: recommendedId(before), recommendedAfter: recommendedId(after), siteChanges: [], personaChanges: [] };
  for (const s of after.ranking) {
    const b = prev.get(s.id);
    if (!b) continue;
    if (b.marketScore !== s.marketScore || b.rank !== s.rank) {
      delta.siteChanges.push({ id: s.id, name: s.name, marketScoreBefore: b.marketScore, marketScoreAfter: s.marketScore, rankBefore: b.rank, rankAfter: s.rank });
    }
    for (const id of PERSONA_IDS) {
      if (b.personas[id].score !== s.personas[id].score) delta.personaChanges.push({ siteId: s.id, persona: id, before: b.personas[id].score, after: s.personas[id].score });
    }
  }
  return delta;
}

export async function explainDelta(
  before: BriefRequest, after: BriefRequest, deps: Pick<BriefDeps, 'llm' | 'timeoutMs'> = {},
): Promise<{ delta: Delta; summary: string; source: 'claude' | 'template' }> {
  const pb = buildPayload(before), pa = buildPayload(after);
  const delta = computeDelta(pb, pa);
  const name = (id: string) => pa.ranking.find((s) => s.id === id)?.name ?? id;
  const top = delta.siteChanges.sort((a, b) => Math.abs(b.marketScoreAfter - b.marketScoreBefore) - Math.abs(a.marketScoreAfter - a.marketScoreBefore))[0];
  const template = delta.recommendedBefore !== delta.recommendedAfter
    ? `The pick moves from ${name(delta.recommendedBefore)} to ${name(delta.recommendedAfter)} (${pb.scenario} → ${pa.scenario}).`
    : top ? `${top.name} moves from ${top.marketScoreBefore} to ${top.marketScoreAfter}; the pick stays ${name(delta.recommendedAfter)}.`
    : `Nothing changes; the pick stays ${name(delta.recommendedAfter)}.`;
  if (deps.llm) {
    try {
      const extra = delta.siteChanges.flatMap((c) => [c.marketScoreBefore, c.marketScoreAfter, c.rankBefore, c.rankAfter, Math.abs(c.marketScoreAfter - c.marketScoreBefore)])
        .concat(delta.personaChanges.flatMap((c) => [c.before, c.after, Math.abs(c.after - c.before)]));
      const user = `Before: scenario ${pb.scenario}, weights ${JSON.stringify(pb.weightsPct)}, mitigations ${JSON.stringify(pb.ranking[0]?.mitigations)}.\nAfter: scenario ${pa.scenario}, weights ${JSON.stringify(pa.weightsPct)}, mitigations ${JSON.stringify(pa.ranking[0]?.mitigations)}.\nEngine delta: ${JSON.stringify(delta)}\nFriction in the new run: ${JSON.stringify(pa.ranking.map((s) => ({ site: s.name, friction: PERSONA_IDS.map((id) => s.personas[id].topFriction) })))}`;
      const summary = await withTimeout(
        askVerified(deps.llm, DELTA_TOOL, user, [...allowedNumbers(pb), ...allowedNumbers(pa, extra)], (r) => {
          if (!isObj(r) || typeof r.summary !== 'string' || !r.summary.trim()) throw new Error('bad delta');
          return r.summary;
        }, (s) => s),
        deps.timeoutMs ?? 12_000, 'delta',
      );
      return { delta, summary, source: 'claude' };
    } catch { /* template below */ }
  }
  return { delta, summary: template, source: 'template' };
}

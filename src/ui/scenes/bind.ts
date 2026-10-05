/**
 * Binding resolver for scene caption templates. Implements the binding
 * grammar documented in `types.ts`. Pure functions only: no clocks, no
 * randomness, no logging (the director logs `BindingError`s).
 */

import type {
  BindingError,
  BindingFormat,
  BindingScope,
  CaptionBinding,
  CaptionPart,
  FormatBinding,
  ResolvedCaption,
  ResolvedCaptionPart,
} from './types';

/** Text rendered for a binding that did not resolve. */
export const UNRESOLVED = '—';

const ROOTS = ['result', 'before', 'after', 'brief', 'derived', 'scene', 'heroes', 'assets'] as const;
type Root = (typeof ROOTS)[number];
const FORMATS: readonly BindingFormat[] = ['int', 'num1', 'clock', 'text'];

export class TemplateParseError extends Error {}

/* ------------------------------------------------------------------------ */
/* Templates                                                                 */
/* ------------------------------------------------------------------------ */

const templateCache = new Map<string, readonly CaptionPart[]>();

/**
 * Splits a template into literal and binding parts. Throws `TemplateParseError`
 * on an unclosed `{`, a stray `}`, an empty binding or an unknown format.
 * Path syntax is checked at resolve time.
 */
export function parseTemplate(template: string): readonly CaptionPart[] {
  const cached = templateCache.get(template);
  if (cached) return cached;
  const parts: CaptionPart[] = [];
  let text = '';
  let i = 0;
  while (i < template.length) {
    const c = template[i];
    if (c === '{' && template[i + 1] === '{') { text += '{'; i += 2; continue; }
    if (c === '}' && template[i + 1] === '}') { text += '}'; i += 2; continue; }
    if (c === '}') throw new TemplateParseError(`stray "}" at ${i} in ${JSON.stringify(template)}`);
    if (c !== '{') { text += c; i += 1; continue; }
    const end = template.indexOf('}', i + 1);
    if (end < 0) throw new TemplateParseError(`unclosed "{" at ${i} in ${JSON.stringify(template)}`);
    const body = template.slice(i + 1, end).trim();
    const bar = body.indexOf('|');
    const path = (bar < 0 ? body : body.slice(0, bar)).trim();
    const format = bar < 0 ? undefined : body.slice(bar + 1).trim();
    if (!path) throw new TemplateParseError(`empty binding at ${i} in ${JSON.stringify(template)}`);
    if (format !== undefined && !FORMATS.includes(format as BindingFormat)) {
      throw new TemplateParseError(`unknown format "${format}" in ${JSON.stringify(template)}`);
    }
    if (text) { parts.push({ kind: 'text', text }); text = ''; }
    parts.push(format === undefined ? { kind: 'binding', path } : { kind: 'binding', path, format: format as BindingFormat });
    i = end + 1;
  }
  if (text) parts.push({ kind: 'text', text });
  // Frozen because resolved captions share the cached text parts.
  parts.forEach((p) => Object.freeze(p));
  templateCache.set(template, Object.freeze(parts));
  return parts;
}

/** Literal text of a template with every binding removed. RZ-static checks it. */
export function templateLiteralText(template: string): string {
  return parseTemplate(template)
    .map((p) => (p.kind === 'text' ? p.text : ''))
    .join('');
}

/* ------------------------------------------------------------------------ */
/* Paths                                                                     */
/* ------------------------------------------------------------------------ */

export type PathStep =
  | { kind: 'key'; key: string }
  | { kind: 'index'; index: number }
  | { kind: 'match'; field: string; value: string };

export interface ParsedPath {
  root: Root;
  steps: readonly PathStep[];
}

const SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*/;
const pathCache = new Map<string, ParsedPath | null>();

/** Parses a binding path, or returns `null` when it breaks the grammar. */
export function parsePath(path: string): ParsedPath | null {
  if (pathCache.has(path)) return pathCache.get(path)!;
  const parsed = parsePathUncached(path);
  pathCache.set(path, parsed);
  return parsed;
}

function parsePathUncached(path: string): ParsedPath | null {
  let root: Root = 'result';
  let rest = path;
  const dot = path.indexOf('.');
  if (dot > 0 && (ROOTS as readonly string[]).includes(path.slice(0, dot))) {
    root = path.slice(0, dot) as Root;
    rest = path.slice(dot + 1);
  }
  const steps: PathStep[] = [];
  const first = SEGMENT.exec(rest);
  if (!first) return null;
  steps.push({ kind: 'key', key: first[0] });
  let i = first[0].length;
  while (i < rest.length) {
    if (rest[i] === '.') {
      const seg = SEGMENT.exec(rest.slice(i + 1));
      if (!seg) return null;
      steps.push({ kind: 'key', key: seg[0] });
      i += 1 + seg[0].length;
    } else if (rest[i] === '[') {
      const close = rest[i + 1] === "'" ? rest.indexOf("']", i + 2) + 1 : rest.indexOf(']', i + 1);
      if (close <= i) return null;
      const sel = rest.slice(i + 1, close);
      const step = parseSelector(sel);
      if (!step) return null;
      steps.push(step);
      i = close + 1;
    } else {
      return null;
    }
  }
  return { root, steps };
}

function parseSelector(sel: string): PathStep | null {
  if (/^\d+$/.test(sel)) return { kind: 'index', index: Number(sel) };
  if (sel.length >= 2 && sel.startsWith("'") && sel.endsWith("'")) {
    const key = sel.slice(1, -1);
    return key.includes("'") ? null : { kind: 'key', key };
  }
  const eq = sel.indexOf('=');
  if (eq > 0) {
    const field = sel.slice(0, eq);
    const value = sel.slice(eq + 1);
    if (SEGMENT.exec(field)?.[0] === field && value.length > 0) return { kind: 'match', field, value };
  }
  return null;
}

/* ------------------------------------------------------------------------ */
/* Resolution                                                                */
/* ------------------------------------------------------------------------ */

export type ResolveFailure = BindingError['reason'];

export type ResolveOutcome = { ok: true; value: unknown } | { ok: false; reason: ResolveFailure };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * Own-property lookup on plain objects, so `constructor` or `__proto__` never
 * resolve. Arrays take only index and match selectors, so `length` never
 * becomes a UI-computed count.
 */
function own(obj: unknown, key: string): unknown {
  if (!isRecord(obj) || Array.isArray(obj)) return undefined;
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

function isScalar(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string' || typeof v === 'boolean';
}

/** Resolves a path against a scope and reports why it failed. */
export function resolveDetailed(scope: BindingScope, path: string): ResolveOutcome {
  const parsed = parsePath(path);
  if (!parsed) return { ok: false, reason: 'parse' };
  let cur: unknown = scope[parsed.root];
  for (const step of parsed.steps) {
    if (cur === undefined || cur === null) return { ok: false, reason: 'missing' };
    if (step.kind === 'key') {
      cur = own(cur, step.key);
    } else if (step.kind === 'index') {
      cur = Array.isArray(cur) ? cur[step.index] : own(cur, String(step.index));
    } else {
      if (!Array.isArray(cur)) return { ok: false, reason: 'no-match' };
      const hit = cur.find((item) => {
        const f = own(item, step.field);
        return f !== undefined && f !== null && String(f) === step.value;
      });
      if (hit === undefined) return { ok: false, reason: 'no-match' };
      cur = hit;
    }
  }
  if (cur === undefined || cur === null) return { ok: false, reason: 'missing' };
  if (!isScalar(cur)) return { ok: false, reason: 'not-scalar' };
  return { ok: true, value: cur };
}

/** Resolves a path to its scalar value, or `undefined` when it does not resolve. */
export function resolve(scope: BindingScope, path: string): unknown {
  const out = resolveDetailed(scope, path);
  return out.ok ? out.value : undefined;
}

/* ------------------------------------------------------------------------ */
/* Formatting                                                                */
/* ------------------------------------------------------------------------ */

const roundHalfAway = (x: number, decimals: number) => {
  const f = 10 ** decimals;
  const r = (Math.sign(x) * Math.round(Math.abs(x) * f)) / f;
  return r === 0 ? 0 : r; // drop -0
};

/** Formats seconds since 00:00 as `HH:MM`, wrapping at 24 h. */
export function formatClock(simSec: number): string {
  const minutes = ((Math.floor(simSec / 60) % 1440) + 1440) % 1440;
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * The one formatter for bound values. Strings and booleans render verbatim
 * under every format. Numbers follow the format; the default is `int`.
 */
export const formatBinding: FormatBinding = (value, format) => {
  if (!isScalar(value)) return UNRESOLVED;
  if (typeof value !== 'number') return String(value);
  switch (format) {
    case 'text':
      return String(value);
    case 'num1':
      return roundHalfAway(value, 1).toFixed(1);
    case 'clock':
      return formatClock(value);
    case 'int':
    case undefined:
      return String(roundHalfAway(value, 0));
  }
};

/* ------------------------------------------------------------------------ */
/* Captions                                                                  */
/* ------------------------------------------------------------------------ */

export interface CaptionResolution {
  caption: ResolvedCaption;
  errors: BindingError[];
}

/** Resolves every binding of a caption against a scope. */
export function resolveCaption(binding: CaptionBinding, scope: BindingScope, opacity: number): CaptionResolution {
  const errors: BindingError[] = [];
  let parts: ResolvedCaptionPart[];
  try {
    parts = parseTemplate(binding.template).map((p): ResolvedCaptionPart => {
      if (p.kind === 'text') return p;
      const out = resolveDetailed(scope, p.path);
      if (!out.ok) errors.push({ captionId: binding.id, path: p.path, reason: out.reason });
      const text = out.ok ? formatBinding(out.value, p.format) : UNRESOLVED;
      return p.format === undefined
        ? { kind: 'binding', text, path: p.path }
        : { kind: 'binding', text, path: p.path, format: p.format };
    });
  } catch (e) {
    if (!(e instanceof TemplateParseError)) throw e;
    errors.push({ captionId: binding.id, path: binding.template, reason: 'parse' });
    parts = [{ kind: 'binding', text: UNRESOLVED, path: binding.template }];
  }
  const caption: ResolvedCaption = { id: binding.id, slot: binding.slot, opacity, parts };
  if (binding.persona) caption.persona = binding.persona;
  return { caption, errors };
}

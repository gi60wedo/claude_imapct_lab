/**
 * Rule zero: Claude never invents a number. Pull every number out of generated text
 * and return those that match no engine value (within rounding).
 *
 * Ignored on purpose: clock times (05:30), plain years, list markers ("1."), and
 * numbers inside site/persona names are not quantities. Spelled-out numbers are not checked.
 */
export function extractNumbers(text: string): number[] {
  const cleaned = text
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ')        // clock times
    .replace(/\b(19|20)\d{2}\b/g, ' ')          // years
    .replace(/^\s*\d+[.)]\s+/gm, ' ')           // "1. " list markers
    .replace(/\b(?:U|S)\d\b/g, ' ');            // line names: U1, S2
  return [...cleaned.matchAll(/-?\d+(?:[.,]\d+)?/g)].map((m) => Number(m[0].replace(',', '.')));
}

export function findInventedNumbers(text: string, allowed: readonly number[], tolerance = 0.51): number[] {
  return [...new Set(extractNumbers(text))].filter((n) => !allowed.some((a) => Math.abs(a - n) <= tolerance));
}

// Seeded randomness. Every random draw in the twin goes through one Rng, so a seed reproduces a run exactly.

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derive an independent stream, so adding draws in one part of the engine doesn't shift another. */
export function fork(seed: number, label: string): Rng {
  let h = seed >>> 0;
  for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
  return mulberry32(h);
}

export const uniform = (rng: Rng, lo: number, hi: number) => lo + (hi - lo) * rng();

export function pickWeighted<T>(rng: Rng, items: T[], weights: number[]): T {
  let total = 0;
  for (const w of weights) total += w;
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/** Round a fractional count stochastically, so 2.3 becomes 2 or 3 with the right expectation. */
export const stochasticRound = (rng: Rng, x: number) => Math.floor(x) + (rng() < x - Math.floor(x) ? 1 : 0);

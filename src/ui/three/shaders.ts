// GLSL shared by the city, road, heat and weather shaders: seeded hashes and value noise. Every
// pattern derives from position or instance index, so the render is deterministic (no Math.random).

/** Hashes after Dave Hoskins ("Hash without Sine"): stable across GPUs for inputs up to ~1e5. */
export const NOISE_GLSL = /* glsl */ `
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float valueNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

/** Fragment shaders only (screen-space derivatives): fades a pattern out as its period shrinks below a few pixels. */
export const DETAIL_GLSL = /* glsl */ `
float detailFade(vec2 cells) { vec2 w = fwidth(cells); return 1.0 - smoothstep(0.18, 0.45, max(w.x, w.y)); }
`;

/**
 * Hash in JS, the same as hash11 in GLSL: used by the tests to show particle layouts are a pure
 * function of the instance index.
 */
export function hash11(value: number): number {
  const fract = (x: number) => x - Math.floor(x);
  let p = fract(value * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

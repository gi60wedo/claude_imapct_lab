// Heat as a smooth field: the engine's heat cells (SimulationResult.bySlice[slice].heat, one
// [lng, lat, people] per HEAT_CELL_M square) are splatted with a Gaussian into a grid of texels,
// then mapped onto 0–255 against a reference shared by all slices of the result, so a quiet slice
// reads quieter than the peak. Pure, so the field is testable without WebGL.
import type { SimulationResult } from '../../contracts';
import { HEAT_CELL_M } from '../../sim/params';
import { project, type LocalFrame } from './geometry';

export type HeatPoint = [number, number, number];

export interface HeatField {
  /** Intensity per texel, 0–255, row 0 at the south edge. */
  values: Uint8Array;
  width: number; height: number;
  /** Local metres (east, north) of texel (0, 0)'s centre, and the texel pitch. */
  west: number; south: number; texel: number;
  /** Engine heat cells drawn into the field. */
  cells: number;
}

/** Texels per engine heat cell, and the largest texture side. */
const TEXELS_PER_CELL = 3;
const MAX_SIDE = 512;
/** Gaussian sigma in heat cells: wide enough that neighbouring cells merge into one glow. */
const SIGMA_CELLS = 0.8;
/** Share of the heat cells below the reference, which maps to full intensity. */
const REFERENCE_QUANTILE = 0.95;
/** Lifts the many quiet cells of a heavy-tailed slice into view. */
const GAMMA = 0.85;

const isCell = (point: HeatPoint) => point.length >= 3 && point.every(Number.isFinite) && point[2] > 0;

/** People per heat cell that maps to full intensity: the 95th percentile over every slice of the result. */
export function heatReference(result: Pick<SimulationResult, 'bySlice'> | null | undefined): number {
  const weights = Object.values(result?.bySlice ?? {}).flatMap((slice) => (slice?.heat ?? []).filter(isCell).map((p) => p[2]));
  if (!weights.length) return 0;
  weights.sort((a, b) => a - b);
  return weights[Math.min(weights.length - 1, Math.floor(weights.length * REFERENCE_QUANTILE))];
}

/**
 * Splats the heat cells into a field over their bounding box plus a margin. Each cell adds
 * people × a unit-integral Gaussian, so a region of uniform cells reads as their own value; the
 * field is then divided by `reference` (heatReference), clamped and lifted by GAMMA.
 * Null when no cell carries heat.
 */
export function heatField(heat: readonly HeatPoint[], frame: LocalFrame, reference: number, cellM = HEAT_CELL_M): HeatField | null {
  const cells = heat.filter(isCell);
  if (!cells.length || !(reference > 0)) return null;
  const local = cells.map(([lng, lat, w]) => [...project([lng, lat], frame), w] as const);
  const sigma = cellM * SIGMA_CELLS;
  const margin = 3 * sigma;
  const es = local.map((p) => p[0]), ns = local.map((p) => p[1]);
  const west = Math.min(...es) - margin, east = Math.max(...es) + margin;
  const south = Math.min(...ns) - margin, north = Math.max(...ns) + margin;
  const texel = Math.max(cellM / TEXELS_PER_CELL, Math.max(east - west, north - south) / (MAX_SIDE - 1));
  const width = Math.ceil((east - west) / texel) + 1, height = Math.ceil((north - south) / texel) + 1;
  const field = new Float32Array(width * height);
  const radius = Math.ceil(margin / texel);
  // A unit-integral Gaussian scaled to one cell's area: uniform cells sum to their own weight.
  const norm = (cellM * cellM) / (2 * Math.PI * sigma * sigma);
  const kernel = new Float32Array((2 * radius + 1) ** 2);
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      kernel[(dy + radius) * (2 * radius + 1) + dx + radius] = norm * Math.exp(-((dx * texel) ** 2 + (dy * texel) ** 2) / (2 * sigma * sigma));
    }
  }
  for (const [e, n, w] of local) {
    const cx = Math.round((e - west) / texel), cy = Math.round((n - south) / texel);
    for (let dy = -radius; dy <= radius; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= height) continue;
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= width) continue;
        field[y * width + x] += w * kernel[(dy + radius) * (2 * radius + 1) + dx + radius];
      }
    }
  }
  const values = new Uint8Array(width * height);
  for (let i = 0; i < field.length; i++) values[i] = Math.round(255 * Math.min(1, field[i] / reference) ** GAMMA);
  return { values, width, height, west, south, texel, cells: cells.length };
}

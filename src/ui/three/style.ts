// Visual style of the 3D city: render quality tiers, time-of-day lighting, street surface classes
// and camera easing. Pure data and functions, so the look is testable without WebGL.
import type { TimeSlice } from '../../contracts';

export type Quality = 'high' | 'fast';

export interface QualitySettings {
  /** MSAA samples in the composer; 0 falls back to SMAA. */
  multisampling: number;
  ambientOcclusion: boolean;
  shadowMapSize: number;
  /** PCF filter radius in shadow-map texels. */
  shadowRadius: number;
  bloomLevels: number;
  /** Upper device-pixel-ratio bound for the adaptive resolution. */
  maxDpr: number;
}

export const QUALITY: Record<Quality, QualitySettings> = {
  high: { multisampling: 4, ambientOcclusion: true, shadowMapSize: 4096, shadowRadius: 4, bloomLevels: 7, maxDpr: 2 },
  fast: { multisampling: 0, ambientOcclusion: false, shadowMapSize: 2048, shadowRadius: 2, bloomLevels: 5, maxDpr: 1.25 },
};

/** Lowest device pixel ratio the adaptive resolution may drop to. */
export const MIN_DPR = 0.75;

export interface SunPreset {
  /** Degrees clockwise from north. */
  azimuth: number;
  /** Degrees above the horizon. */
  elevation: number;
  color: string; intensity: number;
  sky: string; ground: string; hemisphere: number;
}

/**
 * Stylised sun per schedule slice: cool low dawn light from the east, neutral midday light from
 * the south, warm afternoon light from the south-west. These shape the light only; no value here
 * is shown on screen.
 */
export const SUN: Record<TimeSlice, SunPreset> = {
  '05:30_DELIVERY': { azimuth: 72, elevation: 14, color: '#b4c8ff', intensity: 2.4, sky: '#7f97cc', ground: '#0a1020', hemisphere: 1.05 },
  '11:30_PEAK': { azimuth: 168, elevation: 52, color: '#fff7ec', intensity: 3.1, sky: '#b9c8de', ground: '#18202e', hemisphere: 1.1 },
  '15:00_LULL': { azimuth: 232, elevation: 30, color: '#ffc48c', intensity: 2.9, sky: '#d0bea8', ground: '#211810', hemisphere: 1.0 },
};

/** Unit world vector (x east, y up, z = −north) pointing from the ground toward the sun. */
export function sunDirection({ azimuth, elevation }: Pick<SunPreset, 'azimuth' | 'elevation'>): [number, number, number] {
  const az = (azimuth * Math.PI) / 180, el = (elevation * Math.PI) / 180;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
}

/** Camera preset transitions: duration in seconds and the ease applied to their progress. */
export const CAMERA_TWEEN_S = 1.2;

export function easeInOutCubic(t: number): number {
  const v = Math.max(0, Math.min(1, t));
  return v < 0.5 ? 4 * v * v * v : 1 - (-2 * v + 2) ** 3 / 2;
}

export type SurfaceClassId = 'cobble' | 'paving' | 'asphalt' | 'rough';

export interface SurfaceClass { id: SurfaceClassId; label: string; color: string }

/** Street overlay classes, in legend order. */
export const SURFACES: SurfaceClass[] = [
  { id: 'cobble', label: 'Cobble / sett', color: '#f59e0b' },
  { id: 'paving', label: 'Paving', color: '#22d3ee' },
  { id: 'asphalt', label: 'Asphalt / smooth', color: '#3d5f9e' },
  { id: 'rough', label: 'Rough / unpaved', color: '#64748b' },
];

/**
 * Maps an OSM surface tag (graph.json) or the engine's smooth/cobble/rough class (world.json)
 * onto an overlay class. Unknown or missing surfaces count as rough.
 */
export function surfaceClass(surface: string | null | undefined): SurfaceClassId {
  const s = (surface ?? '').toLowerCase();
  if (/cobble|sett/.test(s)) return 'cobble';
  if (/paving|plates|brick|tiles/.test(s)) return 'paving';
  if (/asphalt|smooth|concrete|paved|metal|wood/.test(s) && !/unpaved/.test(s)) return 'asphalt';
  return 'rough';
}

// Visual style of the 3D city: a monochrome dark map (near-black ground, flat dark-grey massing,
// grey streets) where the agent dots carry the only colour. Render quality tiers, time-of-day
// lighting, street and road classes and camera easing. Pure data and functions, so the look is
// testable without WebGL.
import type { PersonaId, TimeSlice } from '../../contracts';

export type Quality = 'high' | 'fast';

export interface QualitySettings {
  /** MSAA samples in the composer; 0 falls back to SMAA. */
  multisampling: number;
  ambientOcclusion: boolean;
  shadowMapSize: number;
  /** PCF filter radius in shadow-map texels. */
  shadowRadius: number;
  /** Upper device-pixel-ratio bound for the adaptive resolution. */
  maxDpr: number;
}

export const QUALITY: Record<Quality, QualitySettings> = {
  high: { multisampling: 4, ambientOcclusion: true, shadowMapSize: 4096, shadowRadius: 4, maxDpr: 2 },
  fast: { multisampling: 0, ambientOcclusion: false, shadowMapSize: 2048, shadowRadius: 2, maxDpr: 1.25 },
};

/**
 * Map greys, sRGB. Lit surfaces land darker than their albedo: under the neutral light below a
 * flat roof reflects about 0.66 of its linear albedo and a shaded wall about 0.32, so the building
 * albedo renders as #323236–#3a3a3f walls with roofs near #47474c, and the ground as #0e0e10.
 */
export const MAP = {
  background: '#0b0b0c',
  ground: '#141416',
  /** Faint grey of the 5 m contour lines, added as emission. */
  contour: '#1c1c1f',
  building: '#595960',
  edge: '#b4b4bc',
  edgeOpacity: 0.11,
  siteSelected: '#ffffff',
  site: '#8a8a90',
} as const;

/** Agent dot colours: the only colour in the scene. */
export const PERSONA_COLORS: Record<PersonaId, string> = {
  senior: '#8b5cf6', vendor: '#f97316', commuter: '#3b82f6', retailer: '#9ca3af',
};
export const AGENT_WHITE = '#f4f4f5';
export type AgentColors = 'persona' | 'white';

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
 * Neutral sun per schedule slice: low from the east at dawn, high from the south at midday, from
 * the south-west in the afternoon. Only the direction and the shadow length change; every colour
 * is grey, so the city stays monochrome. A strong white hemisphere fill keeps the massing flat,
 * map-like, with soft shadows. These shape the light only; no value here is shown on screen.
 */
export const SUN: Record<TimeSlice, SunPreset> = {
  '05:30_DELIVERY': { azimuth: 72, elevation: 14, color: '#ffffff', intensity: 0.55, sky: '#ffffff', ground: '#8a8a8a', hemisphere: 1.55 },
  '11:30_PEAK': { azimuth: 168, elevation: 52, color: '#ffffff', intensity: 0.6, sky: '#ffffff', ground: '#8a8a8a', hemisphere: 1.6 },
  '15:00_LULL': { azimuth: 232, elevation: 30, color: '#ffffff', intensity: 0.6, sky: '#ffffff', ground: '#8a8a8a', hemisphere: 1.6 },
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

export interface SurfaceClass { id: SurfaceClassId; label: string; color: string; dashed: boolean }

/** Street overlay classes, in legend order: greys only, sett lighter and dashed, asphalt darker. */
export const SURFACES: SurfaceClass[] = [
  { id: 'cobble', label: 'Cobble / sett', color: '#d4d4d8', dashed: true },
  { id: 'paving', label: 'Paving', color: '#a1a1a8', dashed: false },
  { id: 'asphalt', label: 'Asphalt / smooth', color: '#5c5c63', dashed: false },
  { id: 'rough', label: 'Rough / unpaved', color: '#7c7c84', dashed: false },
];

export type RoadClassId = 'major' | 'minor' | 'pedestrian' | 'footway';

/** Base street network, drawn always: ribbon width in metres and a flat grey, wider and lighter for major roads. */
export const ROADS: Record<RoadClassId, { width: number; color: string }> = {
  major: { width: 9, color: '#4a4a50' },
  minor: { width: 5.5, color: '#3a3a40' },
  pedestrian: { width: 4.5, color: '#35353a' },
  footway: { width: 1.8, color: '#2a2a2f' },
};

/** Painter's order: narrow ways first, so wider roads draw over them at junctions. */
export const ROAD_ORDER: RoadClassId[] = ['footway', 'pedestrian', 'minor', 'major'];

/**
 * Maps an OSM highway tag (graph.json `hw`) onto a road class; indoor ways (platform, elevator,
 * corridor) are not drawn. Without a tag (world.json) a vehicle edge counts as minor, else footway.
 */
export function roadClass(hw: string | null | undefined, vehicle?: boolean): RoadClassId | null {
  const h = (hw ?? '').toLowerCase();
  if (!h) return vehicle ? 'minor' : 'footway';
  if (/^(motorway|trunk|primary|secondary|tertiary)(_link)?$/.test(h)) return 'major';
  if (/^(residential|unclassified|living_street|service|road)$/.test(h)) return 'minor';
  if (h === 'pedestrian') return 'pedestrian';
  if (/^(platform|elevator|corridor|construction|proposed)$/.test(h)) return null;
  return 'footway';
}

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

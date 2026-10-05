// Loads the terrain and LoD2 buildings once and turns them into a handful of merged three.js
// objects in the local metric frame (x east, y up = elevation − baseElevation, z = −north).
import {
  BackSide, BufferGeometry, Color, DoubleSide, EdgesGeometry, Float32BufferAttribute, Group,
  LineBasicMaterial, LineSegments, Mesh, MeshDepthMaterial, MeshStandardMaterial, PlaneGeometry,
  SRGBColorSpace, Texture, TextureLoader, Vector2,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  createLocalFrame, extrudeFootprint, project, sampleElevation, TERRARIUM,
  type Bounds, type ElevationDecoder, type ElevationRaster, type LngLat, type LocalFrame,
} from './geometry';

interface TerrainMetadata {
  bounds: Bounds; baseElevation: number; elevationDecoder?: ElevationDecoder;
  elevation?: { url: string }; texture?: { url: string };
}
interface BuildingRecord { id: string; polygon: [number, number, number][][]; h: number; roof?: string }
interface BuildingsAsset { baseElevation: number; buildings: BuildingRecord[] }

/**
 * Uniforms shared by every building, edge and shadow-depth material: the glow around the selected
 * site, and uLift, the vertical exaggeration applied to building bases. The terrain mesh takes the
 * same factor as its y scale, so buildings stay seated on the exaggerated ground.
 */
export interface CityUniforms {
  uFocus: { value: Vector2 }; uFocusRadius: { value: number }; uFocusStrength: { value: number };
  uLift: { value: number };
}

export interface CityModel {
  frame: LocalFrame;
  raster: ElevationRaster;
  baseElevation: number;
  size: { width: number; depth: number };
  terrain: Mesh;
  buildings: Group;
  buildingCount: number;
  uniforms: CityUniforms;
}

const TILE_M = 600;
const TERRAIN_SEGMENTS = 256;

function assetUrl(path: string) {
  const relative = path.replace(/^\//, '');
  return `${import.meta.env.BASE_URL}${relative}`;
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(assetUrl(path));
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function loadRaster(path: string, bounds: Bounds, decoder: ElevationDecoder): Promise<ElevationRaster> {
  const response = await fetch(assetUrl(path));
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  // Terrarium bytes must reach us untouched: no colour management, no premultiplication.
  const bitmap = await createImageBitmap(await response.blob(),
    { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('2D canvas unavailable for elevation decode');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  return { pixels: data, width: canvas.width, height: canvas.height, bounds, decoder };
}

const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function buildTerrain(raster: ElevationRaster, frame: LocalFrame, texture: Texture) {
  const [west, south, east, north] = raster.bounds;
  const [x0, n0] = project([west, south], frame), [x1, n1] = project([east, north], frame);
  const width = x1 - x0, depth = n1 - n0;
  const geometry = new PlaneGeometry(width, depth, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);
  const positions = geometry.getAttribute('position');
  // PlaneGeometry rows run top (north) to bottom; uv v = 1 on the north edge matches flipY.
  for (let row = 0; row <= TERRAIN_SEGMENTS; row++) {
    const lat = north - (row / TERRAIN_SEGMENTS) * (north - south);
    for (let col = 0; col <= TERRAIN_SEGMENTS; col++) {
      const lng = west + (col / TERRAIN_SEGMENTS) * (east - west);
      const [x, n] = project([lng, lat], frame);
      positions.setXYZ(row * (TERRAIN_SEGMENTS + 1) + col, x, sampleElevation(lng, lat, raster), -n);
    }
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  texture.colorSpace = SRGBColorSpace;
  // Night look: the aerial photo multiplied into deep blue, with a faint emissive copy so
  // streets and roofs stay legible under the dim lights.
  const material = new MeshStandardMaterial({
    map: texture, color: new Color('#5d7fae'), roughness: 0.95, metalness: 0.05,
    emissive: new Color('#0d2a52'), emissiveMap: texture, emissiveIntensity: 0.55,
  });
  const mesh = new Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return { mesh, width, depth };
}

/** Raises each vertex by (uLift − 1) × its building's base, so the base sits on lifted terrain. */
function injectLift(shader: WebGLProgramParametersWithUniforms, uniforms: CityUniforms, extra = '') {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aBase;\nuniform float uLift;\nvarying vec3 vFocusWorld;')
    .replace('#include <begin_vertex>',
      `#include <begin_vertex>\ntransformed.y += (uLift - 1.0) * aBase;${extra}`);
}

function injectFocus(shader: WebGLProgramParametersWithUniforms, uniforms: CityUniforms, fragment: string) {
  // The glow reads true heights, so the lift is taken back out of vFocusWorld.
  injectLift(shader, uniforms,
    '\nvFocusWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvFocusWorld.y -= (uLift - 1.0) * aBase;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
varying vec3 vFocusWorld;
uniform vec2 uFocus; uniform float uFocusRadius; uniform float uFocusStrength;
float focusAmount() {
  float d = distance(vFocusWorld.xz, uFocus);
  return uFocusStrength * (1.0 - smoothstep(uFocusRadius * 0.25, uFocusRadius, d));
}`)
    .replace(fragment.split('\n')[0], fragment);
}

function buildingMaterials(uniforms: CityUniforms) {
  // Double-sided so a section cut (side view) shows the far walls of sliced buildings instead of
  // hollow shells; shadows keep the single-sided back-face casting.
  const glass = new MeshStandardMaterial({
    color: new Color('#16263f'), roughness: 0.42, metalness: 0.35,
    emissive: new Color('#071426'), emissiveIntensity: 1, side: DoubleSide, shadowSide: BackSide,
  });
  glass.onBeforeCompile = (shader) => injectFocus(shader, uniforms, `#include <emissivemap_fragment>
{
  float f = focusAmount();
  float rise = clamp(vFocusWorld.y / 60.0, 0.0, 1.0);
  totalEmissiveRadiance += vec3(0.0, 0.05, 0.1) * (1.0 - rise);
  totalEmissiveRadiance += vec3(0.05, 0.42, 0.62) * f * (0.35 + 0.4 * rise);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.9 + vec3(0.03, 0.06, 0.09), f);
}`);
  const edges = new LineBasicMaterial({
    color: new Color('#38bdf8'), transparent: true, opacity: 0.16, depthWrite: false,
  });
  edges.onBeforeCompile = (shader) => injectFocus(shader, uniforms, `#include <color_fragment>
{
  float f = focusAmount();
  diffuseColor.a = clamp(diffuseColor.a * (1.0 + 4.0 * f), 0.0, 1.0);
  diffuseColor.rgb += vec3(0.25, 0.55, 0.65) * f;
}`);
  // Same as the shadow map's default depth material, plus the lift.
  const depth = new MeshDepthMaterial();
  depth.onBeforeCompile = (shader) => injectLift(shader, uniforms);
  return { glass, edges, depth };
}

/** Per-vertex copy of the building base, read by the uLift shader code. */
function withBase<T extends BufferGeometry>(geometry: T, zBase: number): T {
  const count = geometry.getAttribute('position').count;
  geometry.setAttribute('aBase', new Float32BufferAttribute(new Float32Array(count).fill(zBase), 1));
  return geometry;
}

async function buildBuildings(asset: BuildingsAsset, frame: LocalFrame, uniforms: CityUniforms) {
  // Edges are built per building so each edge vertex can carry its building's base.
  const tiles = new Map<string, { solids: BufferGeometry[]; edges: BufferGeometry[] }>();
  let built = 0;
  for (let i = 0; i < asset.buildings.length; i++) {
    const building = asset.buildings[i];
    const rings = building.polygon?.map((ring) => ring.map(([lng, lat]) => [lng, lat] as LngLat));
    const zBase = building.polygon?.[0]?.[0]?.[2];
    // zBase is already relative to baseElevation; use it as is.
    const geometry = rings && zBase !== undefined ? safeExtrude(rings, zBase, building.h, frame) : null;
    if (geometry) {
      const [x, n] = project(rings![0][0], frame);
      const key = `${Math.floor(x / TILE_M)}:${Math.floor(n / TILE_M)}`;
      const tile = tiles.get(key) ?? { solids: [], edges: [] };
      tile.solids.push(withBase(geometry, zBase!));
      tile.edges.push(withBase(new EdgesGeometry(geometry, 28), zBase!));
      tiles.set(key, tile);
      built++;
    }
    if (i % 600 === 599) await yieldToBrowser();
  }
  const { glass, edges, depth } = buildingMaterials(uniforms);
  const group = new Group();
  group.name = 'buildings';
  for (const [key, tile] of [...tiles.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const merged = mergeGeometries(tile.solids, false);
    const outlines = mergeGeometries(tile.edges, false);
    for (const part of [...tile.solids, ...tile.edges]) part.dispose();
    if (!merged || !outlines) continue;
    merged.computeBoundingSphere();
    const mesh = new Mesh(merged, glass);
    mesh.name = `buildings-${key}`;
    mesh.customDepthMaterial = depth;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Buildings never take pointer events; skipping the raycast keeps hover cheap.
    mesh.raycast = () => {};
    const lines = new LineSegments(outlines, edges);
    lines.name = `edges-${key}`;
    lines.raycast = () => {};
    group.add(mesh, lines);
    await yieldToBrowser();
  }
  return { group, built };
}

function safeExtrude(rings: LngLat[][], zBase: number, h: number, frame: LocalFrame) {
  try {
    return extrudeFootprint(rings, zBase, h, frame);
  } catch {
    return null;
  }
}

async function loadCity(): Promise<CityModel> {
  const [terrain, asset] = await Promise.all([
    fetchJson<TerrainMetadata>('/data/terrain/terrain.json'),
    fetchJson<BuildingsAsset>('/data/buildings3d.json'),
  ]);
  if (asset.baseElevation !== terrain.baseElevation) {
    throw new Error('Buildings and terrain must share baseElevation');
  }
  const [west, south, east, north] = terrain.bounds;
  const frame = createLocalFrame([(west + east) / 2, (south + north) / 2]);
  const decoder = terrain.elevationDecoder ?? TERRARIUM;
  const [raster, texture] = await Promise.all([
    loadRaster(terrain.elevation?.url ?? '/data/terrain/elevation.png', terrain.bounds, decoder),
    new TextureLoader().loadAsync(assetUrl(terrain.texture?.url ?? '/data/terrain/texture.jpg')),
  ]);
  const uniforms: CityUniforms = {
    uFocus: { value: new Vector2(0, 0) }, uFocusRadius: { value: 220 }, uFocusStrength: { value: 0 },
    uLift: { value: 1 },
  };
  const ground = buildTerrain(raster, frame, texture);
  const { group, built } = await buildBuildings(asset, frame, uniforms);
  return {
    frame, raster, baseElevation: terrain.baseElevation,
    size: { width: ground.width, depth: ground.depth },
    terrain: ground.mesh, buildings: group, buildingCount: built, uniforms,
  };
}

let cached: Promise<CityModel> | null = null;

/**
 * The city is an app-lifetime asset: built once, shared across mounts (StrictMode included),
 * never disposed. A failed load clears the cache so a remount can retry.
 */
export function getCity(): Promise<CityModel> {
  cached ??= loadCity().catch((error) => {
    cached = null;
    throw error;
  });
  return cached;
}

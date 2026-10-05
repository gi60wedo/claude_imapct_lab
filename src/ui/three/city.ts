// Loads the terrain and LoD2 buildings once and turns them into a handful of merged three.js
// objects in the local metric frame (x east, y up = elevation − baseElevation, z = −north).
// The look is a dark monochrome map: matte near-black terrain with faint grey 5 m contours decoded
// from the DGM1 raster in the shader, flat dark-grey buildings with lighter roof tops, and thin
// light-grey edges at low opacity.
import {
  BackSide, BufferGeometry, ClampToEdgeWrapping, Color, DataTexture, DataUtils, DoubleSide, EdgesGeometry,
  Float32BufferAttribute, Group, HalfFloatType, LinearFilter, LineBasicMaterial, LineSegments, Mesh,
  MeshDepthMaterial, MeshStandardMaterial, PlaneGeometry, RedFormat, Vector2, Vector4,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  createLocalFrame, decodeTerrarium, extrudeFootprint, project, sampleElevation, TERRARIUM,
  type Bounds, type ElevationDecoder, type ElevationRaster, type LngLat, type LocalFrame,
} from './geometry';
import { eaveHeight, loadRoofs, type RoofMap } from './roofs';
import { MAP } from './style';

interface TerrainMetadata {
  bounds: Bounds; baseElevation: number; elevationDecoder?: ElevationDecoder;
  elevation?: { url: string };
}
interface BuildingRecord { id: string; polygon: [number, number, number][][]; h: number; roof?: string }
interface BuildingsAsset { baseElevation: number; buildings: BuildingRecord[] }

/**
 * Uniforms shared by every building, edge and shadow-depth material: uLift, the vertical
 * exaggeration applied to building bases. The terrain mesh takes the same factor as its y scale,
 * so buildings stay seated on the exaggerated ground.
 */
export interface CityUniforms {
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
  /** Buildings carrying real roof geometry; 0 until upgradeRoofs resolves with data. */
  roofCount: number;
  /** Source records, kept so the roof upgrade can rebuild the merged tiles. */
  asset: BuildingsAsset;
}

const TILE_M = 600;
const TERRAIN_SEGMENTS = 256;
/** Contour interval in metres of absolute elevation. */
const CONTOUR_M = 5;

export function assetUrl(path: string) {
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

/**
 * Decoded elevation (metres above baseElevation) as a half-float texture at half the raster
 * resolution, 2×2 box-filtered so the 1 m contours do not trace DGM1 noise. Row 0 is the north
 * edge, matching the raster, and the texture is not flipped.
 */
function heightTexture(raster: ElevationRaster) {
  const width = Math.max(1, raster.width >> 1), height = Math.max(1, raster.height >> 1);
  const data = new Uint16Array(width * height);
  const at = (col: number, row: number) => {
    const i = (Math.min(row, raster.height - 1) * raster.width + Math.min(col, raster.width - 1)) * 4;
    return decodeTerrarium(raster.pixels[i], raster.pixels[i + 1], raster.pixels[i + 2], raster.decoder);
  };
  let low = Infinity, high = -Infinity;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const h = (at(2 * col, 2 * row) + at(2 * col + 1, 2 * row) + at(2 * col, 2 * row + 1) + at(2 * col + 1, 2 * row + 1)) / 4;
      if (h < low) low = h;
      if (h > high) high = h;
      data[row * width + col] = DataUtils.toHalfFloat(h);
    }
  }
  const texture = new DataTexture(data, width, height, RedFormat, HalfFloatType);
  texture.magFilter = texture.minFilter = LinearFilter;
  texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { texture, range: new Vector2(low, high) };
}

function terrainMaterial(raster: ElevationRaster, baseElevation: number, rect: Vector4) {
  const { texture, range } = heightTexture(raster);
  const uniforms = {
    uHeight: { value: texture },
    uHeightSize: { value: new Vector2(texture.image.width, texture.image.height) },
    uBaseElevation: { value: baseElevation },
    uHeightRange: { value: range },
    /** West x, north n, width and depth of the raster in metres. */
    uTerrainRect: { value: rect },
    uContourColor: { value: new Color(MAP.contour) },
  };
  const material = new MeshStandardMaterial({ color: new Color(MAP.ground), roughness: 1, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec4 uTerrainRect;\nvarying vec2 vTerrain;')
      // Local position is (east, elevation, −north) before the lift scale: x and z map onto the raster.
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vTerrain = vec2((position.x - uTerrainRect.x) / uTerrainRect.z, (uTerrainRect.y + position.z) / uTerrainRect.w);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uHeight; uniform vec2 uHeightSize; uniform float uBaseElevation; uniform vec2 uHeightRange;
uniform vec3 uContourColor;
varying vec2 vTerrain;
// Anti-aliased iso-line of h every interval metres; fades out where lines crowd below a pixel.
float contourLine(float h, float interval, float width) {
  float v = h / interval;
  float w = max(fwidth(v), 1e-5);
  float d = abs(fract(v - 0.5) - 0.5);
  return (1.0 - smoothstep(0.0, w * width, d)) * (1.0 - smoothstep(0.12, 0.45, w));
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
vec2 terrainUv = (clamp(vTerrain * uHeightSize, vec2(0.0), uHeightSize - 1.0) + 0.5) / uHeightSize;
float terrainRel = texture2D(uHeight, terrainUv).r;
float terrainT = clamp((terrainRel - uHeightRange.x) / max(uHeightRange.y - uHeightRange.x, 1e-3), 0.0, 1.0);
diffuseColor.rgb *= mix(0.85, 1.15, terrainT);
float terrainLines = contourLine(terrainRel + uBaseElevation, ${CONTOUR_M.toFixed(1)}, 1.0);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += uContourColor * terrainLines * 0.35;`);
  };
  return material;
}

function buildTerrain(raster: ElevationRaster, frame: LocalFrame, baseElevation: number) {
  const [west, south, east, north] = raster.bounds;
  const [x0, n0] = project([west, south], frame), [x1, n1] = project([east, north], frame);
  const width = x1 - x0, depth = n1 - n0;
  const geometry = new PlaneGeometry(width, depth, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);
  geometry.deleteAttribute('uv');
  const positions = geometry.getAttribute('position');
  // PlaneGeometry rows run top (north) to bottom.
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
  const mesh = new Mesh(geometry, terrainMaterial(raster, baseElevation, new Vector4(x0, n1, width, depth)));
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return { mesh, width, depth };
}

/** Raises each vertex by (uLift − 1) × its building's base, so the base sits on lifted terrain. */
function injectLift(shader: WebGLProgramParametersWithUniforms, uniforms: CityUniforms, extra = '') {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aBase;\nuniform float uLift;\nvarying float vAbove;\nvarying float vUp;')
    .replace('#include <begin_vertex>',
      `#include <begin_vertex>\nvAbove = max(position.y - aBase, 0.0);\ntransformed.y += (uLift - 1.0) * aBase;${extra}`);
}

function buildingMaterials(uniforms: CityUniforms) {
  // Double-sided so a section cut (side view) shows the far walls of sliced buildings instead of
  // hollow shells; shadows keep the single-sided back-face casting.
  const massing = new MeshStandardMaterial({
    color: new Color(MAP.building), roughness: 1, metalness: 0, side: DoubleSide, shadowSide: BackSide,
  });
  // Flat dark massing: a soft contact shade over the first metres above the base, and roof tops
  // (faces pointing up) a touch lighter than the walls.
  massing.onBeforeCompile = (shader) => {
    injectLift(shader, uniforms, '\nvUp = normalize(mat3(modelMatrix) * objectNormal).y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAbove;\nvarying float vUp;')
      .replace('#include <color_fragment>', `#include <color_fragment>
diffuseColor.rgb *= (0.78 + 0.22 * smoothstep(0.0, 6.0, vAbove)) * (1.0 + 0.12 * smoothstep(0.35, 0.8, abs(vUp)));`);
  };
  const edges = new LineBasicMaterial({
    color: new Color(MAP.edge), transparent: true, opacity: MAP.edgeOpacity, depthWrite: false,
  });
  edges.onBeforeCompile = (shader) => injectLift(shader, uniforms);
  // Same as the shadow map's default depth material, plus the lift.
  const depth = new MeshDepthMaterial();
  depth.onBeforeCompile = (shader) => injectLift(shader, uniforms);
  return { massing, edges, depth };
}

/** Per-vertex copy of the building base, read by the uLift shader code. */
function withBase<T extends BufferGeometry>(geometry: T, zBase: number): T {
  const count = geometry.getAttribute('position').count;
  geometry.setAttribute('aBase', new Float32BufferAttribute(new Float32Array(count).fill(zBase), 1));
  return geometry;
}

/** Roof triangle soup in world axes with flat normals, matching the extruded walls' attributes. */
function roofGeometry(triangles: Float32Array, frame: LocalFrame): BufferGeometry | null {
  const positions = new Float32Array(triangles.length);
  for (let i = 0; i < triangles.length; i += 3) {
    const [x, n] = project([triangles[i], triangles[i + 1]], frame);
    positions[i] = x; positions[i + 1] = triangles[i + 2]; positions[i + 2] = -n;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

async function buildBuildings(asset: BuildingsAsset, frame: LocalFrame, uniforms: CityUniforms, roofs: RoofMap | null) {
  // Edges are built per building so each edge vertex can carry its building's base.
  const tiles = new Map<string, { solids: BufferGeometry[]; edges: BufferGeometry[] }>();
  let built = 0, roofed = 0;
  for (let i = 0; i < asset.buildings.length; i++) {
    const building = asset.buildings[i];
    const rings = building.polygon?.map((ring) => ring.map(([lng, lat]) => [lng, lat] as LngLat));
    const zBase = building.polygon?.[0]?.[0]?.[2];
    const roof = roofs?.get(building.id);
    // With a roof, the walls stop at the eave and the roof triangles close the top.
    const eave = roof ? eaveHeight(roof) - (zBase ?? 0) : building.h;
    const wallHeight = roof && eave > 0.5 ? eave : building.h;
    // zBase is already relative to baseElevation; use it as is.
    const geometry = rings && zBase !== undefined ? safeExtrude(rings, zBase, wallHeight, frame) : null;
    if (geometry) {
      const [x, n] = project(rings![0][0], frame);
      const key = `${Math.floor(x / TILE_M)}:${Math.floor(n / TILE_M)}`;
      const tile = tiles.get(key) ?? { solids: [], edges: [] };
      tile.solids.push(withBase(geometry, zBase!));
      tile.edges.push(withBase(new EdgesGeometry(geometry, 28), zBase!));
      const top = roof && wallHeight !== building.h ? roofGeometry(roof, frame) : null;
      if (top) {
        tile.solids.push(withBase(top, zBase!));
        tile.edges.push(withBase(new EdgesGeometry(top, 20), zBase!));
        roofed++;
      }
      tiles.set(key, tile);
      built++;
    }
    if (i % 600 === 599) await yieldToBrowser();
  }
  const { massing, edges, depth } = buildingMaterials(uniforms);
  const meshes: (Mesh | LineSegments)[] = [];
  for (const [key, tile] of [...tiles.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const merged = mergeGeometries(tile.solids, false);
    const outlines = mergeGeometries(tile.edges, false);
    for (const part of [...tile.solids, ...tile.edges]) part.dispose();
    if (!merged || !outlines) continue;
    merged.computeBoundingSphere();
    const mesh = new Mesh(merged, massing);
    mesh.name = `buildings-${key}`;
    mesh.customDepthMaterial = depth;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Buildings never take pointer events; skipping the raycast keeps hover cheap.
    mesh.raycast = () => {};
    const lines = new LineSegments(outlines, edges);
    lines.name = `edges-${key}`;
    lines.raycast = () => {};
    meshes.push(mesh, lines);
    await yieldToBrowser();
  }
  return { meshes, built, roofed };
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
  const raster = await loadRaster(terrain.elevation?.url ?? '/data/terrain/elevation.png', terrain.bounds, decoder);
  const uniforms: CityUniforms = { uLift: { value: 1 } };
  const ground = buildTerrain(raster, frame, terrain.baseElevation);
  const { meshes, built } = await buildBuildings(asset, frame, uniforms, null);
  const group = new Group();
  group.name = 'buildings';
  group.add(...meshes);
  return {
    frame, raster, baseElevation: terrain.baseElevation,
    size: { width: ground.width, depth: ground.depth },
    terrain: ground.mesh, buildings: group, buildingCount: built, uniforms, roofCount: 0, asset,
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

let roofed: Promise<number> | null = null;

/**
 * Swaps the flat-topped tiles for walls plus real roof triangles once roofs3d.json arrives.
 * Runs after first paint; resolves with the number of roofed buildings (0 when the asset is absent).
 */
export function upgradeRoofs(city: CityModel): Promise<number> {
  roofed ??= (async () => {
    const roofs = await loadRoofs(assetUrl('/data/roofs3d.json'));
    if (!roofs) return 0;
    const { meshes, roofed: count } = await buildBuildings(city.asset, city.frame, city.uniforms, roofs);
    const old = [...city.buildings.children] as (Mesh | LineSegments)[];
    city.buildings.remove(...old);
    city.buildings.add(...meshes);
    for (const part of old) part.geometry.dispose();
    city.roofCount = count;
    return count;
  })().catch(() => 0);
  return roofed;
}

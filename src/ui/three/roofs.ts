// Optional LoD2 roof geometry. public/data/roofs3d.json, when present, carries
// { buildings: [{ id, triangles }] } where `triangles` is a flat array of [lng, lat, z] triples,
// three per triangle, with z relative to baseElevation (the same frame as buildings3d.json).
// The asset is loaded after first paint; without it the buildings keep flat tops.
// TODO(subagent): read public/data/roofs3d.README.md once it exists; the .bin variant with a
// JSON header is not supported yet because its layout is undocumented.

/** Roof triangles per building id: flat [lng, lat, z] triples. */
export type RoofMap = Map<string, Float32Array>;

interface RoofRecord { id?: unknown; triangles?: unknown }

/** Keeps only records with an id and a non-empty, finite, whole-triangle coordinate list. */
export function parseRoofs(json: unknown): RoofMap {
  const roofs: RoofMap = new Map();
  const buildings = (json as { buildings?: unknown } | null)?.buildings;
  if (!Array.isArray(buildings)) return roofs;
  for (const record of buildings as RoofRecord[]) {
    const { id, triangles } = record ?? {};
    if (typeof id !== 'string' || !Array.isArray(triangles) && !(triangles instanceof Float32Array)) continue;
    const values = Float32Array.from(triangles as ArrayLike<number>);
    if (values.length === 0 || values.length % 9 !== 0 || !values.every(Number.isFinite)) continue;
    roofs.set(id, values);
  }
  return roofs;
}

/** Lowest roof vertex, relative to baseElevation: the eave the walls rise to. */
export function eaveHeight(triangles: Float32Array): number {
  let low = Infinity;
  for (let i = 2; i < triangles.length; i += 3) low = Math.min(low, triangles[i]);
  return low;
}

/** Fetches roofs3d.json; resolves null when it is missing or not JSON (a dev-server HTML fallback). */
export async function loadRoofs(url: string): Promise<RoofMap | null> {
  try {
    const response = await fetch(url);
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) return null;
    const roofs = parseRoofs(await response.json());
    return roofs.size ? roofs : null;
  } catch {
    return null;
  }
}

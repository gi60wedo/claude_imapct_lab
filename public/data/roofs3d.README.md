# roofs3d: triangulated LoD2 roof surfaces

`roofs3d.json` is the header and `roofs3d.bin` holds the geometry. Both come from
`prep/scene3d/lod2_roofs.py`, and `prep/scene3d/check_roofs.py` asserts the acceptance criteria.

## Source

- Bavarian LoD2 CityGML tiles in `datasets/lod2/*.gml`, EPSG:25832 with DHHN2016 heights.
- The script keeps every `bldg:Building` whose `gml:id` appears in `buildings3d.json`.
- It collects every `bldg:RoofSurface` polygon below that building, including polygons in
  `bldg:BuildingPart` children and polygons referenced through local `xlink:href`.
- Each polygon keeps its exterior and interior rings. The script ear-clips the polygon in its
  own plane and bridges interior rings into the exterior first.
- Vertices go EPSG:25832 → EPSG:4326 through pyproj with `always_xy=True`, then into the local
  frame below. The script applies no simplification.

## Local frame

Positions are metres in a tangent plane around `origin` (`header.origin.lng`, `header.origin.lat`).
The origin is the centre of `terrain/terrain.json` `bounds`. The frame matches
`createLocalFrame` in `src/ui/three/geometry.ts`. That code builds the same frame from the same
centre, so roof positions need no reprojection in the renderer.

```
x (east)  = (lng - origin.lng) * frame.eastPerDegree
y (north) = (lat - origin.lat) * frame.northPerDegree
z (up)    = DHHN2016 height - baseElevation        (baseElevation = 290 m)

eastPerDegree  = (π/180) · 6378137 · cos φ0 / sqrt(1 - e² sin² φ0)
northPerDegree = (π/180) · 6378137 · (1 - e²) / (1 - e² sin² φ0)^1.5
e² = 6.69437999014e-3, φ0 = origin.lat
```

The renderer's world uses x east, y up, z = −north. For that world, read `(x, y, z)` from the
file as `(x, z, -y)`. That mapping is a rotation and keeps the triangle winding.
Coordinates are rounded to millimetres before the Float32 cast.

## roofs3d.bin

Little-endian, three tightly packed sections in this order:

| Section | Type | Count | Byte offset |
|---|---|---|---|
| positions | Float32 × 3 (x, y, z) | `vertexCount` | `positions.byteOffset` (0) |
| indices | Uint32 | `indexCount` (= 3 × `triangleCount`) | `indices.byteOffset` (= 12 × `vertexCount`) |
| range table | Uint32 × 4 | `buildingCount` | `rangeTable.byteOffset` (= 12 × `vertexCount` + 4 × `indexCount`) |

`byteLength` equals `rangeTable.byteOffset + 16 × buildingCount`.

- Indices are absolute. They point into the whole positions array, so one `BufferGeometry` can
  take both arrays unchanged.
- Each range-table row is `[vertexStart, vertexCount, indexStart, indexCount]`. Rows follow the
  order of `header.ids`, which follows the order of `buildings3d.json`.
- A building's vertices form one contiguous block, and so do its indices. Its indices only reference
  vertices inside its own vertex block. Use `geometry.addGroup(indexStart, indexCount)` or
  `setDrawRange` for per-building picking and highlighting.
- Each roof polygon owns its vertices. The script does not share vertices between polygons, so
  `computeVertexNormals()` gives crisp facets at ridges.
- Triangles keep the CityGML exterior winding. They are counter-clockwise when seen from outside,
  so the face normal points out of the building. 99.6% of triangles face upward. The rest are
  steep or source-inverted faces, so render with `side: DoubleSide`.

## roofs3d.json

| Field | Meaning |
|---|---|
| `format` | `"urbantwin-roofs3d/1"` |
| `binary` | File name of the binary, relative to this header |
| `littleEndian` | Always `true` |
| `baseElevation` | Metres subtracted from source heights. It equals the value in `buildings3d.json` and `terrain.json` |
| `origin` | `{lng, lat}` of the local frame |
| `frame` | `eastPerDegree`, `northPerDegree`, and axis descriptions |
| `vertexCount`, `indexCount`, `triangleCount` | Section sizes |
| `buildingCount` | Buildings with at least one roof triangle |
| `polygonCount` | RoofSurface polygons read from the source |
| `byteLength` | Size of `roofs3d.bin` |
| `positions`, `indices`, `rangeTable` | `byteOffset`, element type, and counts for each section |
| `ids` | Building ids in range-table order |
| `ranges` | `{ [id]: [vertexStart, vertexCount, indexStart, indexCount] }`, the same values as the range table |

## Loading sketch

```ts
const header = await (await fetch('/data/roofs3d.json')).json();
const buffer = await (await fetch('/data/roofs3d.bin')).arrayBuffer();
const positions = new Float32Array(buffer, header.positions.byteOffset, header.vertexCount * 3);
const indices = new Uint32Array(buffer, header.indices.byteOffset, header.indexCount);
const [vertexStart, vertexCount, indexStart, indexCount] = header.ranges['DEBY_LOD2_3394961'];
```

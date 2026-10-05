"""Stream the Altstadt LoD2 footprints into the scene's building contract.

Run with uv run --with lxml --with numpy --with pyproj --with pillow
--with tifffile python prep/scene3d/lod2_buildings.py.
All source elevations use the DHHN2016 datum; only the shared base is subtracted.
Output is {baseElevation, buildings}; each building's polygon is [outer, ...holes].
Outer rings wind counter-clockwise from above; courtyard holes wind clockwise.
"""

from __future__ import annotations

import json
import math
import time
from pathlib import Path

import numpy as np
import tifffile
from lxml import etree
from PIL import Image
from pyproj import Transformer

ROOT = Path(__file__).resolve().parents[2]
BBOX = (649600.0, 5478800.0, 651700.0, 5480900.0)
TOLERANCE = 0.3  # metres, before projection
BLDG = "{http://www.opengis.net/citygml/building/1.0}"
GML = "{http://www.opengis.net/gml}"
XLINK = "{http://www.w3.org/1999/xlink}"


def base_elevation(root: Path = ROOT) -> float:
    """Read P2's base, or floor the minimum valid DGM1 pixel in the bbox."""
    terrain = root / "public/data/terrain/terrain.json"
    if terrain.is_file():
        value = json.loads(terrain.read_text(encoding="utf-8"))["baseElevation"]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"Invalid baseElevation in {terrain}")
        if not math.isfinite(value):
            raise ValueError(f"Non-finite baseElevation in {terrain}")
        print(f"Base elevation: {value:g} m from {terrain.relative_to(root)}", flush=True)
        return float(value)

    tiles = sorted((root / "datasets/dgm1").glob("*.tif"))
    if not tiles:
        raise FileNotFoundError("Neither terrain.json nor DGM1 GeoTIFFs exist")
    minimum = math.inf
    west, south, east, north = BBOX
    for tile in tiles:
        with tifffile.TiffFile(tile) as tif:
            page = tif.pages[0]
            scale = page.tags["ModelPixelScaleTag"].value
            tie = page.tags["ModelTiepointTag"].value
            keys = page.tags["GeoKeyDirectoryTag"].value
            geokeys = {keys[i]: keys[i + 3] for i in range(4, len(keys), 4)}
            if geokeys.get(3072) != 25832 or "ModelTransformationTag" in page.tags:
                raise ValueError(f"Expected north-up EPSG:25832 raster: {tile}")
            if len(page.shape) != 2 or scale[0] <= 0 or scale[1] <= 0:
                raise ValueError(f"Unsupported DGM1 grid: {tile}")
            rows, cols = page.shape
            # GeoTIFF RasterPixelIsArea centres sit half a pixel from the tiepoint.
            offset = 0.0 if geokeys.get(1025) == 2 else 0.5
            xs = tie[3] + (np.arange(cols) + offset - tie[0]) * scale[0]
            ys = tie[4] - (np.arange(rows) + offset - tie[1]) * scale[1]
            col_indices = np.flatnonzero((xs >= west) & (xs <= east))
            row_indices = np.flatnonzero((ys >= south) & (ys <= north))
            if not len(col_indices) or not len(row_indices):
                continue
            # Pillow's libtiff decodes the LZW float32 tiles without imagecodecs.
            # tifffile supplies the CRS, tiepoint, pixel scale and nodata metadata.
            with Image.open(tile) as image:
                pixels = np.asarray(image)
                if pixels.shape != page.shape or pixels.dtype != np.float32:
                    raise ValueError(f"Expected float32 DGM1 elevations: {tile}")
                values = pixels[np.ix_(row_indices, col_indices)]
            valid = np.isfinite(values)
            nodata = page.tags.get("GDAL_NODATA")
            if nodata is not None:
                valid &= values != float(str(nodata.value).rstrip("\x00"))
            if not valid.any():
                continue
            tile_minimum = float(values[valid].min())
            minimum = min(minimum, tile_minimum)
            print(f"DGM1 {tile.name}: bbox minimum {tile_minimum:.3f} m", flush=True)
    if not math.isfinite(minimum):
        raise ValueError("DGM1 has no valid elevations inside the Altstadt bbox")
    result = float(math.floor(minimum))
    print(f"Base elevation: {result:g} m = floor({minimum:.3f}) from DGM1", flush=True)
    return result


def read_ring(element: etree._Element) -> np.ndarray:
    """Read a 3D LinearRing, remove duplicate neighbours, and close it."""
    pos_list = element.find(GML + "posList")
    if pos_list is not None:
        values = np.fromstring(pos_list.text or "", sep=" ")
        dimension = int(pos_list.get("srsDimension", element.get("srsDimension", "3")))
        if dimension != 3 or values.size % 3:
            raise ValueError("LoD2 ring must contain XYZ triples")
        points = values.reshape(-1, 3)
    else:
        positions = element.findall(GML + "pos")
        if not positions:
            raise ValueError("LinearRing has no posList or pos coordinates")
        points = np.array([np.fromstring(p.text or "", sep=" ") for p in positions])
    if points.ndim != 2 or points.shape[1] != 3 or not np.isfinite(points).all():
        raise ValueError("Invalid LoD2 ring coordinates")
    if len(points) < 3:
        raise ValueError("LoD2 ring needs at least three vertices")
    keep = np.concatenate(([True], np.any(points[1:, :2] != points[:-1, :2], axis=1)))
    points = points[keep]
    if not np.array_equal(points[0, :2], points[-1, :2]):
        points = np.vstack((points, points[0]))
    return points


def area_and_centroid(points: np.ndarray) -> tuple[float, np.ndarray]:
    """Use local coordinates to avoid cancellation in UTM shoelace sums."""
    xy = points[:, :2] - points[0, :2]
    cross = xy[:-1, 0] * xy[1:, 1] - xy[1:, 0] * xy[:-1, 1]
    double_area = float(cross.sum())
    if abs(double_area) < 1e-8:
        return 0.0, points[:-1, :2].mean(axis=0)
    centroid = points[0, :2] + ((xy[:-1] + xy[1:]) * cross[:, None]).sum(axis=0) / (
        3 * double_area
    )
    return abs(double_area) / 2, centroid


def polygon_rings(polygon: etree._Element) -> list[np.ndarray]:
    """Keep interiors attached to their exterior, including solid fallbacks."""
    outer = polygon.find(GML + "exterior/" + GML + "LinearRing")
    if outer is None:
        return []
    return [read_ring(outer)] + [
        read_ring(ring)
        for ring in polygon.findall(GML + "interior/" + GML + "LinearRing")
    ]


def ground_polygon(building: etree._Element) -> list[np.ndarray]:
    footprints = [
        polygon_rings(polygon)
        for polygon in building.findall(".//" + BLDG + "GroundSurface//" + GML + "Polygon")
    ]
    footprints = [rings for rings in footprints if rings]
    if footprints:
        return max(footprints, key=lambda rings: area_and_centroid(rings[0])[0])

    # Solids may reference polygons in boundedBy through local xlink IDs.
    polygons = {
        polygon.get(GML + "id"): polygon
        for polygon in building.iter(GML + "Polygon")
        if polygon.get(GML + "id")
    }
    for solid in building.iter(GML + "Solid"):
        candidates = list(solid.iter(GML + "Polygon"))
        for member in solid.iter(GML + "surfaceMember"):
            reference = member.get(XLINK + "href", "")
            if reference.startswith("#") and reference[1:] in polygons:
                candidates.append(polygons[reference[1:]])
        for polygon in candidates:
            rings = polygon_rings(polygon)
            if rings and area_and_centroid(rings[0])[0] > 1e-8:
                footprints.append(rings)
    if not footprints:
        raise ValueError(f"No ground or solid footprint for {building.get(GML + 'id')}")
    # Prefer a horizontal base to walls which share its lowest vertex.
    return min(
        footprints,
        key=lambda rings: (float(rings[0][:, 2].min()), float(np.ptp(rings[0][:, 2])), -area_and_centroid(rings[0])[0]),
    )


def signed_area(points: np.ndarray) -> float:
    """Positive XY shoelace area means counter-clockwise viewed from above."""
    xy = np.asarray(points)[:, :2] - points[0][:2]
    return float(np.sum(xy[:-1, 0] * xy[1:, 1] - xy[1:, 0] * xy[:-1, 1])) / 2


def self_intersects(points: np.ndarray) -> bool:
    """Reject crossings, touches and collinear overlaps of nonadjacent edges."""
    xy = np.asarray(points, dtype=float)[:, :2]
    extent = float(np.ptp(xy, axis=0).max())
    if not extent:
        return True
    xy = (xy - xy[0]) / extent
    n = len(xy) - 1
    i, j = np.triu_indices(n, k=2)
    keep = (i != 0) | (j != n - 1)  # Closing neighbours share a vertex.
    i, j = i[keep], j[keep]
    a, b, c, d = xy[i], xy[i + 1], xy[j], xy[j + 1]
    epsilon = 1e-12
    boxes_overlap = np.all(
        np.maximum(np.minimum(a, b), np.minimum(c, d))
        <= np.minimum(np.maximum(a, b), np.maximum(c, d)) + epsilon,
        axis=1,
    )
    a, b, c, d = (p[boxes_overlap] for p in (a, b, c, d))

    def side(start, end, point):
        edge, relative = end - start, point - start
        return edge[:, 0] * relative[:, 1] - edge[:, 1] * relative[:, 0]

    ab_c, ab_d = side(a, b, c), side(a, b, d)
    cd_a, cd_b = side(c, d, a), side(c, d, b)
    opposite_ab = (np.minimum(ab_c, ab_d) <= epsilon) & (np.maximum(ab_c, ab_d) >= -epsilon)
    opposite_cd = (np.minimum(cd_a, cd_b) <= epsilon) & (np.maximum(cd_a, cd_b) >= -epsilon)
    return bool(np.any(opposite_ab & opposite_cd))


def _simplify_open(points: np.ndarray, tolerance: float) -> np.ndarray:
    keep = {0, len(points) - 1}
    pending = [(0, len(points) - 1)]
    while pending:
        start, end = pending.pop()
        if end - start <= 1:
            continue
        segment = points[end, :2] - points[start, :2]
        relative = points[start + 1 : end, :2] - points[start, :2]
        squared_length = float(segment @ segment)
        if squared_length:
            ratios = np.clip(relative @ segment / squared_length, 0, 1)
            relative = relative - ratios[:, None] * segment
        distances = np.sum(relative * relative, axis=1)
        index = int(np.argmax(distances))
        if distances[index] > tolerance * tolerance:
            split = start + index + 1
            keep.add(split)
            pending.extend(((start, split), (split, end)))
    return points[sorted(keep)]


def simplify_ring(points: np.ndarray, tolerance: float = TOLERANCE) -> np.ndarray:
    """Simplify both arcs of a closed ring with metre-space Douglas-Peucker."""
    vertices = points[:-1]
    anchor = int(np.lexsort((vertices[:, 1], vertices[:, 0]))[0])
    vertices = np.roll(vertices, -anchor, axis=0)
    split = int(np.argmax(np.sum((vertices[:, :2] - vertices[0, :2]) ** 2, axis=1)))
    first = _simplify_open(vertices[: split + 1], tolerance)
    second = _simplify_open(np.vstack((vertices[split:], vertices[0])), tolerance)
    simplified = np.vstack((first[:-1], second))
    if len(simplified) < 4 or area_and_centroid(simplified)[0] <= 1e-8 or self_intersects(simplified):
        return points
    return simplified


def projected_ring(points: np.ndarray, project: Transformer, z_base: float, *, hole: bool) -> list:
    """Check topology again after six-decimal projection; retry the source ring."""
    for candidate in (simplify_ring(points), points):
        lngs, lats = project.transform(candidate[:, 0], candidate[:, 1])
        ring = []
        for lng, lat in zip(lngs, lats):
            point = [round(float(lng), 6), round(float(lat), 6), z_base]
            if not ring or point != ring[-1]:
                ring.append(point)
        if ring[0] != ring[-1]:
            ring.append(ring[0].copy())
        array = np.asarray(ring)
        area = signed_area(array)
        if len(ring) < 4 or area == 0 or self_intersects(array):
            continue
        if (area > 0) == hole:
            ring.reverse()
        return ring
    raise ValueError("Source footprint is degenerate or self-intersecting after projection")


def iter_buildings(tile: Path):
    """Retain one Building and discard completed cityObjectMember siblings."""
    context = etree.iterparse(
        str(tile), events=("end",), tag=BLDG + "Building",
        resolve_entities=False, no_network=True,
    )
    for _, building in context:
        yield building
        member = building.getparent()
        building.clear()
        if member is not None:
            member.clear()
            parent = member.getparent()
            if parent is not None:
                while member.getprevious() is not None:
                    parent.remove(member.getprevious())


def build(root: Path = ROOT) -> dict:
    started = time.perf_counter()
    tiles = sorted((root / "datasets/lod2").glob("*.gml"))
    if not tiles:
        raise FileNotFoundError("No datasets/lod2/*.gml tiles exist")
    base = base_elevation(root)
    project = Transformer.from_crs(25832, 4326, always_xy=True)
    records = []
    identifiers = set()
    seen = 0
    before_vertices = after_vertices = 0
    west, south, east, north = BBOX
    for index, tile in enumerate(tiles, start=1):
        tile_seen = tile_kept = 0
        for building in iter_buildings(tile):
            tile_seen += 1
            rings = ground_polygon(building)
            ring = rings[0]
            area, centroid = area_and_centroid(ring)
            if area <= 1e-8:
                raise ValueError(f"Degenerate ground ring in {tile.name}")
            if not (west <= centroid[0] <= east and south <= centroid[1] <= north):
                continue
            identifier = building.get(GML + "id")
            if not identifier or identifier in identifiers:
                raise ValueError(f"Missing or duplicate building ID: {identifier} in {tile.name}")
            identifiers.add(identifier)
            ground_z = min(float(r[:, 2].min()) for r in rings)
            height_text = building.findtext(BLDG + "measuredHeight")
            if height_text is None:
                all_rings = [read_ring(r) for r in building.iter(GML + "LinearRing")]
                height = max(float(r[:, 2].max()) for r in all_rings) - ground_z
            else:
                height = float(height_text)
            if not math.isfinite(height) or height < 0:
                raise ValueError(f"Invalid measuredHeight for {identifier}: {height}")
            before_vertices += sum(len(r) - 1 for r in rings)
            z_base = round(ground_z - base, 3)
            try:
                polygon = [
                    projected_ring(r, project, z_base, hole=i > 0)
                    for i, r in enumerate(rings)
                ]
            except ValueError as error:
                raise ValueError(f"Invalid footprint for {identifier}: {error}") from error
            after_vertices += sum(len(r) - 1 for r in polygon)
            records.append({
                "id": identifier,
                "polygon": polygon,
                "h": round(height, 3),
                "roof": building.findtext(BLDG + "roofType") or "unknown",
            })
            tile_kept += 1
        seen += tile_seen
        print(
            f"LoD2 {index}/{len(tiles)} {tile.name}: parsed {tile_seen:,}, "
            f"kept {tile_kept:,}; elapsed {time.perf_counter() - started:.1f}s",
            flush=True,
        )
    output = root / "public/data/buildings3d.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump({"baseElevation": base, "buildings": records}, handle, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        handle.write("\n")
    elapsed = time.perf_counter() - started
    print(
        f"Wrote {len(records):,} buildings from {seen:,} source buildings; "
        f"{output.stat().st_size / 1_000_000:.3f} MB; {elapsed:.2f}s. "
        f"Vertices: {before_vertices:,} -> {after_vertices:,}; baseElevation={base:g} m",
        flush=True,
    )
    return {"seconds": elapsed, "count": len(records), "sourceCount": seen, "baseElevation": base}


if __name__ == "__main__":
    build()

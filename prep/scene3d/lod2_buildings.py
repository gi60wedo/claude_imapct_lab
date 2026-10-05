"""Stream the Altstadt LoD2 footprints into the scene's building contract.

Run with uv run --with lxml --with numpy --with pyproj --with pillow
--with tifffile python prep/scene3d/lod2_buildings.py.
All source elevations use the DHHN2016 datum; only the shared base is subtracted.
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


def ground_ring(building: etree._Element) -> np.ndarray:
    rings = [
        read_ring(ring)
        for ring in building.findall(
            ".//" + BLDG + "GroundSurface//" + GML + "exterior/" + GML + "LinearRing"
        )
    ]
    if rings:
        return max(rings, key=lambda ring: area_and_centroid(ring)[0])

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
            ring = polygon.find(GML + "exterior/" + GML + "LinearRing")
            if ring is not None:
                points = read_ring(ring)
                if area_and_centroid(points)[0] > 1e-8:
                    rings.append(points)
    if not rings:
        raise ValueError(f"No ground or solid footprint for {building.get(GML + 'id')}")
    # Prefer a horizontal base to walls which share its lowest vertex.
    return min(
        rings,
        key=lambda ring: (float(ring[:, 2].min()), float(np.ptp(ring[:, 2])), -area_and_centroid(ring)[0]),
    )


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
    if len(simplified) < 4 or area_and_centroid(simplified)[0] <= 1e-8:
        return points
    return simplified


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
            ring = ground_ring(building)
            area, centroid = area_and_centroid(ring)
            if area <= 1e-8:
                raise ValueError(f"Degenerate ground ring in {tile.name}")
            if not (west <= centroid[0] <= east and south <= centroid[1] <= north):
                continue
            identifier = building.get(GML + "id")
            if not identifier or identifier in identifiers:
                raise ValueError(f"Missing or duplicate building ID: {identifier} in {tile.name}")
            identifiers.add(identifier)
            ground_z = float(ring[:, 2].min())
            height_text = building.findtext(BLDG + "measuredHeight")
            if height_text is None:
                all_rings = [read_ring(r) for r in building.iter(GML + "LinearRing")]
                height = max(float(r[:, 2].max()) for r in all_rings) - ground_z
            else:
                height = float(height_text)
            if not math.isfinite(height) or height < 0:
                raise ValueError(f"Invalid measuredHeight for {identifier}: {height}")
            before_vertices += len(ring) - 1
            simplified = simplify_ring(ring)
            lngs, lats = project.transform(simplified[:, 0], simplified[:, 1])
            polygon = []
            z_base = round(ground_z - base, 3)
            for lng, lat in zip(lngs, lats):
                point = [round(float(lng), 6), round(float(lat), 6), z_base]
                if not polygon or point != polygon[-1]:
                    polygon.append(point)
            if polygon[0] != polygon[-1]:
                polygon.append(polygon[0].copy())
            if len(polygon) < 4 or len({tuple(p[:2]) for p in polygon[:-1]}) < 3:
                raise ValueError(f"Footprint collapsed after rounding: {identifier}")
            after_vertices += len(polygon) - 1
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
        json.dump(records, handle, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
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

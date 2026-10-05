#!/usr/bin/env python3
"""Verify P2 assets and sample 200 CityGML buildings with bounded XML memory.

Run with the same uv dependencies as terrain.py. This check validates data;
the 1600 x 900 scene render is a later integration gate.
"""

import json
import math
from pathlib import Path
import random
import time

from lxml import etree
import numpy as np
from PIL import Image
from pyproj import Transformer


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "public/data/terrain"
STUDY_BOUNDS = (649600, 5478800, 651700, 5480900)
NS = {"bldg": "http://www.opengis.net/citygml/building/1.0", "gml": "http://www.opengis.net/gml"}
BUILDING_TAG = f"{{{NS['bldg']}}}Building"
GML_ID = f"{{{NS['gml']}}}id"
SAMPLE_COUNT = 200


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def interpolate(pixels, cols, rows):
    """Independent bilinear reader for decoded raster centers."""
    height, width = pixels.shape[:2]
    cols, rows = np.clip(cols, 0, width - 1), np.clip(rows, 0, height - 1)
    x0, y0 = np.floor(cols).astype(int), np.floor(rows).astype(int)
    x1, y1 = np.minimum(x0 + 1, width - 1), np.minimum(y0 + 1, height - 1)
    fx, fy = cols - x0, rows - y0
    if pixels.ndim == 3:
        fx, fy = fx[..., None], fy[..., None]
    return (
        pixels[y0, x0] * ((1 - fx) * (1 - fy))
        + pixels[y0, x1] * (fx * (1 - fy))
        + pixels[y1, x0] * ((1 - fx) * fy)
        + pixels[y1, x1] * (fx * fy)
    )


def terrain_sample(pixels, bounds, lng, lat):
    west, south, east, north = bounds
    height, width = pixels.shape
    cols = (lng - west) / (east - west) * width - 0.5
    rows = (north - lat) / (north - south) * height - 0.5
    return interpolate(pixels, cols, rows)


def ring_points(element):
    values = np.fromstring(element.text or "", sep=" ")
    require(values.size >= 12 and values.size % 3 == 0, "Malformed 3D CityGML ground ring")
    points = values.reshape(-1, 3)
    require(np.all(np.isfinite(points)), "Non-finite CityGML coordinates")
    return points


def ring_centroid(points):
    # Local coordinates avoid cancellation in UTM shoelace products.
    xy = points[:, :2]
    if np.array_equal(xy[0], xy[-1]):
        xy = xy[:-1]
    origin = xy[0]
    local = xy - origin
    next_xy = np.roll(local, -1, axis=0)
    cross = local[:, 0] * next_xy[:, 1] - next_xy[:, 0] * local[:, 1]
    twice_area = float(cross.sum())
    if abs(twice_area) < 1e-8:
        return xy.mean(axis=0), 0.0
    center = origin + ((local + next_xy) * cross[:, None]).sum(axis=0) / (3 * twice_area)
    return center, abs(twice_area) / 2


def footprint(building):
    polygons = building.xpath(".//bldg:GroundSurface//gml:Polygon", namespaces=NS)
    weighted = np.zeros(2)
    total_area = 0.0
    ground_z = math.inf
    centers = []
    for polygon in polygons:
        for boundary, sign in (("exterior", 1), ("interior", -1)):
            for element in polygon.xpath(f"gml:{boundary}/gml:LinearRing/gml:posList", namespaces=NS):
                points = ring_points(element)
                center, area = ring_centroid(points)
                weighted += center * area * sign
                total_area += area * sign
                ground_z = min(ground_z, float(points[:, 2].min()))
                if sign == 1:
                    centers.append(center)
    if not centers:
        # Some CityGML exports embed rings in a solid instead of GroundSurface.
        rings = building.xpath(".//bldg:lod2Solid//gml:LinearRing/gml:posList", namespaces=NS)
        if not rings:
            return None
        points = min((ring_points(ring) for ring in rings), key=lambda p: float(p[:, 2].min()))
        center, _ = ring_centroid(points)
        return float(center[0]), float(center[1]), float(points[:, 2].min())
    center = weighted / total_area if total_area > 1e-8 else np.mean(centers, axis=0)
    return float(center[0]), float(center[1]), ground_z


def building_samples():
    """Seeded reservoir sampling gives each in-bbox building equal probability."""
    rng = random.Random(20261005)
    reservoir, seen = [], set()
    eligible = total = missing = 0
    west, south, east, north = STUDY_BOUNDS
    files = sorted((ROOT / "datasets/lod2").glob("*.gml"))
    require(len(files) == 4, f"Expected four CityGML tiles, found {len(files)}")
    for index, filename in enumerate(files, 1):
        print(f"CityGML {index}/4: streaming {filename.name}", flush=True)
        for _, building in etree.iterparse(
            str(filename), events=("end",), tag=BUILDING_TAG,
            resolve_entities=False, no_network=True, huge_tree=True,
        ):
            total += 1
            identifier = building.get(GML_ID)
            if identifier not in seen:
                seen.add(identifier)
                point = footprint(building)
                if point is None:
                    missing += 1
                elif west <= point[0] <= east and south <= point[1] <= north:
                    eligible += 1
                    record = (identifier, *point)
                    if len(reservoir) < SAMPLE_COUNT:
                        reservoir.append(record)
                    else:
                        slot = rng.randrange(eligible)
                        if slot < SAMPLE_COUNT:
                            reservoir[slot] = record
            parent = building.getparent()
            building.clear()
            # Remove complete cityObjectMember siblings, not only Buildings.
            if parent is not None and etree.QName(parent).localname == "cityObjectMember":
                parent.clear()
                while parent.getprevious() is not None:
                    del parent.getparent()[0]
            else:
                while building.getprevious() is not None:
                    del parent[0]
        print(f"CityGML {index}/4 done: {total:,} parsed, {eligible:,} eligible", flush=True)
    require(len(reservoir) == SAMPLE_COUNT, f"Only {len(reservoir)} eligible ground samples")
    print(f"Reservoir: {SAMPLE_COUNT} unique buildings; {missing} missing footprints", flush=True)
    return reservoir


def verify_source_projection(elevation, metadata, inverse):
    """Compare delivered heights to original DGM cells, without the builder."""
    mosaic = np.empty((3000, 3000), dtype=np.float32)
    for x in range(649, 652):
        for y in range(5478, 5481):
            with Image.open(ROOT / f"datasets/dgm1/{x}_{y}.tif") as image:
                tile = np.asarray(image)
                require(tile.shape == (1000, 1000), "Unexpected source DGM shape")
                row, col = (5480 - y) * 1000, (x - 649) * 1000
                mosaic[row:row + 1000, col:col + 1000] = tile
    require(np.all(np.isfinite(mosaic)) and np.all(mosaic > 0), "Invalid source elevations")
    require(metadata["baseElevation"] == math.floor(float(mosaic[100:2200, 600:2700].min())), "Incorrect baseElevation")
    height, width = elevation.shape
    # Test actual output centers across the whole asset, including outer corners.
    cols, rows = np.meshgrid(np.linspace(0, width - 1, 25).astype(int), np.linspace(0, height - 1, 25).astype(int))
    west, south, east, north = metadata["bounds"]
    lng = west + (cols + 0.5) / width * (east - west)
    lat = north - (rows + 0.5) / height * (north - south)
    x, y = inverse.transform(lng, lat)
    reference = interpolate(mosaic, x - 649000 - 0.5, 5481000 - y - 0.5)
    errors = np.abs(elevation[rows, cols] + metadata["baseElevation"] - reference)
    require(float(errors.max()) <= 1 / 256 + 0.0001, f"Inverse mapping / Terrarium error {errors.max():.4f} m")
    print(f"DGM inverse mapping: 625 pixels, maximum error {errors.max():.5f} m", flush=True)


def verify_texture(texture, metadata, inverse):
    """Compare output JPEG pixels to inverse-projected source aerial samples."""
    height, width = texture.shape[:2]
    cols, rows = np.meshgrid(np.linspace(20, width - 21, 17).astype(int), np.linspace(20, height - 21, 17).astype(int))
    west, south, east, north = metadata["bounds"]
    x, y = inverse.transform(west + (cols + 0.5) / width * (east - west), north - (rows + 0.5) / height * (north - south))
    errors = []
    for filename in sorted((ROOT / "datasets/dop20").glob("dop20_*.jpg")):
        x0, y0, x1, y1 = map(float, filename.stem.removeprefix("dop20_").split("_"))
        inside = (x > x0 + 1) & (x < x1 - 1) & (y > y0 + 1) & (y < y1 - 1)
        with Image.open(filename) as image:
            reference = interpolate(np.asarray(image.convert("RGB")), (x[inside] - x0) * 4 - 0.5, (y1 - y[inside]) * 4 - 0.5)
        errors.extend(np.mean(np.abs(texture[rows[inside], cols[inside]].astype(float) - reference), axis=1))
    require(len(errors) >= 200, "Insufficient aerial alignment samples")
    median = float(np.median(errors))
    require(median < 15, f"Texture/source alignment error {median:.2f} RGB levels")
    print(f"Aerial inverse mapping: {len(errors)} samples, median error {median:.2f} RGB levels", flush=True)


def main():
    started = time.monotonic()
    metadata = json.loads((OUTPUT / "terrain.json").read_text(encoding="utf-8"))
    bounds = metadata["bounds"]
    require(len(bounds) == 4 and np.all(np.isfinite(bounds)), "Invalid WGS84 bounds")
    west, south, east, north = bounds
    require(-180 <= west < east <= 180 and -90 <= south < north <= 90, "Bounds are not WGS84")
    osm = json.loads((ROOT / "datasets/osm/altstadt.json").read_text(encoding="utf-8"))
    station = next((element for element in osm["elements"] if element.get("type") == "node" and element.get("id") == 60115950), None)
    require(station is not None, "Lorenzkirche station node 60115950 is missing from source OSM")
    require(west < station["lon"] < east and south < station["lat"] < north, "Lorenzkirche station point is outside bounds")
    del osm
    require(metadata["baseElevation"] == math.floor(metadata["baseElevation"]), "Base elevation is not integral")
    require(metadata["elevationDecoder"] == {"rScaler": 256, "gScaler": 1, "bScaler": 1 / 256, "offset": -32768}, "Unexpected Terrarium decoder")
    require(metadata["pixelOrigin"] == "center" and metadata["rowOrder"] == "north-to-south", "Unsupported raster layout")
    forward = Transformer.from_crs(25832, 4326, always_xy=True)
    inverse = Transformer.from_crs(4326, 25832, always_xy=True)
    x0, y0, x1, y1 = STUDY_BOUNDS
    for x, y in ((x0, y0), (x0, y1), (x1, y0), (x1, y1)):
        lng, lat = forward.transform(x, y)
        require(west - 1e-12 <= lng <= east + 1e-12 and south - 1e-12 <= lat <= north + 1e-12, "Bounds crop a study corner")
    with Image.open(OUTPUT / "elevation.png") as image:
        require(image.mode == "RGB" and max(image.size) == 2048, "Elevation must be a 2048 px RGB PNG")
        require(image.size == (metadata["elevation"]["width"], metadata["elevation"]["height"]), "Elevation size differs from metadata")
        rgb = np.asarray(image).astype(np.float32)
    decoder = metadata["elevationDecoder"]
    elevation = rgb[..., 0] * decoder["rScaler"] + rgb[..., 1] * decoder["gScaler"] + rgb[..., 2] * decoder["bScaler"] + decoder["offset"]
    del rgb
    with Image.open(OUTPUT / "texture.jpg") as image:
        require(image.mode == "RGB" and max(image.size) == 4096, "Texture must be a 4096 px RGB JPEG")
        require(image.size == (metadata["texture"]["width"], metadata["texture"]["height"]), "Texture size differs from metadata")
        texture = np.asarray(image)
    grid_meta = metadata["heightGrid"]
    require(grid_meta["dtype"] == "float32" and grid_meta["endianness"] == "little" and grid_meta["relativeToBaseElevation"], "Unsupported height grid encoding")
    require(grid_meta["layout"] == "row-major" and grid_meta["rowOrder"] == "north-to-south" and grid_meta["pixelOrigin"] == "center", "Unsupported height grid layout")
    require(all(0 < size <= 4 for size in grid_meta["cellSizeMeters"]), "Camera grid exceeds 4 m cells")
    require((OUTPUT / "heightgrid.bin").stat().st_size == grid_meta["width"] * grid_meta["height"] * 4, "Height grid byte length mismatch")
    height_grid = np.fromfile(OUTPUT / "heightgrid.bin", dtype="<f4").reshape(grid_meta["height"], grid_meta["width"])
    require(np.all(np.isfinite(height_grid)), "Height grid has missing values")
    require((metadata["texture"]["width"] / metadata["elevation"]["width"], metadata["texture"]["height"] / metadata["elevation"]["height"]) == (2, 2), "Elevation and texture aspect ratios differ")
    # Hidden directories can hold a temporary offline uv cache during a build.
    assets = [f for f in OUTPUT.rglob("*") if f.is_file() and not any(part.startswith(".") for part in f.relative_to(OUTPUT).parts)]
    total_size = sum(f.stat().st_size for f in assets)
    require(total_size < 20_000_000, f"Terrain directory exceeds 20 MB: {total_size:,} bytes")
    print(f"Assets: {total_size:,} bytes; Lorenzkirche inside bounds; PNG/JPEG/grid shapes valid", flush=True)
    verify_source_projection(elevation, metadata, inverse)
    verify_texture(texture, metadata, inverse)
    del texture
    samples = building_samples()
    points = np.array([sample[1:] for sample in samples])
    lng, lat = forward.transform(points[:, 0], points[:, 1])
    for label, grid in (("Terrarium PNG", elevation), ("4 m camera grid", height_grid)):
        sampled = terrain_sample(grid, bounds, lng, lat) + metadata["baseElevation"]
        errors = np.abs(points[:, 2] - sampled)
        median = float(np.median(errors))
        print(f"{label}: 200 buildings, median |groundZ - terrain| = {median:.4f} m; p95 = {np.percentile(errors, 95):.4f} m; max = {errors.max():.4f} m", flush=True)
        require(median < 0.5, f"{label}: building ground median {median:.4f} m must be below 0.5 m")
    print(f"PASS: P2 data checks completed in {time.monotonic() - started:.1f} s. 1600 x 900 render deferred to S1.", flush=True)


if __name__ == "__main__":
    main()

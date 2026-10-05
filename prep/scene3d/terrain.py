#!/usr/bin/env python3
"""Build inverse-mapped WGS84 terrain assets without GDAL.

Run from any directory with:
  uv run --with lxml --with numpy --with pyproj --with pillow --with tifffile python prep/scene3d/terrain.py

Elevation pixels are loader vertices (i/width, j/height); texture pixels are
area centers ((i+0.5)/width, (j+0.5)/height). Rows run north to south.
The PNG and little-endian Float32 height grid hold meters above baseElevation.
The JPEG extends the nearest source edge into the small uncovered corners of
the enclosing WGS84 rectangle. No extension occurs inside the UTM study bbox.
"""

from dataclasses import dataclass
import json
import math
from pathlib import Path
import time

from lxml import etree
import numpy as np
from PIL import Image
from pyproj import Geod, Transformer
import tifffile


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "public/data/terrain"
STUDY_BOUNDS = (649600.0, 5478800.0, 651700.0, 5480900.0)
DECODER = {"rScaler": 256, "gScaler": 1, "bScaler": 1 / 256, "offset": -32768}
CHUNK_ROWS = 128
BOX_FACTOR = 3
BLDG = "{http://www.opengis.net/citygml/building/1.0}"
GML = "{http://www.opengis.net/gml}"


@dataclass
class Raster:
    data: np.ndarray
    bounds: tuple[float, float, float, float]

    def sample(self, x, y, *, extend_edges=False):
        west, south, east, north = self.bounds
        height, width = self.data.shape[:2]
        cols = (x - west) * width / (east - west) - 0.5
        rows = (north - y) * height / (north - south) - 0.5
        return bilinear(self.data, cols, rows, extend_edges=extend_edges)


def bilinear(data, cols, rows, *, extend_edges=False):
    """Interpolate center-indexed raster coordinates; clamp only when requested."""
    height, width = data.shape[:2]
    if not np.all(np.isfinite(cols)) or not np.all(np.isfinite(rows)):
        raise ValueError("Non-finite inverse projection")
    if not extend_edges and (
        np.any(cols < 0) or np.any(cols > width - 1)
        or np.any(rows < 0) or np.any(rows > height - 1)
    ):
        raise ValueError("Target grid extends outside source raster centers")
    cols = np.clip(cols, 0, width - 1)
    rows = np.clip(rows, 0, height - 1)
    x0, y0 = np.floor(cols).astype(np.intp), np.floor(rows).astype(np.intp)
    x1, y1 = np.minimum(x0 + 1, width - 1), np.minimum(y0 + 1, height - 1)
    fx, fy = (cols - x0).astype(np.float32), (rows - y0).astype(np.float32)
    if data.ndim == 3:
        fx, fy = fx[..., None], fy[..., None]
    top = data[y0, x0].astype(np.float32) * (1 - fx) + data[y0, x1] * fx
    bottom = data[y1, x0].astype(np.float32) * (1 - fx) + data[y1, x1] * fx
    return top * (1 - fy) + bottom * fy


def load_dgm():
    files = sorted((ROOT / "datasets/dgm1").glob("*.tif"))
    if len(files) != 9:
        raise ValueError(f"Expected nine DGM1 tiles; found {len(files)}")
    tiles = []
    for index, filename in enumerate(files, 1):
        with tifffile.TiffFile(filename) as tif:
            page = tif.pages[0]
            geo = tif.geotiff_metadata
            if page.shape != (1000, 1000) or page.dtype != np.dtype("float32"):
                raise ValueError(f"Unexpected DGM shape/type: {filename.name}")
            if geo["ProjectedCSTypeGeoKey"] != 25832 or geo["GTRasterTypeGeoKey"] != 1:
                raise ValueError(f"Expected EPSG:25832 pixel-area raster: {filename.name}")
            sx, sy, _ = page.tags["ModelPixelScaleTag"].value
            i, j, _, x, y, _ = page.tags["ModelTiepointTag"].value
            if (sx, sy) != (1, 1):
                raise ValueError(f"Expected 1 m DGM pixels: {filename.name}")
            west, north = x - i * sx, y + j * sy
            nodata = float(page.tags["GDAL_NODATA"].value) if "GDAL_NODATA" in page.tags else None
            # Pillow's libtiff handles LZW float TIFFs without imagecodecs.
            if page.compression == 1:
                pixels = page.asarray()
            else:
                with Image.open(filename) as image:
                    pixels = np.array(image, dtype=np.float32)
            if not np.all(np.isfinite(pixels)) or (nodata is not None and np.any(pixels == nodata)):
                raise ValueError(f"DGM tile contains missing heights: {filename.name}")
            tiles.append((west, north, pixels))
        print(f"DGM {index}/9: {filename.name}", flush=True)
    west = min(tile[0] for tile in tiles)
    east = max(tile[0] + 1000 for tile in tiles)
    north = max(tile[1] for tile in tiles)
    south = min(tile[1] - 1000 for tile in tiles)
    if (east - west, north - south) != (3000, 3000):
        raise ValueError("DGM tiles do not span a 3000 x 3000 m mosaic")
    mosaic = np.full((3000, 3000), np.nan, dtype=np.float32)
    for x, y, pixels in tiles:
        col, row = int(x - west), int(north - y)
        if (col, row) != (x - west, north - y):
            raise ValueError("DGM tiles are not aligned to the 1 m grid")
        if np.any(np.isfinite(mosaic[row:row + 1000, col:col + 1000])):
            raise ValueError("DGM tiles overlap")
        mosaic[row:row + 1000, col:col + 1000] = pixels
    if not np.all(np.isfinite(mosaic)):
        raise ValueError("DGM mosaic has holes")
    return Raster(mosaic, (west, south, east, north))


def load_dop():
    files = sorted((ROOT / "datasets/dop20").glob("dop20_*.jpg"))
    if len(files) != 4:
        raise ValueError(f"Expected four DOP20 quadrants; found {len(files)}")
    west, south, east, north = STUDY_BOUNDS
    mosaic = np.empty((8400, 8400, 3), dtype=np.uint8)
    occupied = set()
    for index, filename in enumerate(files, 1):
        x0, y0, x1, y1 = map(float, filename.stem.removeprefix("dop20_").split("_"))
        if (x1 - x0, y1 - y0) != (1050, 1050):
            raise ValueError(f"Unexpected DOP bbox: {filename.name}")
        col, row = int((x0 - west) * 4), int((north - y1) * 4)
        if (col, row) not in {(0, 0), (0, 4200), (4200, 0), (4200, 4200)}:
            raise ValueError(f"DOP tile outside study bbox: {filename.name}")
        if (col, row) in occupied:
            raise ValueError("Duplicate DOP quadrant")
        occupied.add((col, row))
        with Image.open(filename) as image:
            if image.size != (4200, 4200):
                raise ValueError(f"Unexpected DOP dimensions: {filename.name}")
            mosaic[row:row + 4200, col:col + 4200] = np.asarray(image.convert("RGB"))
        print(f"DOP {index}/4: {filename.name}", flush=True)
    return Raster(mosaic, STUDY_BOUNDS)


def geographic_bounds():
    """Enclose every transformed study edge, including projection curvature."""
    forward = Transformer.from_crs(25832, 4326, always_xy=True)
    west, south, east, north = STUDY_BOUNDS
    xs, ys = np.linspace(west, east, 257), np.linspace(south, north, 257)
    x = np.concatenate((xs, xs, np.full_like(ys, west), np.full_like(ys, east)))
    y = np.concatenate((np.full_like(xs, south), np.full_like(xs, north), ys, ys))
    lng, lat = forward.transform(x, y)
    return (float(lng.min()), float(lat.min()), float(lng.max()), float(lat.max()))


def physical_size(bounds):
    west, south, east, north = bounds
    geod = Geod(ellps="WGS84")
    width = max(geod.inv(west, lat, east, lat)[2] for lat in (south, north))
    height = max(geod.inv(lng, south, lng, north)[2] for lng in (west, east))
    return width, height


def dimensions(size_m, long_side):
    scale = long_side / max(size_m)
    return tuple(max(2, round(length * scale)) for length in size_m)


def warp(source, bounds, size, inverse, *, extend_edges=False, origin=0.5, label):
    """Inverse-project loader vertices or area centers before source sampling."""
    width, height = size
    west, south, east, north = bounds
    lng = west + (np.arange(width) + origin) * (east - west) / width
    lat = north - (np.arange(height) + origin) * (north - south) / height
    shape = (height, width) + source.data.shape[2:]
    result = np.empty(shape, dtype=source.data.dtype)
    for row in range(0, height, CHUNK_ROWS):
        stop = min(row + CHUNK_ROWS, height)
        lng_grid, lat_grid = np.meshgrid(lng, lat[row:stop])
        x, y = inverse.transform(lng_grid, lat_grid)
        sampled = source.sample(x, y, extend_edges=extend_edges)
        if result.dtype == np.uint8:
            sampled = np.clip(np.rint(sampled), 0, 255)
        result[row:stop] = sampled
        print(f"{label}: {stop}/{height} rows", flush=True)
    return result


def box_texture(source, bounds, size, inverse):
    """Area-average a 3x inverse warp before decimation, without a huge raster.

    Each target texel averages nine equal-area subtexel centers in WGS84.
    Filtering precedes rounding and JPEG encoding; no point-decimation occurs.
    """
    width, height = size
    west, south, east, north = bounds
    subcols = (np.arange(width * BOX_FACTOR) + 0.5) / BOX_FACTOR
    lng = west + subcols * (east - west) / width
    result = np.empty((height, width, 3), dtype=np.uint8)
    for row in range(0, height, 32):
        stop = min(row + 32, height)
        subrows = row + (np.arange((stop - row) * BOX_FACTOR) + 0.5) / BOX_FACTOR
        lat = north - subrows * (north - south) / height
        x, y = inverse.transform(*np.meshgrid(lng, lat))
        samples = source.sample(x, y, extend_edges=True)
        average = samples.reshape(stop - row, BOX_FACTOR, width, BOX_FACTOR, 3).mean(axis=(1, 3))
        result[row:stop] = np.clip(np.rint(average), 0, 255)
        if stop % 128 == 0 or stop == height:
            print(f"Texture box filter: {stop}/{height} rows", flush=True)
    return result


def max_ground_grid(source, bounds, size, forward):
    """Pool every DGM cell into every camera cell touched by its full area.

    Bounding transformed cell corners slightly overestimates curved edges.
    A one-cell halo is applied later to protect bilinear camera consumers.
    """
    width, height = size
    west, south, east, north = bounds
    sw, _, _, sn = source.bounds
    grid = np.full((height, width), -np.inf, dtype=np.float32)
    source_height, source_width = source.data.shape
    for row in range(0, source_height, CHUNK_ROWS):
        stop = min(row + CHUNK_ROWS, source_height)
        x, y = np.meshgrid(sw + np.arange(source_width), sn - np.arange(row, stop))
        columns, rows = [], []
        for dx, dy in ((0, 0), (1, 0), (0, -1), (1, -1)):
            lng, lat = forward.transform(x + dx, y + dy)
            columns.append((lng - west) / (east - west) * width)
            rows.append((north - lat) / (north - south) * height)
        c0, c1 = np.floor(np.min(columns, axis=0)).astype(int), np.floor(np.max(columns, axis=0)).astype(int)
        r0, r1 = np.floor(np.min(rows, axis=0)).astype(int), np.floor(np.max(rows, axis=0)).astype(int)
        if np.any(c1 - c0 > 1) or np.any(r1 - r0 > 1):
            raise ValueError("DGM cells exceed the camera grid pooling stencil")
        values = source.data[row:stop]
        for cols, rows_ in ((c0, r0), (c1, r0), (c0, r1), (c1, r1)):
            valid = (cols >= 0) & (cols < width) & (rows_ >= 0) & (rows_ < height)
            np.maximum.at(grid, (rows_[valid], cols[valid]), values[valid])
        print(f"Ground max pool: {stop}/{source_height} source rows", flush=True)
    if not np.all(np.isfinite(grid)):
        raise ValueError("Camera grid has cells without DGM coverage")
    return grid


def burn_ring(grid, points, top, bounds, forward):
    """Conservatively burn all cells intersecting a footprint exterior."""
    height, width = grid.shape
    west, south, east, north = bounds
    lng, lat = forward.transform(points[:, 0], points[:, 1])
    ring = np.column_stack(((lng - west) / (east - west) * width,
                            (north - lat) / (north - south) * height))
    lo = np.maximum(np.floor(ring.min(axis=0)).astype(int), 0)
    hi = np.minimum(np.floor(ring.max(axis=0)).astype(int), (width - 1, height - 1))
    if np.any(lo > hi):
        return
    cols, rows = np.meshgrid(np.arange(lo[0], hi[0] + 1), np.arange(lo[1], hi[1] + 1))
    inside = np.zeros(cols.shape, dtype=bool)
    touched = np.zeros_like(inside)
    for a, b in zip(ring, np.roll(ring, -1, axis=0)):
        if a[1] != b[1]:
            crossing = (a[1] > rows + 0.5) != (b[1] > rows + 0.5)
            inside ^= crossing & (cols + 0.5 < a[0] + (rows + 0.5 - a[1]) * (b[0] - a[0]) / (b[1] - a[1]))
        # Segment/closed-cell intersection via parameter interval clipping.
        t0, t1 = np.zeros(cols.shape), np.ones(cols.shape)
        valid = np.ones(cols.shape, dtype=bool)
        for axis, cell in enumerate((cols, rows)):
            delta = b[axis] - a[axis]
            if abs(delta) < 1e-12:
                valid &= (cell <= a[axis]) & (a[axis] <= cell + 1)
            else:
                entry, leave = (cell - a[axis]) / delta, (cell + 1 - a[axis]) / delta
                t0 = np.maximum(t0, np.minimum(entry, leave))
                t1 = np.minimum(t1, np.maximum(entry, leave))
        touched |= valid & (t0 <= t1)
    view = grid[lo[1]:hi[1] + 1, lo[0]:hi[0] + 1]
    np.maximum(view, top, out=view, where=inside | touched)


def burn_buildings(grid, bounds, base, forward):
    """Read original LoD2 tops independently of the generated P1 asset."""
    count = 0
    seen = set()
    for index, filename in enumerate(sorted((ROOT / "datasets/lod2").glob("*.gml")), 1):
        for _, building in etree.iterparse(str(filename), events=("end",), tag=BLDG + "Building",
                                           resolve_entities=False, no_network=True, huge_tree=True):
            identifier = building.get(GML + "id")
            if identifier not in seen:
                seen.add(identifier)
                rings = building.findall(".//" + BLDG + "GroundSurface//" + GML + "exterior/" + GML + "LinearRing/" + GML + "posList")
                points = [np.fromstring(r.text or "", sep=" ").reshape(-1, 3) for r in rings]
                if not points:
                    solid = building.findall(".//" + BLDG + "lod2Solid//" + GML + "posList")
                    candidates = [np.fromstring(r.text or "", sep=" ").reshape(-1, 3) for r in solid]
                    if candidates:
                        # Lowest mean-z face selects the ground, not a wall.
                        points = [min(candidates, key=lambda p: float(p[:, 2].mean()))]
                if points:
                    ground = min(float(p[:, 2].min()) for p in points)
                    measured = building.findtext(BLDG + "measuredHeight")
                    if measured is None:
                        all_z = [np.fromstring(r.text or "", sep=" ").reshape(-1, 3)[:, 2]
                                 for r in building.findall(".//" + GML + "posList")]
                        measured = max(float(z.max()) for z in all_z) - ground
                    top = ground + float(measured) - base
                    if not math.isfinite(top) or float(measured) < 0:
                        raise ValueError(f"Invalid building height: {identifier}")
                    for ring in points:
                        burn_ring(grid, ring, top, bounds, forward)
                    count += 1
            parent = building.getparent()
            building.clear()
            if parent is not None and etree.QName(parent).localname == "cityObjectMember":
                parent.clear()
                while parent.getprevious() is not None:
                    del parent.getparent()[0]
        print(f"Building tops {index}/4: {count:,} unique buildings processed", flush=True)
    if count < 7085:
        raise ValueError("Insufficient LoD2 camera obstacles")
    # Interpolation at a footprint boundary can use an adjacent cell center.
    # This maximum halo keeps all four bilinear contributors above the obstacle.
    padded = np.pad(grid, 1, mode="edge")
    return np.maximum.reduce([padded[y:y + grid.shape[0], x:x + grid.shape[1]]
                              for y in range(3) for x in range(3)]), count


def base_elevation(source):
    west, south, east, north = source.bounds
    x0, y0, x1, y1 = STUDY_BOUNDS
    cols = west + np.arange(source.data.shape[1]) + 0.5
    rows = north - np.arange(source.data.shape[0]) - 0.5
    values = source.data[np.ix_((rows >= y0) & (rows <= y1), (cols >= x0) & (cols <= x1))]
    return math.floor(float(values.min()))


def terrarium(heights):
    encoded = np.rint((heights.astype(np.float64) + 32768) * 256)
    if not np.all(np.isfinite(encoded)) or np.any(encoded < 0) or np.any(encoded > 0xFFFFFF):
        raise ValueError("Heights fall outside the Terrarium encoding range")
    encoded = encoded.astype(np.uint32)
    return np.stack((encoded >> 16, (encoded >> 8) & 255, encoded & 255), axis=-1).astype(np.uint8)


def main():
    started = time.monotonic()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    source = load_dgm()
    coverage = geographic_bounds()
    elevation_size = dimensions(physical_size(coverage), 2048)
    # Bounds delimit the loader's i/width mesh, not the first/last image centers.
    # Pad the study envelope by half a vertex spacing so every study corner is
    # covered after changing elevation samples from area centers to vertices.
    w, s, e, n = coverage
    dx, dy = (e - w) / elevation_size[0], (n - s) / elevation_size[1]
    bounds = (w - dx / 2, s - dy / 2, e + dx / 2, n + dy / 2)
    size_m = physical_size(bounds)
    base = base_elevation(source)
    inverse = Transformer.from_crs(4326, 25832, always_xy=True)
    forward = Transformer.from_crs(25832, 4326, always_xy=True)
    texture_size = tuple(length * 2 for length in elevation_size)
    # Pixel-area centers; both physical cell sizes are at most 4 m.
    height_size = tuple(math.ceil(length / 4) for length in size_m)
    print(f"Bounds {bounds}; baseElevation {base} m", flush=True)
    heights = warp(source, bounds, elevation_size, inverse, origin=0, label="Elevation vertices") - base
    Image.fromarray(terrarium(heights)).save(OUTPUT / "elevation.png", compress_level=9)
    print(f"Wrote elevation.png {elevation_size}", flush=True)
    height_grid = max_ground_grid(source, bounds, height_size, forward) - base
    height_grid, building_count = burn_buildings(height_grid, bounds, base, forward)
    height_grid.astype("<f4").tofile(OUTPUT / "heightgrid.bin")
    del source, heights, height_grid
    aerial = load_dop()
    texture = box_texture(aerial, bounds, texture_size, inverse)
    Image.fromarray(texture).save(OUTPUT / "texture.jpg", quality=82, optimize=True)
    del aerial, texture
    metadata = {
        "bounds": list(bounds),
        "baseElevation": base,
        "elevationDecoder": DECODER,
        "crs": "EPSG:4326",
        "sourceCrs": "EPSG:25832",
        "verticalDatum": "DHHN2016",
        "sourceBounds": list(STUDY_BOUNDS),
        "pixelOrigin": "loader-vertex",
        "rowOrder": "north-to-south",
        "studyGeographicBounds": list(coverage),
        "meshConvention": {
            "loader": "@loaders.gl/terrain getMeshAttributes",
            "longitude": "west + i * (east - west) / width",
            "latitude": "north - j * (north - south) / height",
            "uv": "[i / width, j / height]",
            "border": "martini duplicates the last row/column at height/width",
        },
        "elevation": {"url": "/data/terrain/elevation.png", "width": elevation_size[0], "height": elevation_size[1],
                      "pixelOrigin": "loader-vertex"},
        "texture": {
            "url": "/data/terrain/texture.jpg", "width": texture_size[0], "height": texture_size[1],
            "quality": 82, "outsideSourceBounds": "nearest-edge extension",
            "pixelOrigin": "center", "filter": "box", "supersampling": BOX_FACTOR,
        },
        "heightGrid": {
            "url": "/data/terrain/heightgrid.bin", "width": height_size[0], "height": height_size[1],
            "dtype": "float32", "endianness": "little", "layout": "row-major",
            "rowOrder": "north-to-south", "pixelOrigin": "center", "units": "meters",
            "relativeToBaseElevation": True,
            "cellSizeMeters": [size_m[0] / height_size[0], size_m[1] / height_size[1]],
            "aggregation": "maximum of intersecting DGM1 cells and LoD2 building tops",
            "buildingTop": "groundZ + measuredHeight - baseElevation",
            "buildingCount": building_count, "safetyHaloCells": 1,
            "sampling": "cell lookup or bilinear; conservative maximum halo",
        },
        "attribution": "Datenquelle: Bayerische Vermessungsverwaltung – www.geodaten.bayern.de, CC BY 4.0",
    }
    (OUTPUT / "terrain.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    total = sum(f.stat().st_size for f in OUTPUT.rglob("*") if f.is_file())
    print(f"Wrote four terrain assets: {total:,} bytes in {time.monotonic() - started:.1f} s", flush=True)


if __name__ == "__main__":
    main()

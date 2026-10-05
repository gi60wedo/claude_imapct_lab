#!/usr/bin/env python3
"""Build inverse-mapped WGS84 terrain assets without GDAL.

Run from any directory with:
  uv run --with lxml --with numpy --with pyproj --with pillow --with tifffile python prep/scene3d/terrain.py

All rasters use pixel centers, west-to-east columns and north-to-south rows.
The PNG and little-endian Float32 height grid hold meters above baseElevation.
The JPEG extends the nearest source edge into the small uncovered corners of
the enclosing WGS84 rectangle. No extension occurs inside the UTM study bbox.
"""

from dataclasses import dataclass
import json
import math
from pathlib import Path
import time

import numpy as np
from PIL import Image
from pyproj import Geod, Transformer
import tifffile


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "public/data/terrain"
STUDY_BOUNDS = (649600.0, 5478800.0, 651700.0, 5480900.0)
DECODER = {"rScaler": 256, "gScaler": 1, "bScaler": 1 / 256, "offset": -32768}
CHUNK_ROWS = 128


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


def warp(source, bounds, size, inverse, *, extend_edges=False, label):
    """Inverse-project each regular WGS84 target center before source sampling."""
    width, height = size
    west, south, east, north = bounds
    lng = west + (np.arange(width) + 0.5) * (east - west) / width
    lat = north - (np.arange(height) + 0.5) * (north - south) / height
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
    bounds = geographic_bounds()
    size_m = physical_size(bounds)
    base = base_elevation(source)
    inverse = Transformer.from_crs(4326, 25832, always_xy=True)
    elevation_size = dimensions(size_m, 2048)
    texture_size = tuple(length * 2 for length in elevation_size)
    # Pixel-area centers; both physical cell sizes are at most 4 m.
    height_size = tuple(math.ceil(length / 4) for length in size_m)
    print(f"Bounds {bounds}; baseElevation {base} m", flush=True)
    heights = warp(source, bounds, elevation_size, inverse, label="Elevation") - base
    Image.fromarray(terrarium(heights)).save(OUTPUT / "elevation.png", compress_level=9)
    print(f"Wrote elevation.png {elevation_size}", flush=True)
    height_grid = warp(source, bounds, height_size, inverse, label="Height grid") - base
    height_grid.astype("<f4").tofile(OUTPUT / "heightgrid.bin")
    del source, heights, height_grid
    aerial = load_dop()
    texture = warp(aerial, bounds, texture_size, inverse, extend_edges=True, label="Texture")
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
        "pixelOrigin": "center",
        "rowOrder": "north-to-south",
        "elevation": {"url": "/data/terrain/elevation.png", "width": elevation_size[0], "height": elevation_size[1]},
        "texture": {
            "url": "/data/terrain/texture.jpg", "width": texture_size[0], "height": texture_size[1],
            "quality": 82, "outsideSourceBounds": "nearest-edge extension",
        },
        "heightGrid": {
            "url": "/data/terrain/heightgrid.bin", "width": height_size[0], "height": height_size[1],
            "dtype": "float32", "endianness": "little", "layout": "row-major",
            "rowOrder": "north-to-south", "pixelOrigin": "center", "units": "meters",
            "relativeToBaseElevation": True,
            "cellSizeMeters": [size_m[0] / height_size[0], size_m[1] / height_size[1]],
        },
        "attribution": "Datenquelle: Bayerische Vermessungsverwaltung – www.geodaten.bayern.de, CC BY 4.0",
    }
    (OUTPUT / "terrain.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    total = sum((OUTPUT / name).stat().st_size for name in ("elevation.png", "texture.jpg", "terrain.json", "heightgrid.bin"))
    print(f"Wrote four terrain assets: {total:,} bytes in {time.monotonic() - started:.1f} s", flush=True)


if __name__ == "__main__":
    main()

"""Triangulate the LoD2 roof surfaces of every building in buildings3d.json.

Run with uv run --with lxml --with numpy --with pyproj python prep/scene3d/lod2_roofs.py.
Each bldg:RoofSurface polygon (exterior plus interiors) is ear-clipped in its own
plane, transformed EPSG:25832 -> EPSG:4326 and then into the renderer's local
tangent-plane frame. The binary layout is documented in public/data/roofs3d.README.md.
"""

from __future__ import annotations

import json
import math
import sys
import time
from pathlib import Path

# Importing the sibling converter must not create an extra worktree file.
sys.dont_write_bytecode = True

import numpy as np
from lod2_buildings import BLDG, GML, ROOT, XLINK, iter_buildings
from pyproj import Transformer

FORMAT = "urbantwin-roofs3d/1"
EPSILON = 1e-10  # square metres; smaller doubled ear areas count as collinear
WGS84_A = 6378137.0
WGS84_E2 = 6.69437999014e-3


def local_frame(origin: tuple[float, float]) -> dict:
    """Match createLocalFrame in src/ui/three/geometry.ts exactly."""
    latitude = math.radians(origin[1])
    denominator = 1 - WGS84_E2 * math.sin(latitude) ** 2
    radians = math.pi / 180
    return {
        "lng": origin[0],
        "lat": origin[1],
        "eastPerDegree": radians * WGS84_A * math.cos(latitude) / math.sqrt(denominator),
        "northPerDegree": radians * WGS84_A * (1 - WGS84_E2) / denominator**1.5,
    }


def read_ring(element) -> np.ndarray | None:
    """Read an XYZ LinearRing without its closing vertex or repeated neighbours."""
    pos_list = element.find(GML + "posList")
    if pos_list is not None:
        values = np.fromstring(pos_list.text or "", sep=" ")
    else:
        values = np.array([v for p in element.findall(GML + "pos") for v in np.fromstring(p.text or "", sep=" ")])
    if values.size % 3 or not np.isfinite(values).all():
        raise ValueError("LoD2 roof ring must contain finite XYZ triples")
    points = values.reshape(-1, 3)
    if len(points) and np.array_equal(points[0], points[-1]):
        points = points[:-1]
    if len(points):
        keep = np.concatenate(([True], np.any(points[1:] != points[:-1], axis=1)))
        points = points[keep]
    if len(points) > 1 and np.array_equal(points[0], points[-1]):
        points = points[:-1]
    return points if len(points) >= 3 else None


def roof_polygons(building) -> list[list[np.ndarray]]:
    """Every RoofSurface polygon as [exterior, ...interiors], resolving local xlinks."""
    by_id = {p.get(GML + "id"): p for p in building.iter(GML + "Polygon") if p.get(GML + "id")}
    result = []
    for surface in building.iter(BLDG + "RoofSurface"):
        polygons = list(surface.iter(GML + "Polygon"))
        for member in surface.iter(GML + "surfaceMember"):
            reference = member.get(XLINK + "href", "")
            if reference.startswith("#") and reference[1:] in by_id:
                polygons.append(by_id[reference[1:]])
        for polygon in polygons:
            exterior = polygon.find(GML + "exterior/" + GML + "LinearRing")
            if exterior is None:
                continue
            outer = read_ring(exterior)
            if outer is None:
                continue
            holes = [read_ring(r) for r in polygon.findall(GML + "interior/" + GML + "LinearRing")]
            result.append([outer] + [h for h in holes if h is not None])
    return result


def newell_normal(points: np.ndarray) -> np.ndarray:
    following = np.roll(points, -1, axis=0)
    return np.array([
        np.sum((points[:, 1] - following[:, 1]) * (points[:, 2] + following[:, 2])),
        np.sum((points[:, 2] - following[:, 2]) * (points[:, 0] + following[:, 0])),
        np.sum((points[:, 0] - following[:, 0]) * (points[:, 1] + following[:, 1])),
    ])


def area2(ring: list[tuple[float, float]]) -> float:
    return sum(ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1] for i in range(len(ring)))


def cross(o, a, b) -> float:
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def segments_cross(a, b, c, d) -> bool:
    """Proper crossing of two segments; shared endpoints and touches do not count."""
    d1, d2 = cross(c, d, a), cross(c, d, b)
    d3, d4 = cross(a, b, c), cross(a, b, d)
    return ((d1 > EPSILON and d2 < -EPSILON) or (d1 < -EPSILON and d2 > EPSILON)) and (
        (d3 > EPSILON and d4 < -EPSILON) or (d3 < -EPSILON and d4 > EPSILON)
    )


def bridge_holes(outer: list[int], holes: list[list[int]], xy: list[tuple[float, float]]) -> list[int]:
    """Splice each hole into the outer ring through the nearest unobstructed vertex."""
    merged = list(outer)
    pending = sorted(holes, key=lambda hole: -max(xy[i][0] for i in hole))
    while pending:
        hole = pending.pop(0)
        start = max(range(len(hole)), key=lambda k: (xy[hole[k]][0], -k))
        m = xy[hole[start]]
        edges = [(merged[k - 1], merged[k]) for k in range(len(merged))]
        edges += [(ring[k - 1], ring[k]) for ring in [hole] + pending for k in range(len(ring))]
        order = sorted(range(len(merged)), key=lambda k: ((xy[merged[k]][0] - m[0]) ** 2 + (xy[merged[k]][1] - m[1]) ** 2, k))
        chosen = order[0]
        for k in order:
            p = xy[merged[k]]
            if not any(segments_cross(m, p, xy[a], xy[b]) for a, b in edges):
                chosen = k
                break
        rotated = hole[start:] + hole[: start + 1]
        merged = merged[: chosen + 1] + rotated + merged[chosen:]
    return merged


def in_triangle(p, a, b, c) -> bool:
    return cross(a, b, p) >= -EPSILON and cross(b, c, p) >= -EPSILON and cross(c, a, p) >= -EPSILON


def ear_clip(ring: list[int], xy: list[tuple[float, float]]) -> tuple[list[tuple[int, int, int]], bool]:
    """Counter-clockwise ear clipping; returns triangles and whether a forced cut occurred."""
    triangles = []
    ring = list(ring)
    forced = False
    while len(ring) > 3:
        n = len(ring)
        clipped = False
        for k in range(n):
            ia, ib, ic = ring[k - 1], ring[k], ring[(k + 1) % n]
            a, b, c = xy[ia], xy[ib], xy[ic]
            turn = cross(a, b, c)
            if abs(turn) <= EPSILON:
                # Collinear or doubled-back vertex: drop it without a triangle.
                ring.pop(k)
                clipped = True
                break
            if turn < 0:
                continue
            corners = {a, b, c}
            if any(
                xy[j] not in corners and in_triangle(xy[j], a, b, c)
                for j in ring
                if j not in (ia, ib, ic)
            ):
                continue
            triangles.append((ia, ib, ic))
            ring.pop(k)
            clipped = True
            break
        if not clipped:
            # Self-touching input: cut the most convex corner rather than lose the face.
            forced = True
            k = max(range(n), key=lambda k: (cross(xy[ring[k - 1]], xy[ring[k]], xy[ring[(k + 1) % n]]), -k))
            triangles.append((ring[k - 1], ring[k], ring[(k + 1) % n]))
            ring.pop(k)
    if len(ring) == 3 and cross(xy[ring[0]], xy[ring[1]], xy[ring[2]]) > EPSILON:
        triangles.append(tuple(ring))
    return triangles, forced


def triangulate(rings: list[np.ndarray]) -> tuple[np.ndarray, list[tuple[int, int, int]], bool] | None:
    """Triangulate one planar polygon; triangles keep the exterior's outward winding."""
    points = np.vstack(rings)
    centred = points - points.mean(axis=0)
    normal = newell_normal(centred[: len(rings[0])])
    length = float(np.linalg.norm(normal))
    if length <= EPSILON:
        return None
    normal /= length
    axis = np.array([0.0, 0.0, 1.0]) if abs(normal[2]) < 0.9 else np.array([1.0, 0.0, 0.0])
    u = np.cross(axis, normal)
    u /= np.linalg.norm(u)
    v = np.cross(normal, u)
    # (u, v, normal) is right-handed, so the exterior is counter-clockwise in (u, v).
    xy = [(float(x), float(y)) for x, y in zip(centred @ u, centred @ v)]
    offsets = np.cumsum([0] + [len(r) for r in rings])
    indices = [list(range(offsets[i], offsets[i + 1])) for i in range(len(rings))]
    outer = indices[0]
    if area2([xy[i] for i in outer]) < 0:
        outer.reverse()
    holes = []
    for hole in indices[1:]:
        if area2([xy[i] for i in hole]) > 0:
            hole.reverse()
        holes.append(hole)
    triangles, forced = ear_clip(bridge_holes(outer, holes, xy), xy)
    return (points, triangles, forced) if triangles else None


def build(root: Path = ROOT) -> dict:
    started = time.perf_counter()
    document = json.loads((root / "public/data/buildings3d.json").read_text(encoding="utf-8"))
    terrain = json.loads((root / "public/data/terrain/terrain.json").read_text(encoding="utf-8"))
    base = float(document["baseElevation"])
    if base != terrain["baseElevation"]:
        raise ValueError("buildings3d.json and terrain.json disagree on baseElevation")
    order = [b["id"] for b in document["buildings"]]
    wanted = set(order)
    west, south, east, north = terrain["bounds"]
    frame = local_frame(((west + east) / 2, (south + north) / 2))
    project = Transformer.from_crs(25832, 4326, always_xy=True)

    tiles = sorted((root / "datasets/lod2").glob("*.gml"))
    if not tiles:
        raise FileNotFoundError("No datasets/lod2/*.gml tiles exist")
    meshes: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    polygons = forced = skipped = 0
    for number, tile in enumerate(tiles, start=1):
        tile_kept = 0
        for building in iter_buildings(tile):
            identifier = building.get(GML + "id")
            if identifier not in wanted or identifier in meshes:
                continue
            chunks, triangles, count = [], [], 0
            for rings in roof_polygons(building):
                polygons += 1
                result = triangulate(rings)
                if result is None:
                    skipped += 1
                    continue
                points, faces, was_forced = result
                forced += was_forced
                chunks.append(points)
                triangles.extend((a + count, b + count, c + count) for a, b, c in faces)
                count += len(points)
            if not chunks:
                continue
            utm = np.vstack(chunks)
            lng, lat = project.transform(utm[:, 0], utm[:, 1])
            local = np.column_stack((
                (np.asarray(lng) - frame["lng"]) * frame["eastPerDegree"],
                (np.asarray(lat) - frame["lat"]) * frame["northPerDegree"],
                utm[:, 2] - base,
            ))
            meshes[identifier] = (np.round(local, 3).astype("<f4"), np.asarray(triangles, dtype="<u4").reshape(-1))
            tile_kept += 1
        print(
            f"LoD2 roofs {number}/{len(tiles)} {tile.name}: {tile_kept:,} buildings; "
            f"{len(meshes):,}/{len(order):,} total; elapsed {time.perf_counter() - started:.1f}s",
            flush=True,
        )

    ids = [i for i in order if i in meshes]
    ranges = np.zeros((len(ids), 4), dtype="<u4")
    vertex_count = index_count = 0
    for row, identifier in enumerate(ids):
        positions, indices = meshes[identifier]
        ranges[row] = (vertex_count, len(positions), index_count, len(indices))
        vertex_count += len(positions)
        index_count += len(indices)
    positions = np.concatenate([meshes[i][0] for i in ids]).reshape(-1)
    indices = np.concatenate([meshes[i][1] + np.uint32(ranges[row, 0]) for row, i in enumerate(ids)])
    if not np.isfinite(positions).all():
        raise ValueError("Roof positions contain non-finite values")

    binary = root / "public/data/roofs3d.bin"
    with binary.open("wb") as handle:
        handle.write(positions.tobytes())
        handle.write(indices.astype("<u4").tobytes())
        handle.write(ranges.tobytes())
    header = {
        "format": FORMAT,
        "binary": "roofs3d.bin",
        "littleEndian": True,
        "baseElevation": base,
        "origin": {"lng": frame["lng"], "lat": frame["lat"]},
        "frame": {
            "axes": "x east, y north, z up; metres",
            "eastPerDegree": frame["eastPerDegree"],
            "northPerDegree": frame["northPerDegree"],
            "up": "source DHHN2016 height minus baseElevation",
        },
        "vertexCount": vertex_count,
        "indexCount": index_count,
        "triangleCount": index_count // 3,
        "buildingCount": len(ids),
        "polygonCount": polygons,
        "byteLength": binary.stat().st_size,
        "positions": {"byteOffset": 0, "type": "Float32", "components": 3, "count": vertex_count},
        "indices": {"byteOffset": vertex_count * 12, "type": "Uint32", "count": index_count},
        "rangeTable": {
            "byteOffset": vertex_count * 12 + index_count * 4,
            "type": "Uint32",
            "components": 4,
            "count": len(ids),
            "fields": ["vertexStart", "vertexCount", "indexStart", "indexCount"],
        },
        "ids": ids,
        "ranges": {identifier: [int(v) for v in ranges[row]] for row, identifier in enumerate(ids)},
    }
    output = root / "public/data/roofs3d.json"
    with output.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(header, handle, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        handle.write("\n")
    elapsed = time.perf_counter() - started
    print(
        f"Wrote {len(ids):,}/{len(order):,} buildings, {polygons:,} roof polygons "
        f"({skipped:,} degenerate skipped, {forced:,} forced ear cuts), {vertex_count:,} vertices, "
        f"{index_count // 3:,} triangles; bin {binary.stat().st_size / 1e6:.3f} MB, "
        f"json {output.stat().st_size / 1e6:.3f} MB; {elapsed:.1f}s",
        flush=True,
    )
    return {"seconds": elapsed, "buildings": len(ids), "polygons": polygons, "skipped": skipped, "forced": forced}


if __name__ == "__main__":
    build()

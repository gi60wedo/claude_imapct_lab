"""Rebuild and assert every P1 acceptance criterion, including runtime."""

from __future__ import annotations

import json
import math
import sys
from itertools import pairwise

# Importing the sibling converter must not create an extra worktree file.
sys.dont_write_bytecode = True

import numpy as np
from lod2_buildings import BBOX, ROOT, area_and_centroid, build, self_intersects, signed_area
from pyproj import Transformer

# Verified centroid count from all four source tiles within the unchanged BBOX.
MIN_BUILDINGS = 7085


def contains(ring: list, point: tuple[float, float]) -> bool:
    """Boundary-inclusive ray casting in the ring's coordinate system."""
    x, y = point
    inside = False
    for a, b in pairwise(ring):
        ax, ay = a[:2]
        bx, by = b[:2]
        cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
        if abs(cross) < 1e-14 and min(ax, bx) <= x <= max(ax, bx) and min(ay, by) <= y <= max(ay, by):
            return True
        if (ay > y) != (by > y) and x < ax + (y - ay) * (bx - ax) / (by - ay):
            inside = not inside
    return inside


def contains_polygon(polygon: list, point: tuple[float, float]) -> bool:
    return contains(polygon[0], point) and not any(contains(hole, point) for hole in polygon[1:])


def overlap(first: list, second: list) -> bool:
    """Detect overlap with an OSM ring while excluding building courtyards."""
    if any(contains_polygon(first, tuple(p[:2])) for p in second[:-1]):
        return True
    if any(contains(second, tuple(p[:2])) for ring in first for p in ring[:-1]):
        return True

    def side(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    return any(
        side(a, b, c) * side(a, b, d) < 0 and side(c, d, a) * side(c, d, b) < 0
        for ring in first
        for a, b in pairwise(ring)
        for c, d in pairwise(second)
    )


def named_osm_rings() -> list[tuple[str, str, list]]:
    """Read named building ways and assemble multipolygon outer member ways."""
    osm_path = ROOT / "datasets/osm/altstadt.json"
    if not osm_path.is_file():
        raise FileNotFoundError("OSM overlap labels require datasets/osm/altstadt.json")
    elements = json.loads(osm_path.read_text(encoding="utf-8"))["elements"]
    result = []
    for element in elements:
        tags = element.get("tags", {})
        name = tags.get("name") or tags.get("official_name")
        if not name or not ("building" in tags or "building:part" in tags):
            continue
        chains = []
        if element["type"] == "way" and element.get("geometry"):
            chains.append([[p["lon"], p["lat"]] for p in element["geometry"]])
        elif element["type"] == "relation":
            for member in element.get("members", []):
                if member.get("role", "") in ("outer", "") and member.get("geometry"):
                    chains.append([[p["lon"], p["lat"]] for p in member["geometry"]])
        while chains:
            ring = chains.pop(0)
            while ring[0] != ring[-1]:
                for i, chain in enumerate(chains):
                    if chain[0] == ring[-1]:
                        ring.extend(chain[1:])
                    elif chain[-1] == ring[-1]:
                        ring.extend(chain[-2::-1])
                    elif chain[-1] == ring[0]:
                        ring = chain[:-1] + ring
                    elif chain[0] == ring[0]:
                        ring = chain[:0:-1] + ring
                    else:
                        continue
                    chains.pop(i)
                    break
                else:
                    break
            if len(ring) >= 4 and ring[0] == ring[-1]:
                result.append((name, f"{element['type']}/{element['id']}", ring))
    return result


def main() -> int:
    # Rebuilding measures the complete converter, including base lookup and JSON IO.
    print(f"Building-count acceptance floor N={MIN_BUILDINGS}", flush=True)
    stats = build()
    output = ROOT / "public/data/buildings3d.json"
    document = json.loads(output.read_text(encoding="utf-8"))
    assert isinstance(document, dict) and set(document) == {"baseElevation", "buildings"}, "Expected baseElevation metadata and buildings"
    base = document["baseElevation"]
    assert not isinstance(base, bool) and isinstance(base, (int, float)) and math.isfinite(base), "Invalid baseElevation metadata"
    assert base == stats["baseElevation"], "Recorded baseElevation differs from the converter's offset"
    terrain_path = ROOT / "public/data/terrain/terrain.json"
    if terrain_path.is_file():
        terrain_base = json.loads(terrain_path.read_text(encoding="utf-8"))["baseElevation"]
        assert base == terrain_base, f"Building baseElevation {base} differs from terrain baseElevation {terrain_base}"
        print(f"PASS baseElevation={base:g} m matches terrain.json", flush=True)
    else:
        print(f"PASS recorded baseElevation={base:g} m; terrain.json is absent", flush=True)
    buildings = document["buildings"]
    assert isinstance(buildings, list) and buildings, "Expected a non-empty JSON array"
    identifiers = set()
    inverse = Transformer.from_crs(4326, 25832, always_xy=True)
    west, south, east, north = BBOX
    boundary_rounding_cases = 0
    hole_count = 0
    for building in buildings:
        assert set(building) == {"id", "polygon", "h", "roof"}, "Unexpected building schema"
        identifier = building["id"]
        assert isinstance(identifier, str) and identifier and identifier not in identifiers, "Invalid building ID"
        identifiers.add(identifier)
        assert isinstance(building["roof"], str) and building["roof"], f"Missing roof type: {identifier}"
        assert isinstance(building["h"], (int, float)) and math.isfinite(building["h"]) and building["h"] >= 0, f"Invalid height: {identifier}"
        polygon = building["polygon"]
        assert isinstance(polygon, list) and polygon, f"Missing outer ring: {identifier}"
        hole_count += len(polygon) - 1
        for index, ring in enumerate(polygon):
            assert len(ring) >= 4 and ring[0] == ring[-1], f"Unclosed ring {index}: {identifier}"
            assert len({tuple(p[:2]) for p in ring[:-1]}) >= 3, f"Collapsed ring {index}: {identifier}"
            for point in ring:
                assert len(point) == 3 and all(isinstance(v, (int, float)) and math.isfinite(v) for v in point), f"Invalid XYZ: {identifier}"
                assert -180 <= point[0] <= 180 and -90 <= point[1] <= 90, f"Invalid WGS84: {identifier}"
                assert point[0] == round(point[0], 6) and point[1] == round(point[1], 6), f"Expected six decimal places: {identifier}"
                assert point[2] == polygon[0][0][2], f"Non-flat building base: {identifier}"
            array = np.asarray(ring)
            signed = signed_area(array)
            assert signed > 0 if index == 0 else signed < 0, f"Incorrect winding in ring {index}: {identifier}"
            assert not self_intersects(array), f"Self-intersecting ring {index}: {identifier}"
        x, y = inverse.transform(*np.asarray(polygon[0])[:, :2].T)
        area, centroid = area_and_centroid(np.column_stack((x, y)))
        assert area > 0, f"Degenerate projected ring: {identifier}"
        # Simplification may shift a raw centroid near the clipping boundary.
        assert west - 0.4 <= centroid[0] <= east + 0.4 and south - 0.4 <= centroid[1] <= north + 0.4, f"Centroid outside bbox: {identifier}"
        boundary_rounding_cases += int(not (west <= centroid[0] <= east and south <= centroid[1] <= north))
    print(f"PASS schema, unique IDs, closed simple 3D rings, CCW outers/CW holes ({hole_count} holes), six-decimal WGS84 and bbox ({boundary_rounding_cases} boundary rounding cases)", flush=True)

    names = named_osm_rings()
    print("Five tallest buildings (names come from OSM footprint overlap):", flush=True)
    tallest = sorted(buildings, key=lambda b: (-b["h"], b["id"]))[:5]
    named_tallest = 0
    for rank, building in enumerate(tallest, start=1):
        labels = sorted({f"{name} [OSM {reference}]" for name, reference, ring in names if overlap(building["polygon"], ring)})
        label = "; ".join(labels) or "no named OSM building overlap"
        named_tallest += bool(labels)
        print(f"  {rank}. {building['id']}: {building['h']:.3f} m — {label}", flush=True)

    lorenz = [b for b in buildings if contains_polygon(b["polygon"], (11.0782, 49.4511))]
    lorenz_names = {name for name, _, ring in names for b in lorenz if overlap(b["polygon"], ring)}
    print(f"Lorenzkirche at (11.0782, 49.4511): {[(b['id'], b['h']) for b in lorenz]}; OSM names={sorted(lorenz_names)}", flush=True)
    checks = [
        ("building count", len(buildings) >= MIN_BUILDINGS,
         f"{len(buildings):,} buildings inside bbox; required at least {MIN_BUILDINGS:,}. Parsed {stats['sourceCount']:,} source buildings."),
        ("file size", output.stat().st_size < 12_000_000,
         f"{output.stat().st_size:,} bytes; required below 12,000,000 bytes"),
        ("Lorenzkirche towers", any(b["h"] >= 70 for b in lorenz),
         f"Containing building heights {[b['h'] for b in lorenz]}; required at least 70 m"),
        ("Lorenzkirche OSM name", any("lorenz" in name.casefold() for name in lorenz_names),
         f"OSM names {sorted(lorenz_names)}; required a name containing 'Lorenz'"),
        ("converter runtime", stats["seconds"] < 240,
         f"{stats['seconds']:.2f}s; required below 240s"),
        ("five tallest OSM overlaps", len(tallest) == 5 and named_tallest >= 3,
         f"{named_tallest}/5 tallest buildings have named OSM overlaps; required at least 3/5"),
    ]
    failures = []
    for label, passed, detail in checks:
        try:
            assert passed, detail
        except AssertionError as error:
            failures.append(f"{label}: {error}")
            print(f"FAIL {label}: {error}", flush=True)
        else:
            print(f"PASS {label}: {detail}", flush=True)
    if failures:
        print("P1 acceptance failed: " + " | ".join(failures), file=sys.stderr, flush=True)
        return 1
    print("PASS all P1 acceptance assertions", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

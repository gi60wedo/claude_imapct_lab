"""Rebuild and assert every P1 acceptance criterion, including runtime."""

from __future__ import annotations

import json
import math
import sys
from itertools import pairwise

# Importing the sibling converter must not create an extra worktree file.
sys.dont_write_bytecode = True

import numpy as np
from lod2_buildings import BBOX, ROOT, area_and_centroid, build
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


def overlap(first: list, second: list) -> bool:
    """Detect polygon overlap through containment and proper edge crossings."""
    if any(contains(first, tuple(p[:2])) for p in second[:-1]):
        return True
    if any(contains(second, tuple(p[:2])) for p in first[:-1]):
        return True

    def side(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    return any(
        side(a, b, c) * side(a, b, d) < 0 and side(c, d, a) * side(c, d, b) < 0
        for a, b in pairwise(first)
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
    buildings = json.loads(output.read_text(encoding="utf-8"))
    assert isinstance(buildings, list) and buildings, "Expected a non-empty JSON array"
    identifiers = set()
    inverse = Transformer.from_crs(4326, 25832, always_xy=True)
    west, south, east, north = BBOX
    boundary_rounding_cases = 0
    for building in buildings:
        assert set(building) == {"id", "polygon", "h", "roof"}, "Unexpected building schema"
        identifier = building["id"]
        assert isinstance(identifier, str) and identifier and identifier not in identifiers, "Invalid building ID"
        identifiers.add(identifier)
        assert isinstance(building["roof"], str) and building["roof"], f"Missing roof type: {identifier}"
        assert isinstance(building["h"], (int, float)) and math.isfinite(building["h"]) and building["h"] >= 0, f"Invalid height: {identifier}"
        polygon = building["polygon"]
        assert len(polygon) >= 4 and polygon[0] == polygon[-1], f"Unclosed ring: {identifier}"
        assert len({tuple(p[:2]) for p in polygon[:-1]}) >= 3, f"Collapsed ring: {identifier}"
        for point in polygon:
            assert len(point) == 3 and all(isinstance(v, (int, float)) and math.isfinite(v) for v in point), f"Invalid XYZ: {identifier}"
            assert -180 <= point[0] <= 180 and -90 <= point[1] <= 90, f"Invalid WGS84: {identifier}"
            assert point[0] == round(point[0], 6) and point[1] == round(point[1], 6), f"Expected six decimal places: {identifier}"
            assert point[2] == polygon[0][2], f"Non-flat building base: {identifier}"
        x, y = inverse.transform(*np.asarray(polygon)[:, :2].T)
        area, centroid = area_and_centroid(np.column_stack((x, y)))
        assert area > 0, f"Degenerate projected ring: {identifier}"
        # Simplification may shift a raw centroid near the clipping boundary.
        assert west - 0.4 <= centroid[0] <= east + 0.4 and south - 0.4 <= centroid[1] <= north + 0.4, f"Centroid outside bbox: {identifier}"
        boundary_rounding_cases += int(not (west <= centroid[0] <= east and south <= centroid[1] <= north))
    print(f"PASS schema, unique IDs, closed 3D rings, six-decimal WGS84 and bbox ({boundary_rounding_cases} boundary rounding cases)", flush=True)

    names = named_osm_rings()
    print("Five tallest buildings (names come from OSM footprint overlap):", flush=True)
    tallest = sorted(buildings, key=lambda b: (-b["h"], b["id"]))[:5]
    for rank, building in enumerate(tallest, start=1):
        labels = sorted({f"{name} [OSM {reference}]" for name, reference, ring in names if overlap(building["polygon"], ring)})
        label = "; ".join(labels) or "no named OSM building overlap"
        print(f"  {rank}. {building['id']}: {building['h']:.3f} m — {label}", flush=True)

    lorenz = [b for b in buildings if contains(b["polygon"], (11.0782, 49.4511))]
    lorenz_names = {name for name, _, ring in names for b in lorenz if overlap(b["polygon"], ring)}
    print(f"Lorenzkirche at (11.0782, 49.4511): {[(b['id'], b['h']) for b in lorenz]}; OSM names={sorted(lorenz_names)}", flush=True)
    checks = [
        ("building count", len(buildings) >= MIN_BUILDINGS,
         f"{len(buildings):,} buildings inside bbox; required at least {MIN_BUILDINGS:,}. Parsed {stats['sourceCount']:,} source buildings."),
        ("file size", output.stat().st_size < 12_000_000,
         f"{output.stat().st_size:,} bytes; required below 12,000,000 bytes"),
        ("Lorenzkirche towers", any(b["h"] >= 70 for b in lorenz),
         f"Containing building heights {[b['h'] for b in lorenz]}; required at least 70 m"),
        ("converter runtime", stats["seconds"] < 240,
         f"{stats['seconds']:.2f}s; required below 240s"),
        ("five tallest OSM overlap report", len(tallest) == 5 and bool(names),
         "Expected five tallest buildings and named OSM building geometry"),
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

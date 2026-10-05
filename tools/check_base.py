"""Sanity checks for public/base/ assets."""
import json
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent / "public" / "base"
LNG, LAT = 11.07773, 49.45095


def inside(poly, x, y):
    n, hit = len(poly), False
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            hit = not hit
    return hit


tiles = json.loads((BASE / "dop20.json").read_text())
hits = [t["url"] for t in tiles if inside(t["bounds"], LNG, LAT)]
assert len(hits) == 1, f"point inside {len(hits)} dop20 quadrants: {hits}"
buildings = json.loads((BASE / "buildings-osm.json").read_text())
assert len(buildings) >= 3000, f"only {len(buildings)} buildings"
for f in ("alkis.json", "bollards.json", "footways.json"):
    assert (BASE / f).exists(), f
print(f"OK: point in {hits[0]}, {len(buildings)} buildings")

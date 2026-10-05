"""Sanity checks for public/base/ assets."""
import json
import math
from pathlib import Path

import base_assets

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
elements = json.loads((base_assets.ROOT / "datasets" / "osm" / "altstadt.json").read_text())["elements"]
way_count = sum(1 for e in elements if e["type"] == "way" and "building" in e.get("tags", {})
                and len(e.get("geometry", [])) >= 3)
rel_polys = sum(len(base_assets.relation_buildings(e)) for e in elements
                if e["type"] == "relation" and "building" in e.get("tags", {}))
assert rel_polys > 0, "no relation polygons assembled"
assert len(buildings) == way_count + rel_polys, \
    f"{len(buildings)} buildings != {way_count} ways + {rel_polys} relation polygons"
ALT_LNG, ALT_LAT = 11.0770, 49.4540


def metres(p, lng, lat):
    return math.hypot((p[0] - lng) * 111320 * math.cos(math.radians(lat)), (p[1] - lat) * 110540)


def near(b, lng, lat, radius=30):
    return any(metres(p, lng, lat) <= radius for p in b["polygon"])


assert any(near(b, ALT_LNG, ALT_LAT) for b in buildings), "no building within 30 m of Altes Rathaus point"
# The Altes Rathaus relation (OSM 1841447) lies north of the point above; its polygon must be present.
rathaus = [e for e in elements if e["type"] == "relation" and e["id"] == 1841447][0]
for rb in base_assets.relation_buildings(rathaus):
    assert rb in buildings, "Altes Rathaus relation polygon missing"
bollards = json.loads((BASE / "bollards.json").read_text())
assert len(bollards) == len({tuple(b) for b in bollards}), "duplicate bollards"
way_ids = {842183009}
removable = [e for e in elements if e["id"] in way_ids and e["type"] == "way"][0]["geometry"]
for p in removable:
    assert [round(p["lon"], 6), round(p["lat"], 6)] in bollards, "bollard way vertex missing"
for f in ("alkis.json", "bollards.json", "footways.json"):
    assert (BASE / f).exists(), f
print(f"OK: point in {hits[0]}, {len(buildings)} buildings")

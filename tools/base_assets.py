"""Build browser assets in public/base/ from datasets/."""
import json
import re
from pathlib import Path

from PIL import Image
from pyproj import Transformer

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "base"
SIZE = 2100
TO_WGS = Transformer.from_crs(25832, 4326, always_xy=True)
NAME_RE = re.compile(r"_(\d+)_(\d+)_(\d+)_(\d+)\.(jpg|png)$")


def r6(v):
    return round(v, 6)


def process_images(src_dir, pattern, out_json):
    entries = []
    for path in sorted(src_dir.glob(pattern)):
        m = NAME_RE.search(path.name)
        if not m:
            continue
        minx, miny, maxx, maxy = (int(g) for g in m.groups()[:4])
        img = Image.open(path)
        if path.suffix == ".jpg":
            img = img.convert("RGB").resize((SIZE, SIZE), Image.LANCZOS)
            img.save(OUT / path.name, "JPEG", quality=80, optimize=True)
        else:
            img = img.convert("RGBA").resize((SIZE, SIZE), Image.LANCZOS)
            img.save(OUT / path.name, "PNG", optimize=True)
        corners = [(minx, miny), (minx, maxy), (maxx, maxy), (maxx, miny)]  # BL, TL, TR, BR
        bounds = [[r6(x), r6(y)] for x, y in (TO_WGS.transform(cx, cy) for cx, cy in corners)]
        entries.append({"url": f"/base/{path.name}", "bounds": bounds})
    (OUT / out_json).write_text(json.dumps(entries))
    print(f"{out_json}: {len(entries)} tiles")


def height_of(tags):
    h = tags.get("height")
    if h:
        m = re.search(r"\d+(?:[.,]\d+)?", h)
        if m:
            return float(m.group().replace(",", "."))
    lv = tags.get("building:levels")
    if lv:
        m = re.search(r"\d+(?:[.,]\d+)?", lv)
        if m:
            return float(m.group().replace(",", ".")) * 3
    return 9


def assemble_rings(segments):
    """Join open way segments (lists of (lon, lat)) end to end into closed rings."""
    segs = [list(s) for s in segments if len(s) >= 2]
    rings = []
    while segs:
        ring = segs.pop()
        while ring[0] != ring[-1]:
            for i, s in enumerate(segs):
                if s[0] == ring[-1]:
                    ring += s[1:]
                elif s[-1] == ring[-1]:
                    ring += s[::-1][1:]
                elif s[-1] == ring[0]:
                    ring = s[:-1] + ring
                elif s[0] == ring[0]:
                    ring = s[::-1][:-1] + ring
                else:
                    continue
                del segs[i]
                break
            else:
                break  # cannot close: drop the fragment
        if ring[0] == ring[-1] and len(ring) >= 4:
            rings.append(ring)
    return rings


def point_in_ring(ring, x, y):
    hit = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            hit = not hit
    return hit


def relation_buildings(rel):
    """Return [{"polygon", "holes"?, "h"}] for a building multipolygon relation."""
    def ways(role):
        return [[(r6(p["lon"]), r6(p["lat"])) for p in m["geometry"]]
                for m in rel.get("members", [])
                if m["type"] == "way" and m["role"] == role and m.get("geometry")]
    outers, inners = assemble_rings(ways("outer")), assemble_rings(ways("inner"))
    h = height_of(rel["tags"])
    result = []
    for outer in outers:
        holes = [i for i in inners if point_in_ring(outer, *i[0])]
        b = {"polygon": [list(p) for p in outer], "h": h}
        if holes:
            b["holes"] = [[list(p) for p in i] for i in holes]
        result.append(b)
    return result


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    process_images(ROOT / "datasets" / "dop20", "*.jpg", "dop20.json")
    process_images(ROOT / "datasets" / "alkis", "*.png", "alkis.json")

    elements = json.loads((ROOT / "datasets" / "osm" / "altstadt.json").read_text())["elements"]
    buildings, bollards, footways = [], [], []
    foot_types = {"footway", "pedestrian", "path", "living_street", "steps"}
    for el in elements:
        tags = el.get("tags", {})
        if el["type"] == "node" and tags.get("barrier") == "bollard":
            bollards.append([r6(el["lon"]), r6(el["lat"])])
        elif el["type"] == "way" and tags.get("barrier") == "bollard":
            bollards.extend([r6(p["lon"]), r6(p["lat"])] for p in el.get("geometry", []))
        elif el["type"] == "relation" and "building" in tags:
            buildings.extend(relation_buildings(el))
        elif el["type"] == "way" and el.get("geometry"):
            pts = [[r6(p["lon"]), r6(p["lat"])] for p in el["geometry"]]
            if len(pts) < 3 and "building" in tags:
                continue
            if "building" in tags:
                buildings.append({"polygon": pts, "h": height_of(tags)})
            elif tags.get("highway") in foot_types and len(pts) >= 2:
                footways.append(pts)
    bollards = [list(p) for p in dict.fromkeys(tuple(b) for b in bollards)]
    for name, data in [("buildings-osm", buildings), ("bollards", bollards), ("footways", footways)]:
        (OUT / f"{name}.json").write_text(json.dumps(data, separators=(",", ":")))
        print(f"{name}.json: {len(data)}")


if __name__ == "__main__":
    main()

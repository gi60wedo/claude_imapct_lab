"""QA renders: DOP20 aerial crop per candidate with the site outline, van-legal roads, blockers and the van route.

    uv run python render.py [candidate-id ...]   -> prep/cache/render/<id>.png
"""
import glob
import json
import os
import sys

from PIL import Image, ImageDraw

from common import CACHE, DATA, OUT, to_utm

PX_PER_M = 4  # DOP20 tiles are 0.25 m/px


def mosaic_crop(cx, cy, half):
    x0, y0, x1, y1 = cx - half, cy - half, cx + half, cy + half
    size = int(2 * half * PX_PER_M)
    canvas = Image.new("RGB", (size, size), (40, 40, 40))
    for p in glob.glob(os.path.join(DATA, "dop20", "*.jpg")):
        tx0, ty0, tx1, ty1 = (float(v) for v in os.path.basename(p)[6:-4].split("_"))
        if tx1 < x0 or tx0 > x1 or ty1 < y0 or ty0 > y1:
            continue
        im = Image.open(p)
        sx = im.width / (tx1 - tx0)
        box = (int((max(x0, tx0) - tx0) * sx), int((ty1 - min(y1, ty1)) * sx),
               int((min(x1, tx1) - tx0) * sx), int((ty1 - max(y0, ty0)) * sx))
        part = im.crop(box).resize((int((box[2] - box[0]) * PX_PER_M / sx), int((box[3] - box[1]) * PX_PER_M / sx)))
        canvas.paste(part, (int((max(x0, tx0) - x0) * PX_PER_M), int((y1 - min(y1, ty1)) * PX_PER_M)))
    return canvas, (x0, y1)


def main(ids):
    cands = json.load(open(os.path.join(OUT, "candidates.json"), encoding="utf-8"))["candidates"]
    g = json.load(open(os.path.join(OUT, "graph.json"), encoding="utf-8"))
    nodes = [to_utm(n["lng"], n["lat"]) for n in g["nodes"]]
    os.makedirs(os.path.join(CACHE, "render"), exist_ok=True)
    for c in cands:
        if ids and c["id"] not in ids:
            continue
        ring = [to_utm(*p) for p in c["polygon"]]
        xs, ys = zip(*ring)
        cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
        half = max(120, (max(xs) - min(xs)) / 2 + 80, (max(ys) - min(ys)) / 2 + 80)
        img, (ox, oy) = mosaic_crop(cx, cy, half)
        d = ImageDraw.Draw(img, "RGBA")
        P = lambda x, y: ((x - ox) * PX_PER_M, (oy - y) * PX_PER_M)
        for e in g["edges"]:
            if not e.get("vanRoad"):
                continue
            col = (40, 220, 90, 230) if e["vehicleAllowed"] else (235, 60, 60, 200)
            d.line([P(*nodes[e["a"]]), P(*nodes[e["b"]])], fill=col, width=5)
        for i, n in enumerate(g["nodes"]):
            if n.get("vanBlock"):
                x, y = P(*nodes[i])
                d.ellipse([x - 9, y - 9, x + 9, y + 9], fill=(255, 210, 0, 255), outline=(0, 0, 0, 255), width=2)
        d.polygon([P(x, y) for x, y in ring], outline=(0, 200, 255, 255), fill=(0, 200, 255, 50), width=6)
        ev = c["evidence"]
        if ev.get("vanRoute"):
            d.line([P(*to_utm(*p)) for p in ev["vanRoute"]], fill=(255, 0, 255, 255), width=7)
        if ev.get("loadingPoint"):
            x, y = P(*to_utm(*ev["loadingPoint"]))
            d.rectangle([x - 14, y - 14, x + 14, y + 14], fill=(255, 0, 255, 255), outline=(255, 255, 255, 255), width=3)
        for b in ev.get("vanBlockers", []):
            x, y = P(*to_utm(*b["at"]))
            d.line([x - 16, y - 16, x + 16, y + 16], fill=(255, 255, 255, 255), width=6)
            d.line([x - 16, y + 16, x + 16, y - 16], fill=(255, 255, 255, 255), width=6)
        i = c["indicators"]
        d.rectangle([0, 0, img.width, 64], fill=(0, 0, 0, 170))
        d.text((12, 10), f"{c['name']}  [{c['kind']}]  {c['areaM2']:.0f} m2", fill="white", font_size=26)
        d.text((12, 38), f"van {'OK' if i['deliveryAccess'] else 'NO'} {i['vanDistM']} m   nearest stop "
                         f"{ev['nearestStop']['name'] if ev['nearestStop'] else '-'} {ev['nearestStop']['walkM'] if ev['nearestStop'] else ''} m",
               fill="white", font_size=20)
        img = img.resize((img.width // 2, img.height // 2))
        path = os.path.join(CACHE, "render", f"{c['id']}.png")
        img.save(path)
        print("  ", path)


if __name__ == "__main__":
    main(sys.argv[1:])

"""DOP20 aerial photo + ALKIS parcel map -> web-sized tiles in public/data/imagery + imagery.json (deck.gl BitmapLayer)."""
import glob
import os

from PIL import Image

from common import DATA, OUT, ll, write_json

DOP_PX = 2100  # 1050 m quadrant -> 0.5 m/px, plenty for a projector


def corners(x0, y0, x1, y1):
    # BitmapLayer `bounds` as four corners: bottom-left, top-left, top-right, bottom-right (EPSG:25832 is not lng/lat-aligned)
    return [ll(x0, y0), ll(x0, y1), ll(x1, y1), ll(x1, y0)]


def main():
    print("Imagery")
    out_dir = os.path.join(OUT, "imagery")
    os.makedirs(out_dir, exist_ok=True)
    layers = []
    for kind, pattern in (("dop20", "dop20/*.jpg"), ("alkis", "alkis/*.png")):
        for p in sorted(glob.glob(os.path.join(DATA, pattern))):
            name = os.path.basename(p)
            x0, y0, x1, y1 = (float(v) for v in name.rsplit(".", 1)[0].split("_")[-4:])
            im = Image.open(p)
            if kind == "dop20":
                im = im.convert("RGB").resize((DOP_PX, DOP_PX), Image.LANCZOS)
                im.save(os.path.join(out_dir, name), quality=80, optimize=True)
            else:
                im.save(os.path.join(out_dir, name), optimize=True)
            layers.append({"id": name.rsplit(".", 1)[0], "kind": kind, "url": f"/data/imagery/{name}",
                           "bounds": corners(x0, y0, x1, y1)})
    write_json("imagery.json", {"source": "Bayerische Vermessungsverwaltung - www.geodaten.bayern.de, CC BY 4.0", "layers": layers})
    total = sum(os.path.getsize(os.path.join(out_dir, f)) for f in os.listdir(out_dir)) / 1e6
    print(f"  {len(layers)} tiles, {total:.1f} MB")


if __name__ == "__main__":
    main()

# Downloads Zensus 2022 100 m grids and keeps only the Nuremberg city area (EPSG:3035 cell centres).
# Run: uv run --with pyproj python zensus/fetch_zensus.py
import csv, io, os, sys, urllib.request, zipfile
from pyproj import Transformer
BASE = "https://www.destatis.de/static/DE/zensus/gitterdaten/"
FILES = {"population": "Zensus2022_Bevoelkerungszahl.zip",
         "share_65plus": "Anteil_ab_65-jaehrige_in_Gitterzellen.zip",
         "avg_age": "Durchschnittsalter_in_Gitterzellen.zip"}
t = Transformer.from_crs(4326, 3035, always_xy=True)
xs, ys = zip(*[t.transform(lon, lat) for lon, lat in [(10.98, 49.37), (11.20, 49.37), (10.98, 49.55), (11.20, 49.55)]])
X0, X1, Y0, Y1 = min(xs), max(xs), min(ys), max(ys)
out = os.path.dirname(os.path.abspath(__file__))
for name, f in FILES.items():
    raw = os.path.join(out, f)
    if not os.path.exists(raw):
        print(f"download {f}", flush=True)
        urllib.request.urlretrieve(BASE + f, raw)
    with zipfile.ZipFile(raw) as z:
        member = next(n for n in z.namelist() if n.endswith(".csv") and "100m" in n.lower()) if any("100m" in n.lower() for n in z.namelist()) else next(n for n in z.namelist() if n.endswith(".csv"))
        print(f"  {name}: {member}", flush=True)
        with z.open(member) as fh:
            r = csv.reader(io.TextIOWrapper(fh, encoding="utf-8-sig", errors="replace"), delimiter=";")
            head = next(r); ix, iy = [next(i for i, h in enumerate(head) if h.lower().startswith(p)) for p in ("x_m", "y_m")]
            rows = [row for row in r if X0 <= float(row[ix]) <= X1 and Y0 <= float(row[iy]) <= Y1]
    with open(os.path.join(out, f"nuernberg_{name}_100m.csv"), "w", newline="") as fo:
        w = csv.writer(fo); w.writerow(head); w.writerows([[c.replace(",", ".") if c != "–" else "" for c in r] for r in rows])
    print(f"  kept {len(rows)} cells", flush=True)
    os.remove(raw)

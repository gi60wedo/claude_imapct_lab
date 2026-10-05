"""Zensus 2022 100 m grid -> public/data/population.json (resident origins + senior share for B)."""
import csv
import json
import os

from pyproj import Transformer

from common import BBOX_UTM, DATA, cache_path, write_json

MARGIN_M = 1500.0  # residents walk in from outside the Altstadt bbox too
_3035_to_25832 = Transformer.from_crs(3035, 25832, always_xy=True)
_3035_to_4326 = Transformer.from_crs(3035, 4326, always_xy=True)


def _read(name, col):
    with open(os.path.join(DATA, "zensus", f"nuernberg_{name}_100m.csv"), encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    return {r["GITTER_ID_100m"]: (float(r["x_mp_100m"]), float(r["y_mp_100m"]), float(r[col]) if r[col] else None) for r in rows}


def main():
    print("Population")
    pop = _read("population", "Einwohner")
    s65 = _read("share_65plus", "AnteilUeber65")
    age = _read("avg_age", "Durchschnittsalter")
    x0, y0, x1, y1 = BBOX_UTM
    cells, suppressed = [], 0
    for gid, (x3035, y3035, p) in pop.items():
        x, y = _3035_to_25832.transform(x3035, y3035)
        if not (x0 - MARGIN_M <= x <= x1 + MARGIN_M and y0 - MARGIN_M <= y <= y1 + MARGIN_M):
            continue
        if p is None:
            suppressed += 1
            continue
        lng, lat = _3035_to_4326.transform(x3035, y3035)
        cells.append({"id": gid, "x": x, "y": y, "lng": round(lng, 6), "lat": round(lat, 6), "pop": int(p),
                      "share65": s65.get(gid, (0, 0, None))[2], "avgAge": age.get(gid, (0, 0, None))[2]})
    with open(cache_path("population_utm.json"), "w") as f:
        json.dump(cells, f)
    total = sum(c["pop"] for c in cells)
    with_share = [c for c in cells if c["share65"] is not None]
    senior = sum(c["pop"] * c["share65"] / 100 for c in with_share) / max(1, sum(c["pop"] for c in with_share))
    write_json("population.json", {
        "source": "Statistisches Bundesamt (Destatis), Zensus 2022, dl-de/by-2-0",
        "fields": ["lng", "lat", "pop", "share65", "avgAge"],
        "note": "100 m cell centres; share65 in percent; null = suppressed by Destatis; "
                f"covers the Altstadt bbox + {MARGIN_M:.0f} m",
        "summary": {"cells": len(cells), "population": total, "seniorShare": round(senior, 4), "suppressedCells": suppressed},
        "cells": [[c["lng"], c["lat"], c["pop"], c["share65"], c["avgAge"]] for c in cells],
    })
    print(f"  {len(cells)} cells, {total} residents, senior share {senior:.1%}, {suppressed} suppressed cells skipped")


if __name__ == "__main__":
    main()

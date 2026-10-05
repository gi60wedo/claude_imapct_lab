"""Assert the roof mesh acceptance criteria against the shipped roofs3d.bin/json.

Run lod2_roofs.py first, then
uv run --with lxml --with numpy --with pyproj python prep/scene3d/check_roofs.py.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
LORENZ = "DEBY_LOD2_3394961"
MAX_BYTES = 15_000_000


def main() -> int:
    data = ROOT / "public/data"
    header_path, binary_path = data / "roofs3d.json", data / "roofs3d.bin"
    header = json.loads(header_path.read_text(encoding="utf-8"))
    raw = binary_path.read_bytes()
    buildings = json.loads((data / "buildings3d.json").read_text(encoding="utf-8"))
    terrain = json.loads((data / "terrain/terrain.json").read_text(encoding="utf-8"))

    vertices, indices_count, count = header["vertexCount"], header["indexCount"], header["buildingCount"]
    positions = np.frombuffer(raw, "<f4", vertices * 3, header["positions"]["byteOffset"]).reshape(-1, 3)
    indices = np.frombuffer(raw, "<u4", indices_count, header["indices"]["byteOffset"])
    table = np.frombuffer(raw, "<u4", count * 4, header["rangeTable"]["byteOffset"]).reshape(-1, 4)
    ids = header["ids"]
    expected = {b["id"]: b for b in buildings["buildings"]}

    def zmax(identifier: str) -> float:
        start, length = header["ranges"][identifier][:2]
        return float(positions[start : start + length, 2].max())

    def zbase(identifier: str) -> float:
        return float(expected[identifier]["polygon"][0][0][2])

    within = [abs(zmax(i) - (zbase(i) + expected[i]["h"])) <= 1.0 for i in ids]
    worst = sorted(ids, key=lambda i: -abs(zmax(i) - (zbase(i) + expected[i]["h"])))[:5]
    for identifier in worst:
        print(
            f"  largest gap {identifier}: roof zMax {zmax(identifier):.2f} vs zBase+h "
            f"{zbase(identifier) + expected[identifier]['h']:.2f}",
            flush=True,
        )
    lorenz_top = zmax(LORENZ) - zbase(LORENZ) if LORENZ in header["ranges"] else float("nan")
    size = header_path.stat().st_size + binary_path.stat().st_size
    contiguous = all(
        table[k, 0] == (table[k - 1, 0] + table[k - 1, 1] if k else 0)
        and table[k, 2] == (table[k - 1, 2] + table[k - 1, 3] if k else 0)
        for k in range(count)
    )
    local = all(
        indices[s : s + n].size == 0 or (indices[s : s + n].min() >= v and indices[s : s + n].max() < v + m)
        for v, m, s, n in table
    )
    checks = [
        ("header format", header["format"] == "urbantwin-roofs3d/1" and header["baseElevation"] == buildings["baseElevation"] == terrain["baseElevation"],
         f"format {header['format']}; baseElevation {header['baseElevation']}"),
        ("binary layout", len(raw) == header["byteLength"] == header["rangeTable"]["byteOffset"] + count * 16
         and header["indices"]["byteOffset"] == vertices * 12 and indices_count % 3 == 0,
         f"{len(raw):,} bytes = {vertices:,}*12 + {indices_count:,}*4 + {count:,}*16"),
        ("range table", len(ids) == count == len(header["ranges"]) and contiguous and local
         and all(list(table[k]) == header["ranges"][i] for k, i in enumerate(ids)),
         "binary range table matches header ranges, ranges are contiguous and indices stay in their building"),
        ("index bounds", indices_count > 0 and int(indices.max()) < vertices, f"max index {int(indices.max()):,} < {vertices:,}"),
        ("no NaN", bool(np.isfinite(positions).all()), f"{vertices:,} finite Float32 XYZ positions"),
        ("coverage", len(ids) >= 0.95 * len(expected) and set(ids) <= set(expected),
         f"{len(ids):,}/{len(expected):,} buildings3d ids have roofs ({len(ids) / len(expected):.2%}); required >= 95%"),
        ("roof height", sum(within) >= 0.9 * len(ids),
         f"{sum(within):,}/{len(ids):,} roofs reach zBase+h within 1 m ({sum(within) / len(ids):.2%}); required >= 90%"),
        ("St. Lorenz", lorenz_top >= 70,
         f"{LORENZ} roof top {lorenz_top:.2f} m above its base (z {zmax(LORENZ):.2f} m above baseElevation); required >= 70 m"),
        ("file size", size < MAX_BYTES, f"{size:,} bytes for bin + json; required below {MAX_BYTES:,}"),
    ]
    failures = []
    for label, passed, detail in checks:
        print(f"{'PASS' if passed else 'FAIL'} {label}: {detail}", flush=True)
        if not passed:
            failures.append(label)
    if failures:
        print("Roof acceptance failed: " + ", ".join(failures), file=sys.stderr, flush=True)
        return 1
    print("PASS all roof acceptance assertions", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

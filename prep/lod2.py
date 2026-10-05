"""LoD2 CityGML -> building footprints with heights.

Outputs
  public/data/buildings.json   footprints [lng,lat] + height for the 3D map (C)
  prep/cache/buildings_utm.json  same footprints in EPSG:25832 for area/obstacle maths (A)
"""
import glob
import json
import os

from lxml import etree
from shapely.geometry import Polygon
from shapely.ops import unary_union
from shapely.validation import make_valid

from common import BBOX_UTM, DATA, cache_path, ring_ll, write_json

NS = {
    "core": "http://www.opengis.net/citygml/1.0",
    "bldg": "http://www.opengis.net/citygml/building/1.0",
    "gml": "http://www.opengis.net/gml",
    "gen": "http://www.opengis.net/citygml/generics/1.0",
}
B = "{%s}" % NS["bldg"]
GEN = "{%s}" % NS["gen"]
GML_ID = "{%s}id" % NS["gml"]
MARGIN = 150.0  # keep buildings slightly outside the bbox so edge candidates see their neighbours


def _gen_attr(el, name):
    for a in el.findall(f"{GEN}stringAttribute"):
        if a.get("name") == name:
            v = a.find(f"{GEN}value")
            return float(v.text) if v is not None and v.text else None
    return None


def _ground_polys(part):
    polys = []
    for gs in part.findall(f"{B}boundedBy/{B}GroundSurface"):
        for pl in gs.iterfind(".//gml:posList", NS):
            v = [float(t) for t in pl.text.split()]
            pts = [(v[i], v[i + 1]) for i in range(0, len(v), 3)]
            if len(pts) >= 4:
                p = make_valid(Polygon(pts))
                if not p.is_empty and p.area > 0.5:
                    polys.append(p)
    return polys


def _parts(building):
    yield building
    yield from building.iterfind(f".//{B}BuildingPart")


def parse():
    x0, y0, x1, y1 = BBOX_UTM
    x0, y0, x1, y1 = x0 - MARGIN, y0 - MARGIN, x1 + MARGIN, y1 + MARGIN
    seen, out = set(), []
    for path in sorted(glob.glob(os.path.join(DATA, "lod2", "*.gml"))):
        n = 0
        for _, el in etree.iterparse(path, tag=f"{B}Building", huge_tree=True):
            if el.getparent() is not None and el.getparent().tag.endswith("cityObjectMember"):
                bid = el.get(GML_ID)
                if bid not in seen:
                    seen.add(bid)
                    func = el.findtext(f"{B}function")
                    for i, part in enumerate(_parts(el)):
                        polys = _ground_polys(part)
                        if not polys:
                            continue
                        geom = unary_union(polys)
                        minx, miny, maxx, maxy = geom.bounds
                        if maxx < x0 or minx > x1 or maxy < y0 or miny > y1:
                            continue
                        h = part.findtext(f"{B}measuredHeight")
                        for j, g in enumerate(getattr(geom, "geoms", [geom])):
                            if g.geom_type != "Polygon" or g.area < 1:
                                continue
                            out.append({
                                "id": f"{bid}" + (f"_p{i}" if i else "") + (f"_{j}" if j else ""),
                                "h": round(float(h), 2) if h else None,
                                "z": _gen_attr(part, "HoeheGrund"),
                                "roof": _gen_attr(part, "HoeheDach"),
                                "fn": func,
                                "ring": [(round(x, 2), round(y, 2)) for x, y in g.simplify(0.2).exterior.coords],
                            })
                            n += 1
                member = el.getparent()
                el.clear()
                while member.getprevious() is not None:
                    del member.getparent()[0]
        print(f"  {os.path.basename(path)}: {n} footprints")
    return out


def main():
    print("LoD2 buildings")
    blds = parse()
    with open(cache_path("buildings_utm.json"), "w") as f:
        json.dump(blds, f)
    write_json("buildings.json", {
        "source": "LoD2 CityGML, Bayerische Vermessungsverwaltung, CC BY 4.0",
        "fields": "h = measured height (m), z = ground elevation (m a.s.l., DHHN2016)",
        "buildings": [{"id": b["id"], "h": b["h"], "z": b["z"], "polygon": ring_ll(b["ring"])} for b in blds],
    })
    print(f"  {len(blds)} footprints total")


if __name__ == "__main__":
    main()

"""OSM highways + DGM1 terrain -> walk/drive graph (public/data/graph.json).

Every edge is one OSM way segment between two consecutive nodes. Edge attributes cover everything the
persona cost functions need (steps, surface, shelter, slope) and the 3.5 t van rules at Saturday 05:30
(vehicleAllowed, oneway, plus the reasons a road is closed to the van in `vanRestrictions`).
"""
import glob
import json
import math
import os
import re
from collections import Counter, defaultdict

import numpy as np
import rasterio
from shapely.geometry import Polygon

from common import (DATA, DELIVERY_TIME, REF_DATE, ROOT, VAN, conditional_value, osm_elements, parse_num,
                    tags, to_utm, to_wgs, write_json)

FOOT_HW = {"footway", "path", "pedestrian", "steps", "living_street", "residential", "service", "unclassified",
           "tertiary", "secondary", "primary", "tertiary_link", "secondary_link", "primary_link", "platform",
           "corridor", "elevator", "track", "bridleway", "cycleway"}
CAR_HW = {"residential", "service", "unclassified", "tertiary", "secondary", "primary", "tertiary_link",
          "secondary_link", "primary_link", "living_street", "pedestrian"}
FOOT_YES = {"yes", "designated", "permissive", "destination", "customers"}
FOOT_NO = {"no", "use_sidepath", "private"}
VAN_YES = {"yes", "permissive", "destination", "delivery", "designated"}
COBBLE = {"sett", "cobblestone", "unhewn_cobblestone", "cobblestone:flattened"}
BLOCKING_BARRIERS = {"bollard", "gate", "swing_gate", "sliding_gate", "chain", "block", "cycle_barrier",
                     "height_restrictor", "jersey_barrier", "planter", "door", "turnstile", "stile", "fence",
                     "wall", "yes", "full-height_turnstile", "kissing_gate"}
SAMPLE_STEP_M = 5.0
MIN_BASELINE_M = 10.0
MAX_GRADE = 0.25  # steeper non-step edges are DGM artefacts at walls; capped and flagged slopeSuspect


# --- terrain -----------------------------------------------------------------------------------

class Terrain:
    """DGM1 1 m tiles, named <xkm>_<ykm>.tif in EPSG:25832."""

    def __init__(self, smooth_px=9):
        self.tiles, self.smooth = {}, {}
        for p in glob.glob(os.path.join(DATA, "dgm1", "*.tif")):
            kx, ky = (int(v) for v in os.path.basename(p)[:-4].split("_"))
            ds = rasterio.open(p)
            arr = ds.read(1).astype(np.float32)
            self.tiles[(kx, ky)] = (ds, arr, ds.nodata)
            self.smooth[(kx, ky)] = (ds, _box_mean(arr, smooth_px), ds.nodata)

    def z(self, x, y, smooth=False):
        t = (self.smooth if smooth else self.tiles).get((int(x // 1000), int(y // 1000)))
        if t is None:
            return None
        ds, arr, nodata = t
        r, c = ds.index(x, y)
        if not (0 <= r < arr.shape[0] and 0 <= c < arr.shape[1]):
            return None
        v = float(arr[r, c])
        return None if nodata is not None and v == nodata else v


def _box_mean(a, k):
    """k x k moving average (edge-padded), so a 1 m wall or kerb does not read as a 100 % grade."""
    p = k // 2
    base = float(a.mean())
    # float64 and mean-centred: a float32 summed-area table over 10^6 cells of ~300 m loses all precision
    s = np.pad(a.astype(np.float64) - base, p, mode="edge").cumsum(0).cumsum(1)
    s = np.pad(s, ((1, 0), (1, 0)))
    return (s[k:, k:] - s[:-k, k:] - s[k:, :-k] + s[:-k, :-k]) / (k * k) + base


def grade(terrain, x1, y1, x2, y2, length):
    """Mean absolute grade along the edge direction over a baseline of at least MIN_BASELINE_M."""
    base = max(length, MIN_BASELINE_M)
    mx, my = (x1 + x2) / 2, (y1 + y2) / 2
    ux, uy = (x2 - x1) / length, (y2 - y1) / length
    k = max(1, int(base // SAMPLE_STEP_M))
    zs = [terrain.z(mx + ux * (s / k - 0.5) * base, my + uy * (s / k - 0.5) * base, smooth=True) for s in range(k + 1)]
    zs = [z for z in zs if z is not None]
    if len(zs) < 2:
        return 0.0
    return sum(abs(b - a) for a, b in zip(zs, zs[1:])) / base


# --- tag rules ---------------------------------------------------------------------------------

def foot_allowed(t):
    hw = t["highway"]
    if hw not in FOOT_HW:
        return False
    f = t.get("foot")
    if f in FOOT_YES:
        return True
    if f in FOOT_NO:
        return False
    if t.get("access") in ("no", "private"):
        return False
    if hw == "cycleway":  # German default: foot=no on a signed cycle path
        return False
    return True


def _allowed(value):
    return any(p.strip() in VAN_YES for p in value.split(";"))


def van_rules(t):
    """-> (is_road, legal, oneway(-1/0/1), restrictions[]) for the van at REF_DATE DELIVERY_TIME."""
    hw = t["highway"]
    if hw not in CAR_HW:
        return False, False, 0, []
    restr = []
    value, source = ("no", "pedestrian zone") if hw == "pedestrian" else ("yes", None)
    for key in ("access", "vehicle", "motor_vehicle"):
        if key in t:
            value, source = t[key], f"{key}={t[key]}"
        cond = t.get(f"{key}:conditional")
        if cond:
            try:
                v = conditional_value(cond)
            except ValueError:
                v = None
                print(f"    ! unparsed condition on way: {key}:conditional={cond}")
            if v is not None:
                value, source = v, f"{key}:conditional={cond}"
    if t.get("service") == "emergency_access":
        value, source = "no", "service=emergency_access"
    legal = _allowed(value)
    if not legal:
        restr.append(source if source else f"access={value}")
    mh = t.get("maxheight")
    if mh == "below_default" or (parse_num(mh) is not None and parse_num(mh) < VAN["heightM"]):
        restr.append(f"maxheight={mh}")
    mw = parse_num(t.get("maxwidth"))
    if mw is not None and mw < VAN["widthM"]:
        restr.append(f"maxwidth={t['maxwidth']}")
    mwt = parse_num(t.get("maxweight"))
    if mwt is not None and mwt < VAN["weightT"]:
        restr.append(f"maxweight={t['maxweight']}")
    ow = t.get("oneway:motor_vehicle", t.get("oneway:vehicle", t.get("oneway")))
    oneway = 1 if ow in ("yes", "1", "true") or t.get("junction") == "roundabout" else -1 if ow == "-1" else 0
    if ow == "reversible":
        restr.append("oneway=reversible")
    return True, not restr, oneway, restr


def node_van_block(t):
    """Reason a barrier node stops the van, or None."""
    b = t.get("barrier")
    if not b:
        return None
    if any(t.get(k) and _allowed(t[k]) for k in ("motor_vehicle", "vehicle")):
        return None
    if b == "bollard":
        w = parse_num(t.get("maxwidth:physical"))
        if w is not None and w >= VAN["widthM"]:
            return None
        return "bollard" + (f" ({t['bollard']})" if t.get("bollard") else "")
    if b == "lift_gate":
        return "lift_gate" if t.get("access") in ("no", "private") else None
    if b in BLOCKING_BARRIERS:
        if t.get("access") and _allowed(t["access"]):
            return None
        return b
    return None


def _levels(t):
    out = []
    for k in ("layer", "level"):
        for p in re.split(r"[;,]", t.get(k, "")):
            n = parse_num(p.lstrip("-")) if p.strip() else None
            if n is not None:
                out.append(-n if p.strip().startswith("-") else n)
    return out


def vertical(t):
    """'underground' | 'bridge' | 'surface'. DGM1 is bare terrain, so only surface edges get terrain slope."""
    lv = _levels(t)
    if t.get("tunnel") == "yes" or t.get("location") == "underground" or (lv and max(lv) < 0):
        return "underground"
    if t.get("bridge") and t.get("bridge") != "no":
        return "bridge"
    if t.get("indoor") in ("yes", "corridor", "room") and lv and min(lv) != 0 and max(lv) > 0:
        return "bridge"  # upper-floor indoor ways: no terrain under them either
    return "surface"


def sheltered(t):
    return (t.get("covered") in ("yes", "colonnade", "arcade", "partial") or t.get("tunnel") in ("yes", "building_passage")
            or t.get("indoor") in ("yes", "corridor", "room") or t["highway"] in ("corridor", "elevator"))


def incline_grade(t):
    v = t.get("incline", "")
    m = re.match(r"^-?([0-9.]+)%$", v)
    return float(m.group(1)) / 100 if m else 0.0


# --- build -------------------------------------------------------------------------------------

def build():
    els = osm_elements()
    node_tags = {e["id"]: tags(e) for e in els if e["type"] == "node" and tags(e)}
    ways = [e for e in els if e["type"] == "way" and "highway" in tags(e)
            and tags(e)["highway"] not in ("construction", "proposed", "bus_stop", "raceway")]
    terrain = Terrain()

    use = Counter()
    for w in ways:
        use.update(set(w["nodes"]))

    nodes, index = [], {}

    def node(osm_id, lng, lat, under):
        i = index.get(osm_id)
        if i is None:
            x, y = to_utm(lng, lat)
            i = index[osm_id] = len(nodes)
            nodes.append({"osm": osm_id, "lng": round(lng, 7), "lat": round(lat, 7), "x": x, "y": y,
                          "z": None, "under": True})
        if not under:
            nodes[i]["under"] = False
        return i

    edges, stats = [], Counter()

    def add_edge(a, b, t, wid, kind):
        na, nb = nodes[a], nodes[b]
        length = math.hypot(nb["x"] - na["x"], nb["y"] - na["y"])
        if length < 0.05:
            return
        foot = foot_allowed(t)
        road, legal, oneway, restr = van_rules(t)
        if not foot and not road:
            return
        edges.append({"a": a, "b": b, "len": length, "t": t, "way": wid, "kind": kind, "foot": foot,
                      "road": road, "legal": legal, "oneway": oneway, "restr": list(restr)})

    for w in ways:
        t = tags(w)
        under = vertical(t) != "surface"
        ids = [node(nid, g["lon"], g["lat"], under) for nid, g in zip(w["nodes"], w["geometry"])]
        for a, b in zip(ids, ids[1:]):
            add_edge(a, b, t, w["id"], vertical(t))
        # Open pedestrian squares: walking straight across, not only along the outline.
        if t.get("area") == "yes" and t["highway"] == "pedestrian" and w["nodes"][0] == w["nodes"][-1]:
            ring = Polygon([(nodes[i]["x"], nodes[i]["y"]) for i in ids])
            if ring.is_valid and ring.area > 0:
                p = ring.representative_point()
                lng, lat = to_wgs(p.x, p.y)
                hub = node(-w["id"], lng, lat, under)
                nodes[hub]["hub"] = t.get("name") or f"way {w['id']}"
                for nid, i in zip(w["nodes"], ids):
                    if use[nid] > 1:
                        add_edge(hub, i, t, w["id"], vertical(t))
                stats["hubs"] += 1

    # terrain heights for every node that has ground under it
    for n in nodes:
        if not n["under"]:
            n["z"] = terrain.z(n["x"], n["y"])

    # barrier / feature nodes
    for n in nodes:
        t = node_tags.get(n["osm"], {})
        if t.get("barrier"):
            n["barrier"] = t["barrier"] + (f":{t['bollard']}" if t.get("bollard") else "")
            blk = node_van_block(t)
            if blk:
                n["vanBlock"] = blk
        if t.get("highway") == "elevator":
            n["elevator"] = True
        if t.get("railway") == "subway_entrance":
            n["entrance"] = t.get("name") or "U-Bahn"
            if t.get("wheelchair"):
                n["entranceWheelchair"] = t["wheelchair"]

    out_edges = []
    for e in edges:
        na, nb, t = nodes[e["a"]], nodes[e["b"]], e["t"]
        # slope from the smoothed terrain; tunnels/bridges/indoor fall back to the incline tag
        if e["kind"] == "surface" and na["z"] is not None and nb["z"] is not None:
            slope = grade(terrain, na["x"], na["y"], nb["x"], nb["y"], e["len"])
            rise = nb["z"] - na["z"]
            suspect = slope > MAX_GRADE and t["highway"] != "steps"
            if suspect:  # wall / facade artefact of the interpolated DGM, not a walkable grade
                slope = MAX_GRADE
                stats["capped"] += 1
        else:
            slope, rise, suspect = incline_grade(t), 0.0, False
        restr = list(e["restr"])
        for nd in (na, nb):
            if e["road"] and nd.get("vanBlock"):
                restr.append(f"{nd['vanBlock']} (node {nd['osm']})")
        a, b, oneway = e["a"], e["b"], e["oneway"]
        if oneway == -1:
            a, b, oneway = b, a, 1
        surface = t.get("surface")
        rec = {"a": a, "b": b, "len": round(e["len"], 2), "foot": e["foot"],
               "vehicleAllowed": e["road"] and not restr,
               "slope": round(slope, 4), "rise": round(rise if a == e["a"] else -rise, 2),
               "way": e["way"], "hw": t["highway"]}
        if e["road"] and oneway:
            rec["oneway"] = True
        if t["highway"] == "steps":
            rec["steps"] = True
        if any(nodes[i].get("barrier", "").startswith("bollard") for i in (a, b)):
            rec["bollard"] = True
        if surface:
            rec["surface"] = surface
        if surface in COBBLE:
            rec["cobble"] = True
        if sheltered(t):
            rec["sheltered"] = True
        if suspect:
            rec["slopeSuspect"] = True
        if e["kind"] != "surface":
            rec["level"] = e["kind"]
        if t.get("name"):
            rec["name"] = t["name"]
        if t.get("wheelchair"):
            rec["wheelchair"] = t["wheelchair"]
        if t.get("footway") == "crossing" or t.get("highway") == "crossing":
            rec["crossing"] = True
        if e["road"]:
            rec["vanRoad"] = True  # physically a road a van could drive on, legal or not
            if restr:
                rec["vanRestrictions"] = restr
        out_edges.append(rec)
        stats["edges"] += 1
        stats["foot"] += rec["foot"]
        stats["van"] += rec["vehicleAllowed"]

    out_nodes = []
    for n in nodes:
        rec = {"lng": n["lng"], "lat": n["lat"]}
        if n["z"] is not None:
            rec["z"] = round(n["z"], 2)
        rec["osm"] = n["osm"]
        for k in ("barrier", "vanBlock", "elevator", "entrance", "entranceWheelchair", "hub"):
            if k in n:
                rec[k] = n[k]
        out_nodes.append(rec)

    # sourced connections OSM cannot express (prep/sites.json graphOverrides)
    with open(os.path.join(ROOT, "prep", "sites.json"), encoding="utf-8") as f:
        overrides = json.load(f).get("graphOverrides", [])
    by_osm = {n["osm"]: i for i, n in enumerate(nodes)}
    for o in overrides:
        a, b = by_osm.get(o["from"]), by_osm.get(o["to"])
        if a is None or b is None:
            raise ValueError(f"graph override {o['id']}: OSM node not in graph")
        na, nb = nodes[a], nodes[b]
        rec = {"a": a, "b": b, "len": round(math.hypot(nb["x"] - na["x"], nb["y"] - na["y"]), 2), "foot": True,
               "vehicleAllowed": False, "slope": 0.0, "rise": 0.0, "way": 0, "hw": o["hw"], "sheltered": True,
               "name": o["name"], "override": o["id"], "source": o["source"]}
        if o.get("openingHours"):
            rec["openingHours"] = o["openingHours"]
        out_edges.append(rec)
        print(f"  override {o['id']}: node {o['from']} <-> {o['to']} ({rec['len']} m, {o.get('openingHours', 'always')})")

    print(f"  {len(out_nodes)} nodes, {stats['edges']} edges ({stats['foot']} walkable, {stats['van']} van-legal), "
          f"{stats['hubs']} square hubs, {sum('vanBlock' in n for n in out_nodes)} van-blocking barrier nodes, "
          f"{stats['capped']} slopes capped")
    return {
        "meta": {
            "source": "OpenStreetMap contributors (ODbL); DGM1 Bayerische Vermessungsverwaltung (CC BY 4.0)",
            "crs": "EPSG:4326 lng/lat; len and z in metres",
            "slope": f"mean absolute grade along the edge direction on 9 m-smoothed DGM1, baseline >= {MIN_BASELINE_M:.0f} m; "
                     f"capped at {MAX_GRADE:.0%} (slopeSuspect) for non-step edges; "
                     "tunnels, bridges and indoor ways use the OSM incline tag or 0",
            "vanRules": f"vehicleAllowed = legal for a {VAN['weightT']} t van ({VAN['heightM']} m high, {VAN['widthM']} m wide) "
                        f"on {REF_DATE.isoformat()} ({REF_DATE.strftime('%A')}) at {DELIVERY_TIME}, incl. barrier nodes; "
                        "oneway edges are stored in their legal direction (a -> b)",
        },
        "nodes": out_nodes,
        "edges": out_edges,
    }


def main():
    print("Graph")
    write_json("graph.json", build())


if __name__ == "__main__":
    main()

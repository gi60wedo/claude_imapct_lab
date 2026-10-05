"""Discover candidate market sites and compute their indicators -> public/data/candidates.json.

Every number is derived from the datasets; the evidence block records how (route, blocker, nearest stop),
so a judge can be shown *why* a site passes or fails. Filtering and ranking happen in src/rank (TypeScript),
which `npm run rank:bake` applies to this file in place.
"""
import heapq
import json
import math
import os
from collections import defaultdict

from shapely import STRtree
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import nearest_points, unary_union
from shapely.prepared import prep
from shapely.validation import make_valid

from common import (BBOX_UTM, CACHE, DELIVERY_TIME, OUT, REF_DATE, ROOT, VAN, ll, osm_elements, ring_ll, slug,
                    tags, to_utm, write_json)

ACCESS_BUFFER_M = {"square": 10.0, "pedestrian": 10.0, "ground_floor": 25.0}
FOOT_CUTOFF_M = 1200.0
STOP_RADIUS_M = 300.0       # transit frequency counted within this walk
WALK_RADIUS_M = 300.0       # walkability measured on the network within this walk
POP_RADIUS_M = 800.0
POI_RADIUS_M = 400.0
LOADING_SEARCH_M = 300.0    # van stops considered around a site
SOURCE_EDGE_M = 150.0       # vans enter from arterial roads at the edge of the study area
ARTERIAL = {"primary", "secondary", "tertiary", "primary_link", "secondary_link", "tertiary_link"}
RESTRICTION_COST = 10000.0  # blocker analysis: one restriction outweighs any detour
ATTRACTION_TOURISM = {"attraction", "museum", "artwork", "gallery", "viewpoint", "zoo", "theme_park"}
NOT_ATTRACTION_HISTORIC = {"memorial", "wayside_cross", "wayside_shrine", "boundary_stone", "milestone", "no", "yes"}
FOOD = {"restaurant", "cafe", "fast_food", "bar", "pub", "ice_cream", "biergarten"}


# --- loading -----------------------------------------------------------------------------------

def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


class Graph:
    def __init__(self, g):
        self.nodes = g["nodes"]
        self.edges = g["edges"]
        for n in self.nodes:
            n["x"], n["y"] = to_utm(n["lng"], n["lat"])
        self.foot = defaultdict(list)
        self.van_fwd, self.van_rev = defaultdict(list), defaultdict(list)
        self.road = defaultdict(list)  # relaxed: physical roads with restriction counts
        for i, e in enumerate(self.edges):
            a, b, L = e["a"], e["b"], e["len"]
            if e["foot"]:
                self.foot[a].append((b, L, i))
                self.foot[b].append((a, L, i))
            if e["vehicleAllowed"]:
                self.van_fwd[a].append((b, L, i))
                self.van_rev[b].append((a, L, i))
                if not e.get("oneway"):
                    self.van_fwd[b].append((a, L, i))
                    self.van_rev[a].append((b, L, i))
            if e.get("vanRoad"):
                r = len(e.get("vanRestrictions", []))
                self.road[a].append((b, L + RESTRICTION_COST * r, i, False))
                self.road[b].append((a, L + RESTRICTION_COST * (r + (1 if e.get("oneway") else 0)), i, bool(e.get("oneway"))))
        self.foot_nodes = sorted({k for k in self.foot})
        self.tree = STRtree([Point(self.nodes[i]["x"], self.nodes[i]["y"]) for i in self.foot_nodes])

    def foot_nodes_within(self, geom, d):
        return [self.foot_nodes[j] for j in self.tree.query(geom.buffer(d), predicate="intersects")]

    def nearest_foot_node(self, x, y):
        j = self.tree.nearest(Point(x, y))
        i = self.foot_nodes[j]
        return i, math.hypot(self.nodes[i]["x"] - x, self.nodes[i]["y"] - y)


def dijkstra(adj, sources, cutoff=math.inf):
    """sources: {node: start_cost}. Returns (dist, pred) where pred[v] = (u, edge_index, reversed_oneway)."""
    dist, pred = dict(sources), {}
    pq = [(c, s) for s, c in sources.items()]
    heapq.heapify(pq)
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist.get(u, math.inf) or d > cutoff:
            continue
        for item in adj.get(u, ()):
            v, w, ei = item[0], item[1], item[2]
            nd = d + w
            if nd < dist.get(v, math.inf) and nd <= cutoff:
                dist[v] = nd
                pred[v] = (u, ei, item[3] if len(item) > 3 else False)
                heapq.heappush(pq, (nd, v))
    return dist, pred


def path_to(pred, v):
    out = []
    while v in pred:
        u, ei, rev = pred[v]
        out.append((u, v, ei, rev))
        v = u
    return out[::-1]


# --- discovery ---------------------------------------------------------------------------------

def way_polygon(e):
    g = e.get("geometry") or []
    if len(g) < 4 or e["nodes"][0] != e["nodes"][-1]:
        return None
    p = make_valid(Polygon([to_utm(q["lon"], q["lat"]) for q in g]))
    if p.geom_type == "MultiPolygon":
        p = max(p.geoms, key=lambda q: q.area)
    return p if p.geom_type == "Polygon" and p.area > 1 else None


def element_point(e):
    if e["type"] == "node":
        return Point(to_utm(e["lon"], e["lat"]))
    b = e.get("bounds")
    if not b:
        return None
    return Point(to_utm((b["minlon"] + b["maxlon"]) / 2, (b["minlat"] + b["maxlat"]) / 2))


def is_vacant(t):
    return t.get("shop") == "vacant" or any(k.startswith("disused:") for k in t)


def discover(els, sites):
    by_key = {f"{e['type']}/{e['id']}": e for e in els}
    found = []
    for e in els:
        t = tags(e)
        if e["type"] != "way":
            continue
        if t.get("place") == "square":
            kind = "square"
        elif t.get("highway") == "pedestrian" and t.get("area") == "yes":
            kind = "pedestrian"
        elif "building" in t and is_vacant(t):
            kind = "ground_floor"
        else:
            continue
        poly = way_polygon(e)
        if poly is None:
            continue
        if kind == "ground_floor" and poly.area < sites["minGroundFloorM2"]:
            continue
        found.append({"kind": kind, "name": t.get("name") or t.get("old_name"), "geom": poly,
                      "osm": [f"way/{e['id']}"], "tags": t})

    # merge duplicates (e.g. Hauptmarkt is both place=square and a pedestrian area)
    merged = []
    for c in sorted(found, key=lambda c: (c["kind"] != "square", -c["geom"].area)):
        for m in merged:
            inter = m["geom"].intersection(c["geom"]).area
            if inter / min(m["geom"].area, c["geom"].area) > 0.5 or (c["name"] and c["name"] == m["name"] and inter > 0):
                m["geom"] = unary_union([m["geom"], c["geom"]])
                m["osm"] += c["osm"]
                m["name"] = m["name"] or c["name"]
                break
        else:
            merged.append(c)

    # benchmarks replace whatever discovery found at the same place
    benches = []
    for b in sites["benchmarks"]:
        if "osm" in b:
            geom = unary_union([way_polygon(by_key[k]) for k in b["osm"]])
        else:
            lines = [LineString([to_utm(q["lon"], q["lat"]) for q in by_key[k]["geometry"]]) for k in b["osmLines"]]
            geom = unary_union(lines).buffer(b["bufferM"], cap_style="flat", join_style="mitre").buffer(0)
        if "clipAround" in b:  # keep only the part of the outline near a landmark (e.g. the church)
            geom = geom.intersection(way_polygon(by_key[b["clipAround"]]).buffer(b["clipM"]))
            if geom.geom_type == "MultiPolygon":
                geom = max(geom.geoms, key=lambda g: g.area)
        benches.append({"kind": "benchmark", "baseKind": b["baseKind"], "id": b["id"], "name": b["name"], "geom": geom,
                        "osm": b.get("osm") or b["osmLines"], "note": b.get("note")})
    out = list(benches)
    for c in merged:
        hit = next((b for b in benches if b["geom"].intersection(c["geom"]).area / c["geom"].area > 0.3), None)
        if hit:  # benchmarks keep exactly the outline defined in sites.json
            hit["osm"] = list(dict.fromkeys(hit["osm"] + c["osm"]))
            continue
        c["baseKind"] = c["kind"]
        out.append(c)
    return out


# --- per-site indicators -----------------------------------------------------------------------

def main():
    print("Candidates")
    els = osm_elements()
    sites = load_json(os.path.join(ROOT, "prep", "sites.json"))
    G = Graph(load_json(os.path.join(OUT, "graph.json")))
    blds = load_json(os.path.join(CACHE, "buildings_utm.json"))
    bld_geoms = [make_valid(Polygon(b["ring"])) for b in blds]
    bld_tree = STRtree(bld_geoms)
    cells = load_json(os.path.join(CACHE, "population_utm.json"))
    cell_tree = STRtree([Point(c["x"], c["y"]) for c in cells])
    stations = [s for s in load_json(os.path.join(CACHE, "stations_utm.json")) if s["departuresTotal"] > 0]

    shops, attractions, food = [], [], []
    for e in els:
        t = tags(e)
        p = None
        if ("shop" in t and not is_vacant(t) and t["shop"] not in ("no",)) or t.get("amenity") in FOOD \
                or t.get("tourism") in ATTRACTION_TOURISM or t.get("amenity") == "place_of_worship" \
                or (t.get("historic") and t["historic"] not in NOT_ATTRACTION_HISTORIC):
            p = element_point(e)
        if p is None:
            continue
        if "shop" in t and not is_vacant(t):
            shops.append(p)
        if t.get("amenity") in FOOD:
            food.append(p)
        if t.get("tourism") in ATTRACTION_TOURISM or t.get("amenity") == "place_of_worship" \
                or (t.get("historic") and t["historic"] not in NOT_ATTRACTION_HISTORIC):
            attractions.append(p)
    shop_tree, attr_tree, food_tree = STRtree(shops), STRtree(attractions), STRtree(food)

    # --- vans: where can a legal 05:30 van go, and get back out? ---------------------------------
    x0, y0, x1, y1 = BBOX_UTM
    inner = Polygon([(x0, y0), (x1, y0), (x1, y1), (x0, y1)]).buffer(-SOURCE_EDGE_M)
    sources = {}
    for e in G.edges:
        if e["vehicleAllowed"] and e["hw"] in ARTERIAL:
            for i in (e["a"], e["b"]):
                n = G.nodes[i]
                if not inner.contains(Point(n["x"], n["y"])):
                    sources[i] = 0.0
    van_in, van_pred = dijkstra(G.van_fwd, sources)
    van_out, _ = dijkstra(G.van_rev, sources)
    van_ok = [i for i in van_in if i in van_out and not G.nodes[i].get("vanBlock")]
    van_tree_nodes = van_ok
    van_tree = STRtree([Point(G.nodes[i]["x"], G.nodes[i]["y"]) for i in van_ok])
    road_dist, road_pred = dijkstra(G.road, sources)
    road_nodes = sorted({i for e in G.edges if e.get("vanRoad") for i in (e["a"], e["b"])})
    road_tree = STRtree([Point(G.nodes[i]["x"], G.nodes[i]["y"]) for i in road_nodes])
    print(f"  van: {len(sources)} entry nodes at the edge of the study area, {len(van_ok)} nodes reachable and exitable")

    def trolley(i, geom, foot_dist):
        """Distance a vendor pushes a trolley from van stop i to the site: walk network, else a clear straight line."""
        n = G.nodes[i]
        best = foot_dist.get(i, math.inf)
        pt = Point(n["x"], n["y"])
        if geom.contains(pt):
            return 0.0
        a, b = nearest_points(pt, geom)
        seg = LineString([a, b])
        if not any(bld_geoms[j].intersection(seg).length > 0.5 for j in bld_tree.query(seg)):
            best = min(best, seg.length)
        return best

    def node_ll(i):
        return [G.nodes[i]["lng"], G.nodes[i]["lat"]]

    def street_name_near(geom):
        best, name = math.inf, None
        for i in G.foot_nodes_within(geom, 40):
            for v, L, ei in G.foot[i]:
                nm = G.edges[ei].get("name")
                if nm:
                    d = Point(G.nodes[i]["x"], G.nodes[i]["y"]).distance(geom)
                    if d < best:
                        best, name = d, nm
        return name

    found = discover(els, sites)
    deny = sites.get("deny", {})
    out, ids = [], set()
    for c in found:
        geom, base = c["geom"], c["baseKind"]
        if not c.get("name"):
            near = street_name_near(geom)
            c["name"] = f"Unnamed square by {near}" if near else f"Unnamed square ({c['osm'][0]})"
        cid = c.get("id") or slug(c["name"])
        while cid in ids:
            cid += "-2"
        ids.add(cid)

        # area: open space minus LoD2 buildings; a ground floor is its LoD2 footprint
        near_b = [bld_geoms[j] for j in bld_tree.query(geom)]
        built = unary_union([b.intersection(geom) for b in near_b]) if near_b else None
        built_area = built.area if built is not None else 0.0
        area = (built_area or geom.area) if base == "ground_floor" else geom.area - built_area

        # walking network around the site
        access = G.foot_nodes_within(geom, ACCESS_BUFFER_M[base])
        if not access:
            i, d = G.nearest_foot_node(geom.centroid.x, geom.centroid.y)
            access = [i]
        start = {i: Point(G.nodes[i]["x"], G.nodes[i]["y"]).distance(geom) for i in access}
        fd, _ = dijkstra(G.foot, start, FOOT_CUTOFF_M)
        hubs = [i for i in access if G.nodes[i].get("hub")]
        site_node = hubs[0] if hubs else min(access, key=lambda i: Point(G.nodes[i]["x"], G.nodes[i]["y"]).distance(geom.centroid))

        # transit: walking distance from the site to each station's closest platform
        stop_walk = []
        for s in stations:
            best_s = math.inf
            for px, py in s["platformsUtm"]:
                i, snap = G.nearest_foot_node(px, py)
                if i in fd:
                    best_s = min(best_s, fd[i] + snap)
            if math.isfinite(best_s):
                stop_walk.append((best_s, s))
        stop_walk.sort(key=lambda t: t[0])
        nearest = stop_walk[0] if stop_walk else (math.inf, None)
        near_stops = [(d, s) for d, s in stop_walk if d <= STOP_RADIUS_M]
        deps300 = sum(s["departuresTotal"] for _, s in near_stops)
        subway300 = sum(s["departures"].get("subway", 0) for _, s in near_stops)

        # walkability on the network within WALK_RADIUS_M
        L = cob = steps = slope_len = 0.0
        crossings = 0
        for ei, e in enumerate(G.edges):
            if e["foot"] and fd.get(e["a"], math.inf) <= WALK_RADIUS_M and fd.get(e["b"], math.inf) <= WALK_RADIUS_M:
                L += e["len"]
                cob += e["len"] if e.get("cobble") else 0
                steps += e["len"] if e.get("steps") else 0
                slope_len += e["len"] * (0 if e.get("steps") else e["slope"])
                crossings += 1 if e.get("crossing") else 0
        cobble_share = cob / L if L else 0
        step_share = steps / L if L else 0
        mean_grade = slope_len / L if L else 0
        walk_score = 100 * (1 - 0.4 * cobble_share - 0.3 * min(1, mean_grade / 0.06) - 0.3 * min(1, step_share / 0.10))

        # people and places around
        cell_ix = cell_tree.query(geom.buffer(POP_RADIUS_M), predicate="intersects")
        pop = sum(cells[j]["pop"] for j in cell_ix)
        with65 = [cells[j] for j in cell_ix if cells[j]["share65"] is not None]
        p65 = sum(c2["pop"] for c2 in with65)
        senior = sum(c2["pop"] * c2["share65"] / 100 for c2 in with65) / p65 if p65 else None
        zone = geom.buffer(POI_RADIUS_M)
        retail = len(shop_tree.query(zone, predicate="intersects"))
        attr = len(attr_tree.query(zone, predicate="intersects"))
        n_food = len(food_tree.query(zone, predicate="intersects"))

        # delivery: nearest legal van stop by trolley distance
        best = (math.inf, None)
        for j in van_tree.query(geom.buffer(LOADING_SEARCH_M)):
            i = van_tree_nodes[j]
            d = trolley(i, geom, fd)
            if d < best[0]:
                best = (d, i)
        van_dist, load_node = best
        delivery = load_node is not None and van_dist <= 80.0
        ev = {"baseKind": base, "osm": c["osm"], "centroid": ll(geom.centroid.x, geom.centroid.y),
              "builtAreaM2": round(built_area, 1), "outlineAreaM2": round(geom.area, 1),
              "siteNode": site_node, "accessNodes": sorted(access),
              "nearestStop": {"name": nearest[1]["name"], "walkM": round(nearest[0], 1)} if nearest[1] else None,
              "stopsWithin300m": [{"name": s["name"], "walkM": round(d, 1), "departures": s["departuresTotal"]} for d, s in near_stops],
              "departures300m": deps300, "subwayDepartures300m": subway300,
              "walk": {"cobbleShare": round(cobble_share, 3), "stepShare": round(step_share, 3),
                       "meanGradePct": round(100 * mean_grade, 2), "crossings": crossings, "networkM": round(L)},
              "seniorShare800m": round(senior, 4) if senior is not None else None,
              "food400m": n_food}
        if c.get("note"):
            ev["note"] = c["note"]
        if load_node is not None:
            # stalls stand across the whole open space, so also report the walk to its centre (siteNode).
            # Not defined for ground floors: the walk graph has no indoor ways.
            if base != "ground_floor":
                to_centre, _ = dijkstra(G.foot, {site_node: 0.0}, FOOT_CUTOFF_M)
                ln = G.nodes[load_node]
                j, snap = (load_node, 0.0) if load_node in to_centre else G.nearest_foot_node(ln["x"], ln["y"])
                ev["vanToCentreM"] = round(to_centre[j] + snap, 1) if j in to_centre else None
            route = path_to(van_pred, load_node)
            ev["loadingPoint"] = node_ll(load_node)
            ev["vanRoute"] = [node_ll(route[0][0])] + [node_ll(v) for _, v, _, _ in route] if route else [node_ll(load_node)]
            ev["vanRouteM"] = round(van_in[load_node], 1)

        if not delivery:
            # Where would a van have to break a rule? Cheapest physical route to a road next to the site.
            targets = []
            for j in road_tree.query(geom.buffer(80.0)):
                i = road_nodes[j]
                if i in road_dist and trolley(i, geom, fd) <= 80.0:
                    targets.append(i)
            if targets:
                tgt = min(targets, key=lambda i: road_dist[i])
                blockers = []
                for u, v, ei, rev in path_to(road_pred, tgt):
                    e = G.edges[ei]
                    reasons = list(e.get("vanRestrictions", [])) + (["against oneway"] if rev else [])
                    for r in reasons:
                        blockers.append({"restriction": r, "street": e.get("name"),
                                         "at": node_ll(u if "node" not in r else (e["a"] if G.nodes[e["a"]].get("vanBlock") else e["b"]))})
                seen, uniq = set(), []
                for b in blockers:
                    k = (b["restriction"], b["street"])
                    if k not in seen:
                        seen.add(k)
                        uniq.append(b)
                ev["vanBlockers"] = uniq
                ev["blockedBy"] = uniq[0] if uniq else None
            else:
                ev["blockedBy"] = {"restriction": "no road within 80 m", "street": None, "at": ev["centroid"]}

        key = c["osm"][0]
        if key in deny:
            ev["manualExclusion"] = deny[key]

        out.append({
            "id": cid, "name": c["name"], "kind": c["kind"],
            "polygon": ring_ll(geom.exterior.coords) if geom.geom_type == "Polygon" else ring_ll(max(geom.geoms, key=lambda g: g.area).exterior.coords),
            "areaM2": round(area, 1),
            "indicators": {
                "transitScore": 0,  # normalised below
                "walkScore": round(max(0.0, walk_score), 1),
                "population800m": pop,
                "retailPoi400m": retail,
                "attractions400m": attr,
                "deliveryAccess": delivery,
                "vanDistM": round(van_dist, 1) if math.isfinite(van_dist) else -1,
            },
            "passedFilter": False,
            "evidence": ev,
        })

    # transitScore: Saturday departures within a 300 m walk, log-scaled against the best-served site
    ref = max((c["evidence"]["departures300m"] for c in out), default=0)
    for c in out:
        d = c["evidence"]["departures300m"]
        c["indicators"]["transitScore"] = round(100 * math.log1p(d) / math.log1p(ref), 1) if ref else 0

    write_json("candidates.json", {
        "meta": {
            "sources": ["OpenStreetMap contributors (ODbL)", "LoD2 + DGM1: Bayerische Vermessungsverwaltung, CC BY 4.0",
                        "Zensus 2022: Destatis, dl-de/by-2-0", "VGN GTFS open data"],
            "referenceDay": f"{REF_DATE.isoformat()} ({REF_DATE.strftime('%A')})", "deliveryTime": DELIVERY_TIME, "van": VAN,
            "definitions": {
                "areaM2": "open area = outline minus LoD2 building footprints; ground_floor = LoD2 footprint",
                "transitScore": f"100 * ln(1 + Saturday departures within a {STOP_RADIUS_M:.0f} m walk) / ln(1 + best site's)",
                "walkScore": f"100 - 40*cobbleShare - 30*min(1, meanGrade/6%) - 30*min(1, stepShare/10%) on the walk network within {WALK_RADIUS_M:.0f} m",
                "population800m": f"Zensus residents in 100 m cells within {POP_RADIUS_M:.0f} m of the site",
                "retailPoi400m": f"OSM shops (not vacant) within {POI_RADIUS_M:.0f} m",
                "attractions400m": f"OSM tourism attractions/museums/artworks, historic sites and places of worship within {POI_RADIUS_M:.0f} m",
                "deliveryAccess": "a legal van route enters from the edge of the study area, reaches a stop within 80 m (walk) of the site, and can leave again",
                "vanDistM": "trolley distance from the nearest legal van stop to the site (-1 = no legal stop within 300 m)",
                "evidence.vanToCentreM": "walk from that van stop to the centre of the open space (squares and plazas only)",
            },
        },
        "candidates": out,
    })
    for c in out:
        i, ev = c["indicators"], c["evidence"]
        blk = ev.get("blockedBy")
        print(f"  {c['id']:<34} {c['kind']:<12} {c['areaM2']:>7.0f} m2  stop {ev['nearestStop']['walkM'] if ev['nearestStop'] else '-':>6} m"
              f"  dep300 {ev['departures300m']:>5}  walk {i['walkScore']:>5}  van {'OK ' if i['deliveryAccess'] else 'NO '}{i['vanDistM']:>6} m"
              + (f"  <- {blk['restriction']} @ {blk['street']}" if blk else ""))


if __name__ == "__main__":
    main()

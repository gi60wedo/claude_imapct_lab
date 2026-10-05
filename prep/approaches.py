"""Approach routes into each site and the Lorenzkirche-vs-Kaufhof preference grid.

Adds to every candidate in candidates.json (evidence):
  stepFreeArrival   best step-free public-transport arrival, at market opening and at peak (lift hours matter)
  climbHomeM        population-weighted climb residents face on the way home (with full bags)
  residentsStepFreeShare, rainCover
Writes
  approaches.json   focus sites + baseline: every route (stations, 8 resident directions) with conditions + profile
  preference.json   Zensus cells: walk and senior effort to each focus site -> which one is preferable from there
"""
import heapq
import json
import math
import os
from collections import Counter, defaultdict

from shapely import STRtree
from shapely.geometry import Point

from common import (CACHE, OUT, REF_DATE, ROOT, condition_active, ll, osm_elements, parse_num, tags, to_utm,
                    write_json)

TIMES = {"opening": "07:30", "peak": "11:30"}   # market opens / Saturday peak
RES_RADIUS_M = 1500
SECTORS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
N_STATIONS = 8               # nearest stations checked for a step-free arrival
N_STATION_ROUTES = 3         # stations listed in approaches.json
WALK_MS, SENIOR_MS = 1.3, 0.8
BAD_SMOOTH = {"bad", "very_bad", "horrible", "very_horrible", "impassable"}
TIE_M = 25                   # preference: closer than this counts as equal


def load(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


class Net:
    def __init__(self):
        g = load(os.path.join(OUT, "graph.json"))
        self.N, self.E = g["nodes"], g["edges"]
        for n in self.N:
            n["x"], n["y"] = to_utm(n["lng"], n["lat"])
        self.adj = defaultdict(list)
        for i, e in enumerate(self.E):
            if e["foot"]:
                self.adj[e["a"]].append((e["b"], i, 1))
                self.adj[e["b"]].append((e["a"], i, -1))
        self.foot = sorted(self.adj)
        self.tree = STRtree([Point(self.N[i]["x"], self.N[i]["y"]) for i in self.foot])
        self.under = [i for i in self.foot if "z" not in self.N[i]]
        self.under_tree = STRtree([Point(self.N[i]["x"], self.N[i]["y"]) for i in self.under])
        self.way_tags = {e["id"]: tags(e) for e in osm_elements() if e["type"] == "way"}
        self.node_tags = {e["id"]: tags(e) for e in osm_elements() if e["type"] == "node" and tags(e)}

    def nearest(self, x, y, underground=False):
        nodes, t = (self.under, self.under_tree) if underground else (self.foot, self.tree)
        i = nodes[t.nearest(Point(x, y))]
        return i, math.hypot(self.N[i]["x"] - x, self.N[i]["y"] - y)

    @staticmethod
    def open_at(e, when):
        oh = e.get("openingHours")
        return True if not oh or when is None else condition_active(oh, REF_DATE, when)

    def cost_walk(self, when=None):
        return lambda e: e["len"] if self.open_at(e, when) else math.inf

    def cost_senior(self, when):
        def c(e):
            if e.get("steps") or not self.open_at(e, when):
                return math.inf
            return e["len"] * (2.5 if e.get("cobble") else 1.1) * (1 + 8 * max(0.0, e["slope"] - 0.06))
        return c

    def tree_from(self, sources, cost):
        """Dijkstra outward from the site. pred[v] = (u, edge, dir u->v); walking v -> u heads to the site."""
        dist, pred, pq = dict(sources), {}, [(d, s) for s, d in sources.items()]
        heapq.heapify(pq)
        while pq:
            d, u = heapq.heappop(pq)
            if d > dist[u]:
                continue
            for v, ei, dr in self.adj[u]:
                w = cost(self.E[ei])
                if w == math.inf:
                    continue
                nd = d + w
                if nd < dist.get(v, math.inf):
                    dist[v], pred[v] = nd, (u, ei, dr)
                    heapq.heappush(pq, (nd, v))
        return dist, pred

    def path_to_site(self, pred, origin):
        """[(edge, dir)] walked from origin towards the site; [] if origin is on the site; None if unreachable."""
        out, v = [], origin
        while v in pred:
            u, ei, dr = pred[v]
            out.append((ei, -dr))
            v = u
        return out

    def describe(self, path, start):
        N, E = self.N, self.E
        L = cob = shelter = lit = steep = bad = narrow = climb = descent = 0.0
        max_grade, steps, step_count, crossings, kerbs = 0.0, 0, 0, 0, 0
        surfaces, worst, lifts = Counter(), [], []
        coords, prof, s, cur = [], [], 0.0, start
        for ei, dr in path:
            e = E[ei]
            t = self.way_tags.get(e["way"], {})
            nxt = e["b"] if dr == 1 else e["a"]
            n0 = N[cur]
            coords.append([n0["lng"], n0["lat"], n0.get("z")])
            if n0.get("z") is not None:
                prof.append([round(s, 1), n0["z"]])
            L += e["len"]
            s += e["len"]
            rise = e["rise"] * dr
            climb += max(0.0, rise)
            descent += max(0.0, -rise)
            surfaces[e.get("surface") or "unknown"] += e["len"]
            cob += e["len"] if e.get("cobble") else 0
            shelter += e["len"] if e.get("sheltered") else 0
            lit += e["len"] if t.get("lit") in ("yes", "24/7", "automatic") else 0
            bad += e["len"] if t.get("smoothness") in BAD_SMOOTH else 0
            w = parse_num(t.get("width"))
            narrow += e["len"] if w is not None and w < 1.5 else 0
            if not e.get("steps") and not e.get("slopeSuspect"):
                max_grade = max(max_grade, e["slope"])
                if e["slope"] > 0.06:
                    steep += e["len"]
                    worst.append((e["slope"], e.get("name") or e["hw"]))
            if e.get("steps"):
                steps += 1
                step_count += int(parse_num(t.get("step_count")) or 0)
            crossings += 1 if e.get("crossing") else 0
            kerbs += 1 if self.node_tags.get(N[nxt]["osm"], {}).get("kerb") == "raised" else 0
            if e.get("override"):
                lifts.append({"name": e["name"], "openingHours": e.get("openingHours")})
            cur = nxt
        n0 = N[cur]
        coords.append([n0["lng"], n0["lat"], n0.get("z")])
        if n0.get("z") is not None:
            prof.append([round(s, 1), n0["z"]])
        seen, steepest = set(), []
        for gr, nm in sorted(worst, reverse=True):
            if nm not in seen:
                seen.add(nm)
                steepest.append({"where": nm, "gradePct": round(100 * gr, 1)})
        f = lambda v: round(v / L, 2) if L else 0.0
        return {
            "lengthM": round(L), "walkMin": round(L / WALK_MS / 60, 1), "seniorMin": round(L / SENIOR_MS / 60, 1),
            "climbToSiteM": round(climb, 1), "climbReturnM": round(descent, 1),
            "maxGradePct": round(100 * max_grade, 1), "over6pctM": round(steep),
            "cobbleShare": f(cob), "shelterShare": f(shelter), "litShare": f(lit),
            "badSurfaceM": round(bad), "narrowM": round(narrow), "steps": steps, "stepCount": step_count,
            "crossings": crossings, "raisedKerbs": kerbs, "steepest": steepest[:3], "lifts": lifts,
            "surfaces": {k: round(v) for k, v in surfaces.most_common(4)},
            "profile": prof, "path": [[round(c[0], 6), round(c[1], 6)] + ([round(c[2], 1)] if c[2] is not None else []) for c in coords],
        }


def station_start(net, s, cx, cy):
    """Start node for an arrival: the underground platform for U-Bahn (so lifts/stairs count), else the stop."""
    px, py = min(s["platformsUtm"], key=lambda p: math.hypot(p[0] - cx, p[1] - cy))
    if "subway" in s["departures"]:
        i, snap = net.nearest(px, py, underground=True)
        if snap <= 60:
            return i, True
    return net.nearest(px, py)[0], False


def resident_origins(net, cells, cx, cy):
    sect = defaultdict(lambda: [0, 0.0, 0.0])
    for c in cells:
        dx, dy = c["x"] - cx, c["y"] - cy
        d = math.hypot(dx, dy)
        if 100 < d <= RES_RADIUS_M and c["pop"] > 0:
            k = SECTORS[int(((math.degrees(math.atan2(dx, dy)) + 382.5) % 360) // 45)]
            sect[k][0] += c["pop"]
            sect[k][1] += c["pop"] * c["x"]
            sect[k][2] += c["pop"] * c["y"]
    out = []
    for k in SECTORS:
        pop, sx, sy = sect[k]
        if pop:
            out.append((k, pop, net.nearest(sx / pop, sy / pop)[0]))
    return out


def analyse(net, c, stations, cells, detail):
    ev = c["evidence"]
    sources = {i: 0.0 for i in ev["accessNodes"]}
    cx, cy = to_utm(*ev["centroid"])
    walk_d, walk_p = net.tree_from(sources, net.cost_walk())
    senior = {k: net.tree_from(sources, net.cost_senior(t)) for k, t in TIMES.items()}

    # step-free arrival by public transport
    near = sorted([s for s in stations if s["departuresTotal"] > 0], key=lambda s: math.hypot(s["x"] - cx, s["y"] - cy))[:N_STATIONS]
    starts = [(s, *station_start(net, s, cx, cy)) for s in near]
    arrival = {}
    for k, t in TIMES.items():
        d, _ = senior[k]
        best = None
        for s, i, platform in starts:
            if i in d:
                p = net.path_to_site(senior[k][1], i)
                m = sum(net.E[ei]["len"] for ei, _ in p)
                if best is None or m < best["walkM"]:
                    best = {"station": s["name"], "fromPlatform": platform, "walkM": round(m)}
        arrival[t] = best
    ev["stepFreeArrival"] = arrival

    # residents from 8 directions
    res = resident_origins(net, cells, cx, cy)
    wsum = sum(p for _, p, _ in res) or 1
    climb_home = shelter = 0.0
    step_free = 0
    res_out = []
    for k, pop, o in res:
        if o not in walk_d:
            continue
        sp = net.describe(net.path_to_site(walk_p, o), o)
        climb_home += pop * sp["climbReturnM"]
        shelter += pop * sp["shelterShare"]
        sen = {}
        for kk, t in TIMES.items():
            sd, spred = senior[kk]
            sen[t] = net.describe(net.path_to_site(spred, o), o) if o in sd else None
        step_free += pop if sen[TIMES["peak"]] else 0
        res_out.append({"type": "residents", "label": f"Residents {k}", "sector": k, "weight": pop, "shortest": sp, "senior": sen})
    ev["climbHomeM"] = round(climb_home / wsum, 1)
    ev["residentsStepFreeShare"] = round(step_free / wsum, 2)
    ev["rainCover"] = {"site": "indoor" if ev["baseKind"] == "ground_floor" else "open",
                       "approachShelterShare": round(shelter / wsum, 2)}
    if ev["baseKind"] == "ground_floor" and ev.get("vanToCentreM") is None:
        ev["vanToCentreM"] = c["indicators"]["vanDistM"]  # indoor hall: the van stop to the building is the push

    if not detail:
        return None
    origins = []
    for s, i, platform in starts[:N_STATION_ROUTES]:
        if i not in walk_d:
            continue
        sen = {}
        for kk, t in TIMES.items():
            sd, spred = senior[kk]
            sen[t] = net.describe(net.path_to_site(spred, i), i) if i in sd else None
        origins.append({"type": "transit", "label": f"{s['name']} ({'U-Bahn platform' if platform else 'stop'})",
                        "station": s["name"], "weight": s["departuresTotal"],
                        "shortest": net.describe(net.path_to_site(walk_p, i), i), "senior": sen})
    return {"id": c["id"], "name": c["name"], "origins": origins + res_out}


def preference(net, cands, focus, cells):
    """For every Zensus cell near the two options: walking distance and senior effort to each -> preferred site."""
    a, b = focus
    trees = {}
    for cid in focus:
        # to the middle of the market (siteNode), not its outline: the two outlines are only ~50 m apart
        src = {cands[cid]["evidence"]["siteNode"]: 0.0}
        trees[cid] = {"walk": net.tree_from(src, net.cost_walk())[0],
                      "senior": net.tree_from(src, net.cost_senior(TIMES["peak"]))[0]}
    centres = [to_utm(*cands[c]["evidence"]["centroid"]) for c in focus]
    rows, tally = [], {"walk": Counter(), "senior": Counter()}
    for c in cells:
        if c["pop"] <= 0 or min(math.hypot(c["x"] - x, c["y"] - y) for x, y in centres) > RES_RADIUS_M:
            continue
        i, snap = net.nearest(c["x"], c["y"])
        vals = {}
        for mode in ("walk", "senior"):
            da, db = trees[a][mode].get(i), trees[b][mode].get(i)
            vals[mode] = (None if da is None else round(da + snap), None if db is None else round(db + snap))
            if da is None and db is None:
                win = "none"
            elif db is None or (da is not None and da + TIE_M < db):
                win = a
            elif da is None or db + TIE_M < da:
                win = b
            else:
                win = "tie"
            tally[mode][win] += c["pop"]
        rows.append([c["lng"], c["lat"], c["pop"], *vals["walk"], *vals["senior"]])
    total = sum(r[2] for r in rows)
    summary = {mode: {k: {"residents": v, "share": round(v / total, 3)} for k, v in t.most_common()} for mode, t in tally.items()}
    return {
        "focus": focus,
        "fields": ["lng", "lat", "pop", f"walkM_{a}", f"walkM_{b}", f"seniorCost_{a}", f"seniorCost_{b}"],
        "note": (f"Zensus 100 m cells within {RES_RADIUS_M} m of either site, routed to each site's centre (evidence.siteNode). "
                 f"walkM = shortest walk; seniorCost = senior effort "
                 f"at {TIMES['peak']} (no steps; cobbles x2.5; grade above 6 % penalised; plan section 6), in metre-equivalents. "
                 f"Preferred = the site at least {TIE_M} m (or metre-equivalents) cheaper."),
        "summary": {"residents": total, **summary},
        "cells": rows,
    }


def main():
    print("Approaches")
    sites = load(os.path.join(ROOT, "prep", "sites.json"))
    focus, baseline = sites["focus"], sites["baseline"]
    net = Net()
    path = os.path.join(OUT, "candidates.json")
    cf = load(path)
    cands = {c["id"]: c for c in cf["candidates"]}
    stations = load(os.path.join(CACHE, "stations_utm.json"))
    cells = load(os.path.join(CACHE, "population_utm.json"))

    detail_ids = focus + [baseline]
    details = []
    for c in cf["candidates"]:
        d = analyse(net, c, stations, cells, c["id"] in detail_ids)
        if d:
            details.append(d)
    cf["meta"]["focus"] = {"sites": focus, "baseline": baseline}
    cf["meta"]["definitions"].update({
        "evidence.stepFreeArrival": f"shortest step-free walk from the platform of one of the {N_STATIONS} nearest stations, "
                                    f"at {TIMES['opening']} (market opening) and {TIMES['peak']} (peak); lifts with opening hours count only when open",
        "evidence.climbHomeM": "population-weighted climb (m) on the way home from the site for residents in 8 directions within 1.5 km",
        "evidence.residentsStepFreeShare": f"share of those residents with a step-free route at {TIMES['peak']}",
        "evidence.rainCover": "site = indoor (ground floor) or open; approachShelterShare = covered share of resident approaches",
    })
    write_json("candidates.json", cf)
    order = {cid: i for i, cid in enumerate(detail_ids)}
    write_json("approaches.json", {
        "meta": {"times": TIMES, "walkSpeedMs": WALK_MS, "seniorSpeedMs": SENIOR_MS, "focus": focus, "baseline": baseline,
                 "routes": "shortest = walking distance; senior = no steps, cost len x M_surface x M_slope (plan section 6); "
                           "path = [lng, lat, z?] from the origin to the site; profile = [distance m, terrain z]"},
        "sites": sorted(details, key=lambda d: order[d["id"]]),
    })
    pref = preference(net, cands, focus, cells)
    write_json("preference.json", pref)
    for d in sorted(details, key=lambda d: order[d["id"]]):
        ev = cands[d["id"]]["evidence"]
        print(f"  {d['id']:<13} step-free arrival {ev['stepFreeArrival']}  climb home {ev['climbHomeM']} m  "
              f"step-free residents {ev['residentsStepFreeShare']:.0%}  rain {ev['rainCover']}")
    for mode in ("walk", "senior"):
        print(f"  preference ({mode}): " + ", ".join(f"{k} {v['share']:.0%}" for k, v in pref["summary"][mode].items())
              + f" of {pref['summary']['residents']} residents")


if __name__ == "__main__":
    main()

"""VGN GTFS -> public/data/arrivals.json: Saturday arrivals and departures per station around the Altstadt."""
import csv
import io
import json
import math
import os
import zipfile
from collections import defaultdict

from common import BBOX_UTM, DATA, REF_DATE, cache_path, ll, to_utm, write_json

MARGIN_M = 600.0
MERGE_M = 200.0


def _norm(name):
    return name.removeprefix("Nürnberg ").strip()
MODES = {0: "tram", 1: "subway", 2: "rail", 3: "bus", 5: "tram", 7: "funicular", 11: "bus", 12: "rail"}


def _mode(route_type):
    rt = int(route_type)
    if rt in MODES:
        return MODES[rt]
    # extended GTFS route types (100 rail, 400 urban rail, 700 bus, 900 tram)
    return {1: "rail", 4: "subway", 7: "bus", 9: "tram"}.get(rt // 100, "other")


def _rows(z, name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))


def _minute(hms):
    h, m, _ = hms.split(":")
    return int(h) * 60 + int(m)


def active_services(z):
    ds = REF_DATE.strftime("%Y%m%d")
    day = REF_DATE.strftime("%A").lower()
    active = {r["service_id"] for r in _rows(z, "calendar.txt") if r[day] == "1" and r["start_date"] <= ds <= r["end_date"]}
    for r in _rows(z, "calendar_dates.txt"):
        if r["date"] == ds:
            (active.add if r["exception_type"] == "1" else active.discard)(r["service_id"])
    return active


def main():
    print(f"Transit (GTFS, {REF_DATE.isoformat()} {REF_DATE.strftime('%A')})")
    z = zipfile.ZipFile(os.path.join(DATA, "gtfs", "vgn_gtfs.zip"))
    x0, y0, x1, y1 = BBOX_UTM
    stops, parents = {}, {}
    for r in _rows(z, "stops.txt"):
        if not r["stop_lat"]:
            continue
        x, y = to_utm(float(r["stop_lon"]), float(r["stop_lat"]))
        if r["location_type"] == "1":
            parents[r["stop_id"]] = r
        if x0 - MARGIN_M <= x <= x1 + MARGIN_M and y0 - MARGIN_M <= y <= y1 + MARGIN_M and r["location_type"] in ("", "0"):
            stops[r["stop_id"]] = {**r, "x": x, "y": y}
    routes = {r["route_id"]: (_mode(r["route_type"]), r["route_short_name"]) for r in _rows(z, "routes.txt")}
    services = active_services(z)
    trips = {r["trip_id"]: routes[r["route_id"]] for r in _rows(z, "trips.txt") if r["service_id"] in services}
    print(f"  {len(stops)} platforms in area, {len(services)} active services, {len(trips)} Saturday trips")

    st = defaultdict(lambda: {"arr": defaultdict(list), "dep": defaultdict(int), "lines": defaultdict(set)})
    for r in _rows(z, "stop_times.txt"):
        sid = r["stop_id"]
        if sid not in stops:
            continue
        trip = trips.get(r["trip_id"])
        if trip is None:
            continue
        mode, line = trip
        rec = st[sid]
        if r.get("drop_off_type") != "1" and r["arrival_time"]:
            rec["arr"][mode].append(_minute(r["arrival_time"]))
        if r.get("pickup_type") != "1":
            rec["dep"][mode] += 1
        rec["lines"][mode].add(line)

    # group platforms into stations: parent_station first, then same-name groups within MERGE_M
    by_parent = defaultdict(list)
    for sid in st:
        by_parent[stops[sid]["parent_station"] or sid].append(sid)
    groups = {}
    for gid, sids in by_parent.items():
        name = _norm(parents.get(gid, stops[sids[0]])["stop_name"])
        cx = sum(stops[s]["x"] for s in sids) / len(sids)
        cy = sum(stops[s]["y"] for s in sids) / len(sids)
        for oid, o in groups.items():
            if o["name"] == name and math.hypot(o["x"] - cx, o["y"] - cy) <= MERGE_M:
                o["sids"].extend(sids)
                break
        else:
            groups[gid] = {"name": name, "x": cx, "y": cy, "sids": list(sids)}
    groups = {gid: g["sids"] for gid, g in groups.items()}
    stations = []
    for gid, sids in groups.items():
        members = [stops[s] for s in sids]
        x = sum(m["x"] for m in members) / len(members)
        y = sum(m["y"] for m in members) / len(members)
        arr, dep, lines = defaultdict(list), defaultdict(int), defaultdict(set)
        for s in sids:
            for k, v in st[s]["arr"].items():
                arr[k].extend(v)
            for k, v in st[s]["dep"].items():
                dep[k] += v
            for k, v in st[s]["lines"].items():
                lines[k] |= v
        name = _norm(parents.get(gid, members[0])["stop_name"])
        lng, lat = ll(x, y)
        stations.append({"id": gid, "name": name, "lng": lng, "lat": lat, "x": x, "y": y,
                         "departures": dict(dep), "departuresTotal": sum(dep.values()),
                         "lines": {k: sorted(v) for k, v in lines.items()},
                         "arrivals": {k: sorted(v) for k, v in arr.items()},
                         "platforms": [{"id": m["stop_id"], "lng": ll(m["x"], m["y"])[0], "lat": ll(m["x"], m["y"])[1]} for m in members]})
    stations.sort(key=lambda s: -s["departuresTotal"])
    with open(cache_path("stations_utm.json"), "w", encoding="utf-8") as f:
        json.dump([{**{k: s[k] for k in ("id", "name", "x", "y", "departures", "departuresTotal")},
                    "platformsUtm": [to_utm(p["lng"], p["lat"]) for p in s["platforms"]]} for s in stations], f, ensure_ascii=False)
    write_json("arrivals.json", {
        "source": "VGN Verkehrsverbund Grossraum Nuernberg, GTFS open data",
        "date": REF_DATE.isoformat(), "weekday": REF_DATE.strftime("%A"),
        "note": "arrivals = minutes after midnight of the service day (may exceed 1440); departures = boardable stop events",
        "stations": [{k: v for k, v in s.items() if k not in ("x", "y")} for s in stations],
    })
    top = ", ".join(f"{s['name']} {s['departuresTotal']}" for s in stations[:5])
    print(f"  {len(stations)} stations; busiest: {top}")


if __name__ == "__main__":
    main()

"""Shared constants, projections and I/O for the prep pipeline."""
import datetime as dt
import json
import math
import os
import re
from functools import lru_cache

from pyproj import Transformer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "datasets")
OUT = os.path.join(ROOT, "public", "data")
CACHE = os.path.join(ROOT, "prep", "cache")

# Study area (datasets/README.md). Everything is computed in EPSG:25832 metres.
BBOX_UTM = (649600.0, 5478800.0, 651700.0, 5480900.0)
BBOX_WGS = (11.065, 49.444, 11.092, 49.461)  # minLng, minLat, maxLng, maxLat

# Reference day for the timetable and the conditional access tags: a Saturday inside the GTFS calendar.
REF_DATE = dt.date(2026, 10, 10)
DELIVERY_TIME = "05:30"

# 3.5 t Mercedes Sprinter (Markus). Height is the high-roof variant.
VAN = {"heightM": 2.8, "widthM": 2.2, "weightT": 3.5}

_to_utm = Transformer.from_crs(4326, 25832, always_xy=True)
_to_wgs = Transformer.from_crs(25832, 4326, always_xy=True)


def to_utm(lng, lat):
    return _to_utm.transform(lng, lat)


def to_wgs(x, y):
    return _to_wgs.transform(x, y)


def ll(x, y):
    """UTM -> [lng, lat] rounded to ~0.1 m."""
    lng, lat = _to_wgs.transform(x, y)
    return [round(lng, 6), round(lat, 6)]


def ring_ll(coords):
    return [ll(x, y) for x, y in coords]


@lru_cache(maxsize=1)
def osm_elements():
    with open(os.path.join(DATA, "osm", "altstadt.json"), encoding="utf-8") as f:
        return json.load(f)["elements"]


def tags(e):
    return e.get("tags", {})


def write_json(name, obj):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    print(f"  wrote public/data/{name} ({os.path.getsize(path) / 1e6:.2f} MB)")
    return path


def cache_path(name):
    os.makedirs(CACHE, exist_ok=True)
    return os.path.join(CACHE, name)


def slug(s):
    s = s.lower().translate(str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"}))
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def parse_num(v):
    """'3.6', '3,6 m', '7.5' -> float; None if unparseable."""
    if v is None:
        return None
    m = re.match(r"^\s*([0-9]+(?:[.,][0-9]+)?)", str(v))
    return float(m.group(1).replace(",", ".")) if m else None


# --- OSM conditional restrictions, e.g. "delivery @ (05:00-20:00)" -------------------------------

_DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]
_MONTHS = {m: i + 1 for i, m in enumerate(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}


def _minutes(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def _in_time_range(rng, minute):
    a, b = (_minutes(t) for t in rng.split("-"))
    return a <= minute < b if a <= b else (minute >= a or minute < b)


def _day_matches(spec, weekday):
    for part in spec.split(","):
        if "-" in part:
            a, b = (_DAYS.index(d) for d in part.split("-"))
            days = range(a, b + 1) if a <= b else list(range(a, 7)) + list(range(0, b + 1))
            if weekday in days:
                return True
        elif _DAYS.index(part) == weekday:
            return True
    return False


def _parse_date(s):
    s = s.strip()
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", s)
    if m:
        return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    m = re.match(r"^(\d{4}) ([A-Z][a-z]{2}) (\d{1,2})$", s)
    if m:
        return dt.date(int(m.group(1)), _MONTHS[m.group(2)], int(m.group(3)))
    raise ValueError(s)


def condition_active(cond, when_date, when_time):
    """Evaluates the opening_hours subset used in the Altstadt extract. Raises ValueError if unknown."""
    cond = cond.strip()
    minute = _minutes(when_time)
    weekday = when_date.weekday()
    # date range: "2025 Oct 20 -2026 Apr 01" or "2025-02-28-2027-12-31"
    m = re.match(r"^(\d{4}(?: [A-Z][a-z]{2} \d{1,2}|-\d{2}-\d{2}))\s*-\s*(\d{4}(?: [A-Z][a-z]{2} \d{1,2}|-\d{2}-\d{2}))$", cond)
    if m:
        return _parse_date(m.group(1)) <= when_date <= _parse_date(m.group(2))
    # one or more "Days HH:MM-HH:MM" or "HH:MM-HH:MM" rules separated by ","/";"
    for rule in re.split(r"[;]|,(?=\s*[A-Z][a-z]\b)", cond):
        rule = rule.strip()
        m = re.match(r"^(?:([A-Z][a-z](?:-[A-Z][a-z])?(?:,[A-Z][a-z](?:-[A-Z][a-z])?)*)\s+)?((?:\d{1,2}:\d{2}-\d{1,2}:\d{2},?)+)$", rule)
        if not m:
            raise ValueError(cond)
        if m.group(1) and not _day_matches(m.group(1), weekday):
            continue
        if any(_in_time_range(r, minute) for r in m.group(2).split(",") if r):
            return True
    return False


def conditional_value(tag_value, when_date=REF_DATE, when_time=DELIVERY_TIME):
    """'delivery @ (05:00-20:00); no @ (...)' -> the value that applies at the given time, or None."""
    for clause in re.findall(r"([^;@]+?)\s*@\s*\(([^)]*)\)", tag_value):
        value, cond = clause
        if condition_active(cond, when_date, when_time):
            return value.strip()
    return None


def haversine_m(a, b):
    (lng1, lat1), (lng2, lat2) = a, b
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))

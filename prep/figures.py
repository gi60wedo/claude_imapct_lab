"""Slide figures for the two relocation options -> docs/figures/ (npm run figures).

  focus_3d.png        3D close-up: DGM1 terrain + LoD2, walk network by grade, legal van routes, U-Bahn exits, Galeria lift
  focus_profiles.png  elevation along the approaches to each option
  preference_map.png  which option is preferable from every 100 m Zensus cell, walking vs senior effort
"""
import json
import os

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import LightSource
from matplotlib.lines import Line2D
from matplotlib.patches import Patch, Rectangle
from mpl_toolkits.mplot3d.art3d import Line3DCollection, Poly3DCollection

from common import CACHE, OUT, ROOT, to_utm
from graph import Terrain

FIG_DIR = os.path.join(ROOT, "docs", "figures")
INK, INK2, MUTED, GRID, SURFACE = "#0b0b0b", "#52514e", "#898781", "#e1e0d9", "#fcfcfb"
SITE_COLOR = {"lorenzkirche": "#eb6834", "kaufhof": "#1baf7a", "hauptmarkt": "#52514e"}  # slots 2, 3; baseline in ink
GRADE_BINS = [(0.03, "#cde2fb", "0–3 %"), (0.06, "#6da7ec", "3–6 %"), (0.10, "#256abf", "6–10 %"), (9.0, "#0d366b", "> 10 %")]
STEPS = "#d03b3b"   # status critical: a barrier for rollators, always labelled in the legend
CREDIT = ("Datenquelle: Bayerische Vermessungsverwaltung – www.geodaten.bayern.de, CC BY 4.0 · © OpenStreetMap contributors · "
          "Zensus 2022 (Destatis, dl-de/by-2-0) · VGN")
plt.rcParams.update({"font.family": ["Segoe UI", "DejaVu Sans"], "font.size": 10, "text.color": INK,
                     "axes.edgecolor": "#c3c2b7", "axes.labelcolor": INK2, "xtick.color": MUTED, "ytick.color": MUTED})


def load(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


cf = load(os.path.join(OUT, "candidates.json"))
cands = {c["id"]: c for c in cf["candidates"]}
focus = cf["meta"]["focus"]["sites"]
baseline = cf["meta"]["focus"]["baseline"]
short_name = lambda cid: {"lorenzkirche": "St. Lorenzkirche plaza", "kaufhof": "Former Kaufhof", "hauptmarkt": "Hauptmarkt (today)"}.get(cid, cid)


def focus_3d():
    g = load(os.path.join(OUT, "graph.json"))
    N, E = g["nodes"], g["edges"]
    for n in N:
        n["x"], n["y"] = to_utm(n["lng"], n["lat"])
    blds = load(os.path.join(CACHE, "buildings_utm.json"))
    rings = {cid: [to_utm(*p) for p in cands[cid]["polygon"]] for cid in focus}
    pts = [p for r in rings.values() for p in r] + [to_utm(*p) for cid in focus for p in cands[cid]["evidence"].get("vanRoute", [])[-25:]]
    xs, ys = zip(*pts)
    x0, x1, y0, y1 = min(xs) - 90, max(xs) + 90, min(ys) - 90, max(ys) + 90
    vex = 2.0
    t = Terrain()
    gx, gy = np.meshgrid(np.arange(x0, x1, 3.0), np.arange(y0, y1, 3.0))
    gz = np.vectorize(lambda x, y: t.z(x, y, smooth=True) or np.nan)(gx, gy)
    zmin = np.nanmin(gz)
    z = lambda v: (v - zmin) * vex

    fig = plt.figure(figsize=(16, 11), facecolor=SURFACE)
    ax = fig.add_subplot(projection="3d", computed_zorder=False)
    ax.set_facecolor(SURFACE)
    rgb = LightSource(azdeg=315, altdeg=35).shade(np.nan_to_num(gz, nan=zmin), cmap=plt.get_cmap("Greys_r"), vert_exag=6,
                                                  blend_mode="soft", vmin=zmin - 25, vmax=np.nanmax(gz) + 15)
    ax.plot_surface(gx, gy, z(gz), facecolors=rgb, linewidth=0, antialiased=False, shade=False, zorder=1,
                    rcount=gz.shape[0], ccount=gz.shape[1])
    walls, roofs = [], []
    for b in blds:
        r = b["ring"]
        bx, by = zip(*r)
        if min(bx) < x0 or max(bx) > x1 or min(by) < y0 or max(by) > y1 or not b["h"] or b["z"] is None:
            continue
        zb, zt = z(b["z"]), z(b["z"]) + b["h"]
        roofs.append([(x, y, zt) for x, y in r])
        walls += [[(xa, ya, zb), (xb, yb, zb), (xb, yb, zt), (xa, ya, zt)] for (xa, ya), (xb, yb) in zip(r, r[1:])]
    ax.add_collection3d(Poly3DCollection(walls, facecolor="#cfccc3", edgecolor="none", alpha=0.30, zorder=2))
    ax.add_collection3d(Poly3DCollection(roofs, facecolor="#f1efe9", edgecolor="#a9a69c", linewidth=0.25, alpha=0.55, zorder=2))

    segs, cols = [], []
    for e in E:
        na, nb = N[e["a"]], N[e["b"]]
        if not e["foot"] or "z" not in na or "z" not in nb or not (x0 <= na["x"] <= x1 and y0 <= na["y"] <= y1):
            continue
        segs.append([(na["x"], na["y"], z(na["z"]) + 1), (nb["x"], nb["y"], z(nb["z"]) + 1)])
        cols.append(STEPS if e.get("steps") else next(c for lim, c, _ in GRADE_BINS if e["slope"] <= lim))
    ax.add_collection3d(Line3DCollection(segs, colors=cols, linewidths=1.6, zorder=3))

    zat = lambda x, y: z(t.z(x, y, smooth=True) or zmin)
    for cid in focus:
        r = rings[cid]
        col = SITE_COLOR[cid]
        ax.plot([p[0] for p in r], [p[1] for p in r], [zat(*p) + 3 for p in r], color=col, lw=3.2, zorder=5)
        ev = cands[cid]["evidence"]
        vr = [to_utm(*p) for p in ev.get("vanRoute", [])]
        vr = [p for p in vr if x0 <= p[0] <= x1 and y0 <= p[1] <= y1]
        if vr:
            ax.plot([p[0] for p in vr], [p[1] for p in vr], [zat(*p) + 5 for p in vr], color=col, lw=2.2, ls=(0, (4, 2)), zorder=6)
            lx, ly = to_utm(*ev["loadingPoint"])
            ax.scatter([lx], [ly], [zat(lx, ly) + 6], s=90, marker="s", color=col, edgecolor=SURFACE, linewidth=2, zorder=7)
            ax.text(lx, ly, zat(lx, ly) + 26, f"van stop · {round(cands[cid]['indicators']['vanDistM'])} m to site"
                    + (f", {round(ev['vanToCentreM'])} m to centre" if ev.get("vanToCentreM") and ev["baseKind"] != "ground_floor" else ""),
                    fontsize=9.5, color=INK, ha="center", zorder=8,
                    bbox={"boxstyle": "round,pad=0.2", "fc": SURFACE, "ec": col, "alpha": 0.9})
        cx, cy = to_utm(*ev["centroid"])
        dx, dy = {"lorenzkirche": (60, 95), "kaufhof": (-110, -60)}.get(cid, (0, 60))
        ax.plot([cx, cx + dx], [cy, cy + dy], [zat(cx, cy) + 3, zat(cx, cy) + 70], color=INK2, lw=0.8, zorder=8)
        ax.text(cx + dx, cy + dy, zat(cx, cy) + 72, short_name(cid), fontsize=13, fontweight="bold", color=INK, ha="center",
                zorder=9, bbox={"boxstyle": "round,pad=0.3", "fc": SURFACE, "ec": col, "lw": 2})
    for n in N:
        if n.get("entrance") == "Lorenzkirche" and "z" in n and x0 <= n["x"] <= x1 and y0 <= n["y"] <= y1:
            ax.scatter([n["x"]], [n["y"]], [z(n["z"]) + 4], s=70, marker="v", color=INK, zorder=7)
    lift = next(e for e in E if e.get("override") == "galeria-lift-lorenzkirche")
    lb = N[lift["b"]]
    ax.scatter([lb["x"]], [lb["y"]], [z(lb["z"]) + 4], s=140, marker="P", color=INK, edgecolor=SURFACE, zorder=8)
    ax.text(lb["x"] - 25, lb["y"] + 20, z(lb["z"]) + 34, "Galeria lift, only lift to street\n(Mo–Sa 09:30–20:00, VAG)",
            fontsize=9.5, ha="right", zorder=9, bbox={"boxstyle": "round,pad=0.2", "fc": SURFACE, "ec": INK, "alpha": 0.9})
    ax.set_xlim(x0, x1); ax.set_ylim(y0, y1)
    top = z(np.nanmax(gz)) + 110
    ax.set_zlim(0, top)
    ax.set_box_aspect((x1 - x0, y1 - y0, top))
    ax.view_init(elev=36, azim=-58)
    ax.set_axis_off()
    handles = [Line2D([], [], color=c, lw=3, label=f"walk grade {lab}") for _, c, lab in GRADE_BINS]
    handles += [Line2D([], [], color=STEPS, lw=3, label="steps (blocks rollators)"),
                Line2D([], [], color=SITE_COLOR["lorenzkirche"], lw=2.2, ls=(0, (4, 2)), label="legal 05:30 van route → Lorenzkirche"),
                Line2D([], [], color=SITE_COLOR["kaufhof"], lw=2.2, ls=(0, (4, 2)), label="legal 05:30 van route → Kaufhof"),
                Line2D([], [], color=INK, marker="v", lw=0, ms=9, label="U-Bahn exit (stairs/escalator)")]
    ax.legend(handles=handles, loc="upper left", frameon=False, fontsize=10.5)
    fig.suptitle("Lorenzkirche vs. former Kaufhof in 3D: DGM1 terrain (height ×2) and LoD2 buildings",
                 x=0.02, ha="left", fontsize=15, color=INK)
    fig.text(0.02, 0.015, CREDIT, color=MUTED, fontsize=8.5)
    p = os.path.join(FIG_DIR, "focus_3d.png")
    fig.savefig(p, dpi=120, facecolor=SURFACE, bbox_inches="tight")
    print("  ", p)


def focus_profiles():
    ap = {s["id"]: s for s in load(os.path.join(OUT, "approaches.json"))["sites"]}
    sites = focus + [baseline]
    fig, axes = plt.subplots(1, 3, figsize=(17, 5.4), sharey=True, facecolor=SURFACE)
    series = ["#2a78d6", "#eb6834", "#1baf7a"]  # slot order 1-3 for the three approaches in each panel
    for ax, cid in zip(axes, sites):
        s = ap[cid]
        tr = [o for o in s["origins"] if o["type"] == "transit"][:1]
        rs = sorted([o for o in s["origins"] if o["type"] == "residents"], key=lambda o: -o["shortest"]["climbReturnM"])[:2]
        for o, col in zip(tr + rs, series):
            pr = o["shortest"]["profile"]
            if len(pr) < 2:
                continue
            total = pr[-1][0]
            lab = f"{o['label']} · climb home {o['shortest']['climbReturnM']:.0f} m"
            ax.plot([total - d for d, _ in pr], [zz for _, zz in pr], color=col, lw=2, label=lab)
        ev = cands[cid]["evidence"]
        ax.invert_xaxis()
        ax.set_title(f"{short_name(cid)}\nresidents' mean climb home {ev['climbHomeM']:.0f} m", loc="left", fontsize=11.5, color=INK)
        ax.grid(color=GRID, lw=0.6)
        ax.set_facecolor(SURFACE)
        for sp in ("top", "right"):
            ax.spines[sp].set_visible(False)
        ax.legend(frameon=False, fontsize=8.8, loc="upper left")
        ax.set_xlabel("distance to site (m)")
    axes[0].set_ylabel("terrain height (m a.s.l.)")
    fig.suptitle("Elevation along the approaches (walking towards the site, right → left): nearest station and the two resident "
                 "directions with the hardest way home", x=0.01, ha="left", fontsize=13, color=INK)
    fig.text(0.01, 0.01, CREDIT, color=MUTED, fontsize=8)
    fig.tight_layout(rect=(0, 0.03, 1, 0.93))
    p = os.path.join(FIG_DIR, "focus_profiles.png")
    fig.savefig(p, dpi=120, facecolor=SURFACE)
    print("  ", p)


def preference_map():
    pref = load(os.path.join(OUT, "preference.json"))
    blds = load(os.path.join(CACHE, "buildings_utm.json"))
    a, b = pref["focus"]
    fig, axes = plt.subplots(1, 2, figsize=(16, 8.4), facecolor=SURFACE)
    cells = [(to_utm(r[0], r[1]), r) for r in pref["cells"]]
    xs = [p[0] for p, _ in cells]
    ys = [p[1] for p, _ in cells]
    for ax, (mode, ia, ib, title) in zip(axes, [("walk", 3, 4, "Everyone: shortest walk"),
                                                 ("senior", 5, 6, "Seniors with a rollator: no steps, cobbles and slopes penalised")]):
        for bl in blds:
            bx, by = zip(*bl["ring"])
            if min(xs) - 100 <= bx[0] <= max(xs) + 100 and min(ys) - 100 <= by[0] <= max(ys) + 100:
                ax.fill(bx, by, color="#e9e7e1", lw=0, zorder=1)
        for (x, y), r in cells:
            da, db = r[ia], r[ib]
            if da is None and db is None:
                ax.add_patch(Rectangle((x - 48, y - 48), 96, 96, fill=False, hatch="////", ec=MUTED, lw=0, zorder=2))
                continue
            elif db is None or (da is not None and da + 25 < db):
                col, alpha = SITE_COLOR[a], 0.25 + 0.65 * min(1, ((db if db is not None else da + 600) - da) / 600)
            elif da is None or db + 25 < da:
                col, alpha = SITE_COLOR[b], 0.25 + 0.65 * min(1, ((da if da is not None else db + 600) - db) / 600)
            else:
                col, alpha = "#c3c2b7", 0.6
            ax.add_patch(Rectangle((x - 48, y - 48), 96, 96, color=col, alpha=alpha, lw=0, zorder=2))
        for cid in (a, b):
            r = [to_utm(*p) for p in cands[cid]["polygon"]]
            ax.fill([p[0] for p in r], [p[1] for p in r], color=SITE_COLOR[cid], ec=INK, lw=1.5, zorder=4)
        s = pref["summary"][mode]
        share = lambda k: s.get(k, {}).get("share", 0)
        ax.set_title(f"{title}\n{short_name(a)} {share(a):.0%} · {short_name(b)} {share(b):.0%} · equal {share('tie'):.0%}"
                     + (f" · no step-free route {share('none'):.0%}" if share("none") else ""), loc="left", fontsize=11.5, color=INK)
        ax.set_aspect("equal")
        ax.set_xlim(min(xs) - 60, max(xs) + 60); ax.set_ylim(min(ys) - 60, max(ys) + 60)
        ax.set_axis_off()
    handles = [Patch(color=SITE_COLOR[a], label=f"{short_name(a)} is preferable (darker = bigger advantage)"),
               Patch(color=SITE_COLOR[b], label=f"{short_name(b)} is preferable (darker = bigger advantage)"),
               Patch(color="#c3c2b7", label="about equal (within 25 m)"),
               Patch(fill=False, hatch="////", ec=MUTED, label="no step-free route to either")]
    fig.legend(handles=handles, loc="lower center", ncol=4, frameon=False, fontsize=10.5)
    fig.suptitle(f"Which option is preferable from home? {pref['summary']['residents']:,} residents in 100 m Zensus cells "
                 f"within 1.5 km, weighted equally per resident", x=0.01, ha="left", fontsize=14, color=INK)
    fig.text(0.01, 0.005, CREDIT, color=MUTED, fontsize=8)
    fig.tight_layout(rect=(0, 0.06, 1, 0.94))
    p = os.path.join(FIG_DIR, "preference_map.png")
    fig.savefig(p, dpi=120, facecolor=SURFACE)
    print("  ", p)


if __name__ == "__main__":
    os.makedirs(FIG_DIR, exist_ok=True)
    print("Figures")
    focus_3d()
    focus_profiles()
    preference_map()

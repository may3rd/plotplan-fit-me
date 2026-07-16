"""Plot plan v1: spacing-compliant 2D layout, ranked by rack-routed piping cost.

Data in, DXF out. Stdlib only.
Usage: python plotplan.py [data_dir] [seed | start:end]
       data_dir defaults to data/sample_unit (relative to this file).
       A single seed runs once. A "start:end" range runs each seed, prints
       a ranked score table, and writes the best layout to plotplan.dxf.
"""
import csv
import math
import os
import random
import sys
from dataclasses import dataclass

# ---------------------------------------------------------------- data model

@dataclass
class Equipment:
    tag: str
    cls: str        # spacing class, key into the spacing table
    w: float        # footprint width  (m, x)
    d: float        # footprint depth  (m, y)
    x: float = 0.0  # center, set by solver (or fixed, if pinned)
    y: float = 0.0
    pinned: bool = False   # if True, solver never moves this item
    pull_side: str = ""    # "x+"/"x-"/"y+"/"y-" — tube-pull / maintenance
    pull_len: float = 0.0  # clearance length (m) that must stay clear on that side

# ponytail: fallback spacing table (GAP.2.5.2-style placeholder values), used
# only if a unit's data dir has no spacing.csv. Real units should ship their
# own spacing.csv — see backend/data/sample_unit/spacing.csv for the format.
DEFAULT_SPACING = {
    ("fired_heater", "fired_heater"): 15.0,
    ("fired_heater", "column"):       15.0,
    ("fired_heater", "vessel"):       15.0,
    ("fired_heater", "exchanger"):    15.0,
    ("fired_heater", "pump_hc"):      15.0,
    ("column",       "column"):        3.0,
    ("column",       "vessel"):        3.0,
    ("column",       "exchanger"):     3.0,
    ("column",       "pump_hc"):       5.0,
    ("vessel",       "vessel"):        3.0,
    ("vessel",       "exchanger"):     3.0,
    ("vessel",       "pump_hc"):       5.0,
    ("exchanger",    "exchanger"):     1.5,
    ("exchanger",    "pump_hc"):       3.0,
    ("pump_hc",      "pump_hc"):       1.5,
}

def min_gap(a: str, b: str, spacing: dict) -> float:
    return spacing.get((a, b)) or spacing.get((b, a)) or 3.0  # 3 m default access

@dataclass
class Site:
    w: float            # m, x extent (0..w)
    d: float            # m, y extent (0..d)
    racks: list          # [(rack_y, rack_half), ...] — one or more parallel rack spines
    wind_dir: str = ""   # "x+"/"x-"/"y+"/"y-" — the side the prevailing wind blows FROM
                         # (upwind side of every fired_heater); "" = no wind constraint

# ponytail: relative cost per meter of rack steel actually used (span of the
# equipment routed onto that rack), same units as piping weight×length so it
# trades off directly against pipe cost. Tune against a real $/m ratio if
# this ever needs to match an actual estimate.
RACK_STEEL_COST_PER_M = 1.0

# ponytail: standoff distance (m) enforced on a fired heater's upwind side —
# no other equipment may sit there, since prevailing wind would carry any
# hydrocarbon release straight into the open flame. Placeholder magnitude
# (bigger than the 15 m omnidirectional fired_heater spacing in
# DEFAULT_SPACING); tune against a real wind-risk study if one exists.
WIND_CLEARANCE_M = 20.0

# connection: (tag_a, tag_b, weight). weight ~ n_lines * size factor,
# i.e. relative installed-piping cost per meter of route.
Connection = tuple

# --------------------------------------------------------------- CSV loader
# ponytail: stdlib csv module, four flat files. No schema validation beyond
# what int()/float() raise — good enough for a tool one team runs by hand.

def load_equipment(path: str) -> list:
    # ponytail: optional x,y,pinned,pull_side,pull_len columns — missing
    # entirely (old files) or blank both resolve to the field's default.
    with open(path, newline="") as f:
        eq = []
        for r in csv.DictReader(f):
            pinned = (r.get("pinned") or "").strip().lower() in ("1", "true", "yes")
            x = float(r["x"]) if pinned and r.get("x") else 0.0
            y = float(r["y"]) if pinned and r.get("y") else 0.0
            pull_side = (r.get("pull_side") or "").strip()
            pull_len = float(r["pull_len"]) if r.get("pull_len") else 0.0
            eq.append(Equipment(r["tag"], r["cls"], float(r["w"]), float(r["d"]),
                                 x, y, pinned, pull_side, pull_len))
        return eq

def load_connections(path: str) -> list:
    with open(path, newline="") as f:
        return [(r["a"], r["b"], float(r["weight"])) for r in csv.DictReader(f)]

def load_spacing(path: str) -> dict:
    with open(path, newline="") as f:
        return {(r["cls_a"], r["cls_b"]): float(r["min_gap"])
                for r in csv.DictReader(f)}

def load_site(path: str) -> Site:
    # ponytail: same "grouped rows" convention as keepouts.csv — one row per
    # rack spine. w/d/wind_dir only need to be present on the first row; a
    # single-row file with no wind_dir column behaves exactly as before.
    with open(path, newline="") as f:
        rows = list(csv.DictReader(f))
    racks = [(float(r["rack_y"]), float(r["rack_half"])) for r in rows]
    wind_dir = (rows[0].get("wind_dir") or "").strip()
    return Site(float(rows[0]["w"]), float(rows[0]["d"]), racks, wind_dir)

def load_keepouts(path: str) -> dict:
    """zone,x,y rows, grouped by zone name into ordered vertex lists."""
    zones = {}
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            zones.setdefault(r["zone"], []).append((float(r["x"]), float(r["y"])))
    return zones

def load_unit(data_dir: str):
    """Load (equipment, connections, spacing, site, keepouts) from a data
    dir of equipment.csv / connections.csv / spacing.csv / site.csv, plus
    an optional keepouts.csv."""
    keepouts_path = os.path.join(data_dir, "keepouts.csv")
    return (
        load_equipment(os.path.join(data_dir, "equipment.csv")),
        load_connections(os.path.join(data_dir, "connections.csv")),
        load_spacing(os.path.join(data_dir, "spacing.csv")),
        load_site(os.path.join(data_dir, "site.csv")),
        load_keepouts(keepouts_path) if os.path.exists(keepouts_path) else {},
    )

# ------------------------------------------------------------- geometry/cost

def edge_gap(e1: Equipment, e2: Equipment) -> float:
    dx = max(0.0, abs(e1.x - e2.x) - (e1.w + e2.w) / 2)
    dy = max(0.0, abs(e1.y - e2.y) - (e1.d + e2.d) / 2)
    return math.hypot(dx, dy)

def _point_in_poly(x: float, y: float, poly: list) -> bool:
    # ray casting, stdlib only
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            x_at_y = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if x < x_at_y:
                inside = not inside
    return inside

def _rect_hits_poly(x1, y1, x2, y2, poly: list) -> bool:
    # ponytail: sample the 4 corners + center against the polygon, and the
    # polygon's own vertices against the rect. Catches convex zones and
    # axis-aligned rectangle zones (flare circles approximated as polygons,
    # blast/underground rectangles) — a thin polygon edge that slices
    # through the footprint without crossing a sample point can be missed.
    # Upgrade to full polygon-rectangle clipping (e.g. Sutherland-Hodgman)
    # if that shows up on a real unit.
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    corners = [(x1, y1), (x2, y1), (x2, y2), (x1, y2), (cx, cy)]
    if any(_point_in_poly(px, py, poly) for px, py in corners):
        return True
    return any(x1 <= vx <= x2 and y1 <= vy <= y2 for vx, vy in poly)

def _rect_overlap(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) -> bool:
    return ax1 < bx2 and bx1 < ax2 and ay1 < by2 and by1 < ay2

def _footprint(e: Equipment):
    return e.x - e.w / 2, e.y - e.d / 2, e.x + e.w / 2, e.y + e.d / 2

def _side_rect(x1, y1, x2, y2, side: str, length: float):
    """Rectangle of the given length extending outward from one side
    ("x+"/"x-"/"y+"/"y-") of a footprint, or None if side/length is empty."""
    if not side or length <= 0:
        return None
    return {
        "x+": (x2, y1, x2 + length, y2),
        "x-": (x1 - length, y1, x1, y2),
        "y+": (x1, y2, x2, y2 + length),
        "y-": (x1, y1 - length, x2, y1),
    }.get(side)

def _pull_rect(e: Equipment):
    """Tube-pull / maintenance clearance rectangle attached to one side of
    the footprint, or None if the item has no pull clearance defined."""
    return _side_rect(*_footprint(e), e.pull_side, e.pull_len)

def _wind_rect(e: Equipment, wind_dir: str):
    """Upwind exclusion rectangle for a fired heater, or None if this item
    isn't a fired heater or the site has no wind_dir set."""
    if e.cls != "fired_heater":
        return None
    return _side_rect(*_footprint(e), wind_dir, WIND_CLEARANCE_M)

def feasible(eq: list, site: Site, spacing: dict, keepouts: dict = None) -> bool:
    for e in eq:
        if not (e.w / 2 <= e.x <= site.w - e.w / 2 and
                e.d / 2 <= e.y <= site.d - e.d / 2):
            return False
        # keep-out: every rack corridor
        if any(abs(e.y - ry) < rhalf + e.d / 2 for ry, rhalf in site.racks):
            return False
        # keep-out: named polygon zones (flare radius, blast contours,
        # roads, maintenance corridors — all just zones in keepouts.csv)
        x1, y1, x2, y2 = _footprint(e)
        for poly in (keepouts or {}).values():
            if _rect_hits_poly(x1, y1, x2, y2, poly):
                return False
    for i in range(len(eq)):
        for j in range(i + 1, len(eq)):
            if edge_gap(eq[i], eq[j]) < min_gap(eq[i].cls, eq[j].cls, spacing):
                return False
    # tube-pull / maintenance clearance: the swept rectangle must stay
    # inside the site, clear of the rack corridor, clear of keepout zones,
    # and clear of every other equipment's footprint (not spacing-margined
    # like edge_gap — just zero overlap, it's swept space, not a machine).
    for e in eq:
        pr = _pull_rect(e)
        if pr is None:
            continue
        x1, y1, x2, y2 = pr
        if not (0 <= x1 and x2 <= site.w and 0 <= y1 and y2 <= site.d):
            return False
        if any(y1 < ry + rhalf and y2 > ry - rhalf for ry, rhalf in site.racks):
            return False
        for poly in (keepouts or {}).values():
            if _rect_hits_poly(x1, y1, x2, y2, poly):
                return False
        for other in eq:
            if other is e:
                continue
            ox1, oy1, ox2, oy2 = _footprint(other)
            if _rect_overlap(x1, y1, x2, y2, ox1, oy1, ox2, oy2):
                return False
    # prevailing wind: no equipment may sit in a fired heater's upwind
    # sector — a hydrocarbon release there would blow straight into it.
    if site.wind_dir:
        for e in eq:
            wr = _wind_rect(e, site.wind_dir)
            if wr is None:
                continue
            wx1, wy1, wx2, wy2 = wr
            for other in eq:
                if other is e:
                    continue
                ox1, oy1, ox2, oy2 = _footprint(other)
                if _rect_overlap(wx1, wy1, wx2, wy2, ox1, oy1, ox2, oy2):
                    return False
    return True

def piping_cost(eq: list, conns: list, site: Site) -> float:
    # all lines route via a rack: rise to the rack, run along, drop. Each
    # connection picks whichever rack spine gives it the shortest rise+drop
    # (the run-along-x term is the same regardless of which rack, so it
    # doesn't affect the choice).
    by_tag = {e.tag: e for e in eq}
    total = 0.0
    xs_by_rack = {}
    for a, b, w in conns:
        ea, eb = by_tag[a], by_tag[b]
        ry = min((r for r, _ in site.racks), key=lambda r: abs(ea.y - r) + abs(eb.y - r))
        total += w * (abs(ea.y - ry) + abs(ea.x - eb.x) + abs(eb.y - ry))
        xs_by_rack.setdefault(ry, []).extend([ea.x, eb.x])
    # rack steel: only the racks actually used need physical span costed.
    total += RACK_STEEL_COST_PER_M * sum(max(xs) - min(xs) for xs in xs_by_rack.values())
    return total

# ------------------------------------------------------------------- solver

def random_place(eq: list, site: Site, spacing: dict, rng, keepouts: dict = None, tries=20000) -> bool:
    movable = [e for e in eq if not e.pinned]
    for _ in range(tries):
        for e in movable:
            e.x = rng.uniform(e.w / 2, site.w - e.w / 2)
            e.y = rng.uniform(e.d / 2, site.d - e.d / 2)
        if feasible(eq, site, spacing, keepouts):
            return True
    return False

def solve(eq: list, conns: list, site: Site, spacing: dict = None, keepouts: dict = None,
          seed=0, iters=60000, t0=50.0, t1=0.05) -> float:
    """Simulated annealing over feasible moves. Returns best cost."""
    # ponytail: SA + reject-infeasible. CP-SAT/MILP if this stalls on >30 items.
    spacing = DEFAULT_SPACING if spacing is None else spacing
    pinned = [e for e in eq if e.pinned]
    if pinned and not feasible(pinned, site, spacing, keepouts):
        raise RuntimeError("pinned equipment violates site/spacing/keepout constraints on its own")
    movable = [e for e in eq if not e.pinned]
    rng = random.Random(seed)
    if not random_place(eq, site, spacing, rng, keepouts):
        raise RuntimeError("no feasible initial layout — site too small for spacing table")
    cost = piping_cost(eq, conns, site)
    best = cost
    best_pos = [(e.x, e.y, e.w, e.d) for e in eq]
    for k in range(iters):
        if not movable:
            break  # everything pinned — nothing left to optimize
        t = t0 * (t1 / t0) ** (k / iters)
        e = rng.choice(movable)
        # ponytail: 20% of moves are a 90-degree rotation (swap w/d) instead
        # of a translation — same accept/reject/revert logic either way,
        # since feasible() already reads w/d for bounds/gap/keepout checks.
        rotate = rng.random() < 0.2
        if rotate:
            e.w, e.d = e.d, e.w
        else:
            ox, oy = e.x, e.y
            e.x = min(max(e.x + rng.gauss(0, t / 4 + 0.5), e.w / 2), site.w - e.w / 2)
            e.y = min(max(e.y + rng.gauss(0, t / 4 + 0.5), e.d / 2), site.d - e.d / 2)
        if not feasible(eq, site, spacing, keepouts):
            if rotate:
                e.w, e.d = e.d, e.w
            else:
                e.x, e.y = ox, oy
            continue
        new = piping_cost(eq, conns, site)
        if new < cost or rng.random() < math.exp((cost - new) / t):
            cost = new
            if cost < best:
                best, best_pos = cost, [(q.x, q.y, q.w, q.d) for q in eq]
        elif rotate:
            e.w, e.d = e.d, e.w
        else:
            e.x, e.y = ox, oy
    for e, (x, y, w, d) in zip(eq, best_pos):
        e.x, e.y, e.w, e.d = x, y, w, d
    return best

# --------------------------------------------------------------- DXF writer
# ponytail: hand-rolled DXF R12 (plain text) — ezdxf not needed for lines+text.

def _line(f, x1, y1, x2, y2, layer):
    f.write(f"0\nLINE\n8\n{layer}\n10\n{x1}\n20\n{y1}\n11\n{x2}\n21\n{y2}\n")

def _text(f, x, y, h, s, layer):
    f.write(f"0\nTEXT\n8\n{layer}\n10\n{x}\n20\n{y}\n40\n{h}\n1\n{s}\n")

def _zone_layer(zone: str) -> str:
    # ponytail: naming convention, not a new mechanism — a "road" or
    # "maintenance corridor" is just a keepout zone. Prefix the zone name
    # to pick which layer it draws on; anything else is a generic keepout.
    z = zone.upper()
    if z.startswith("ROAD"):
        return "ROADS"
    if z.startswith("MAINT"):
        return "MAINT"
    return "KEEPOUT"

def write_dxf(path: str, eq: list, site: Site, keepouts: dict = None):
    with open(path, "w") as f:
        f.write("0\nSECTION\n2\nENTITIES\n")
        # site boundary
        for (x1, y1), (x2, y2) in [((0, 0), (site.w, 0)), ((site.w, 0), (site.w, site.d)),
                                   ((site.w, site.d), (0, site.d)), ((0, site.d), (0, 0))]:
            _line(f, x1, y1, x2, y2, "SITE")
        # rack corridors
        for i, (ry, rhalf) in enumerate(site.racks):
            for y in (ry - rhalf, ry + rhalf):
                _line(f, 0, y, site.w, y, "RACK")
            label = "PIPE RACK" if len(site.racks) == 1 else f"PIPE RACK {i + 1}"
            _text(f, 1, ry - 0.6, 1.2, label, "RACK")
        # keep-out / road / maintenance zones
        for zone, poly in (keepouts or {}).items():
            layer = _zone_layer(zone)
            n = len(poly)
            for i in range(n):
                (x1, y1), (x2, y2) = poly[i], poly[(i + 1) % n]
                _line(f, x1, y1, x2, y2, layer)
            _text(f, poly[0][0], poly[0][1] + 0.4, 1.0, zone, layer)
        # equipment
        for e in eq:
            x1, y1, x2, y2 = _footprint(e)
            for (a, b), (c, d) in [((x1, y1), (x2, y1)), ((x2, y1), (x2, y2)),
                                   ((x2, y2), (x1, y2)), ((x1, y2), (x1, y1))]:
                _line(f, a, b, c, d, "EQUIPMENT")
            _text(f, x1, y2 + 0.4, 1.0, e.tag, "TAGS")
            pr = _pull_rect(e)
            if pr is not None:
                px1, py1, px2, py2 = pr
                for (a, b), (c, d) in [((px1, py1), (px2, py1)), ((px2, py1), (px2, py2)),
                                       ((px2, py2), (px1, py2)), ((px1, py2), (px1, py1))]:
                    _line(f, a, b, c, d, "PULL")
            wr = _wind_rect(e, site.wind_dir) if site.wind_dir else None
            if wr is not None:
                wx1, wy1, wx2, wy2 = wr
                for (a, b), (c, d) in [((wx1, wy1), (wx2, wy1)), ((wx2, wy1), (wx2, wy2)),
                                       ((wx2, wy2), (wx1, wy2)), ((wx1, wy2), (wx1, wy1))]:
                    _line(f, a, b, c, d, "WIND")
                _text(f, wx1, wy2 + 0.4, 1.0, "UPWIND", "WIND")
        f.write("0\nENDSEC\n0\nEOF\n")

# ------------------------------------------------------------- takeoff CSV
# ponytail: pure reporting, reuses the same rack-routed distance formula as
# piping_cost() — kept as one line of arithmetic here rather than a shared
# helper, since the cross-check below (`piping_cost(...) == cost`) is the
# thing that catches formula drift if these two ever disagree.

def write_takeoff(path: str, eq: list, conns: list, site: Site) -> None:
    """Write per-connection pipe length (m), per-rack steel span actually
    used, and total pipe length, in the sample format:
    type,a,b,weight,length_m."""
    by_tag = {e.tag: e for e in eq}
    total_pipe_m = 0.0
    xs_by_rack = {}
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["type", "a", "b", "weight", "length_m"])
        for a, b, weight in conns:
            ea, eb = by_tag[a], by_tag[b]
            ry = min((r for r, _ in site.racks), key=lambda r: abs(ea.y - r) + abs(eb.y - r))
            length = abs(ea.y - ry) + abs(ea.x - eb.x) + abs(eb.y - ry)
            w.writerow(["pipe", a, b, f"{weight:g}", f"{length:.2f}"])
            total_pipe_m += length
            xs_by_rack.setdefault(ry, []).extend([ea.x, eb.x])
        for ry in sorted(xs_by_rack):
            span = max(xs_by_rack[ry]) - min(xs_by_rack[ry])
            w.writerow(["rack_span_used", "", f"y={ry:g}", "", f"{span:.2f}"])
        w.writerow(["total_pipe_length_m", "", "", "", f"{total_pipe_m:.2f}"])

# ------------------------------------------------------------------- runner

def _check(eq: list, site: Site, spacing: dict, keepouts: dict = None, pinned_before=None):
    assert feasible(eq, site, spacing, keepouts), "solver returned infeasible layout"
    for i in range(len(eq)):
        for j in range(i + 1, len(eq)):
            g, m = edge_gap(eq[i], eq[j]), min_gap(eq[i].cls, eq[j].cls, spacing)
            assert g >= m - 1e-9, f"{eq[i].tag}-{eq[j].tag} gap {g:.1f} < {m}"
    for e in eq:
        x1, y1, x2, y2 = _footprint(e)
        for zone, poly in (keepouts or {}).items():
            assert not _rect_hits_poly(x1, y1, x2, y2, poly), f"{e.tag} overlaps keepout {zone}"
    for e in eq:
        pr = _pull_rect(e)
        if pr is None:
            continue
        px1, py1, px2, py2 = pr
        assert 0 <= px1 and px2 <= site.w and 0 <= py1 and py2 <= site.d, \
            f"{e.tag} pull clearance extends outside site"
        assert not any(py1 < ry + rhalf and py2 > ry - rhalf for ry, rhalf in site.racks), \
            f"{e.tag} pull clearance crosses a rack corridor"
        for zone, poly in (keepouts or {}).items():
            assert not _rect_hits_poly(px1, py1, px2, py2, poly), \
                f"{e.tag} pull clearance overlaps keepout {zone}"
        for other in eq:
            if other is e:
                continue
            ox1, oy1, ox2, oy2 = _footprint(other)
            assert not _rect_overlap(px1, py1, px2, py2, ox1, oy1, ox2, oy2), \
                f"{e.tag} pull clearance overlaps {other.tag}"
    if site.wind_dir:
        for e in eq:
            wr = _wind_rect(e, site.wind_dir)
            if wr is None:
                continue
            wx1, wy1, wx2, wy2 = wr
            for other in eq:
                if other is e:
                    continue
                ox1, oy1, ox2, oy2 = _footprint(other)
                assert not _rect_overlap(wx1, wy1, wx2, wy2, ox1, oy1, ox2, oy2), \
                    f"{other.tag} sits in {e.tag}'s upwind sector"
    if pinned_before:
        by_tag = {e.tag: e for e in eq}
        for tag, x, y in pinned_before:
            e = by_tag[tag]
            assert (e.x, e.y) == (x, y), f"pinned {tag} moved from ({x},{y}) to ({e.x},{e.y})"

def solve_ranked(data_dir: str, seeds):
    """Solve for each seed (fresh equipment copy per seed, since solve()
    mutates positions in place). Returns (results, best) where results is
    [(seed, cost), ...] sorted by cost and best is
    (cost, eq, conns, site, keepouts) for the winning seed. Shared by the
    CLI (run(), below) and the web API — the ranking loop and its
    pinned/self-check invariants live in exactly one place."""
    results = []
    best = None  # (cost, eq, conns, site, keepouts)
    for seed in seeds:
        eq, conns, spacing, site, keepouts = load_unit(data_dir)
        pinned_before = [(e.tag, e.x, e.y) for e in eq if e.pinned]
        cost = solve(eq, conns, site, spacing, keepouts, seed=seed)
        _check(eq, site, spacing, keepouts, pinned_before)
        results.append((seed, cost))
        if best is None or cost < best[0]:
            best = (cost, eq, conns, site, keepouts)
    results.sort(key=lambda r: r[1])
    return results, best

def run(data_dir: str, seeds, out_dxf="plotplan.dxf", out_takeoff="plotplan_takeoff.csv") -> list:
    """Prints a ranked score table, writes the best layout to out_dxf and a
    pipe-meter/rack-span report to out_takeoff. Returns [(seed, cost), ...]
    sorted by cost."""
    results, best = solve_ranked(data_dir, seeds)
    if len(results) > 1:
        print("seed  score")
        for seed, cost in results:
            marker = "  <- best" if seed == results[0][0] else ""
            print(f"{seed:4d}  {cost:.0f}{marker}")
    best_cost, best_eq, best_conns, best_site, best_keepouts = best
    assert abs(piping_cost(best_eq, best_conns, best_site) - best_cost) < 1e-6, \
        "takeoff's pipe-length formula disagrees with piping_cost — check for drift"
    write_dxf(out_dxf, best_eq, best_site, best_keepouts)
    write_takeoff(out_takeoff, best_eq, best_conns, best_site)
    print(f"piping cost score: {best_cost:.0f}  (seed {results[0][0]}, wrote {out_dxf}, {out_takeoff})")
    for e in sorted(best_eq, key=lambda q: q.tag):
        print(f"  {e.tag:6s} ({e.x:5.1f}, {e.y:5.1f})")
    return results

def _parse_seeds(arg: str) -> list:
    if ":" in arg:
        a, b = arg.split(":")
        return list(range(int(a), int(b)))
    return [int(arg)]

if __name__ == "__main__":
    args = sys.argv[1:]
    default_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "sample_unit")
    is_seed_arg = lambda a: a[0].isdigit() or (":" in a and a.split(":")[0].lstrip("-").isdigit())
    data_dir = default_dir
    seed_arg = "0"
    for a in args:
        if is_seed_arg(a):
            seed_arg = a
        else:
            data_dir = a
    run(data_dir, _parse_seeds(seed_arg))

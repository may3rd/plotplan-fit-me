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

from ortools.sat.python import cp_model

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

# ponytail: road curb-radius knobs, mirroring the frontend
# (ROAD_INNER_RADIUS_M / outer = inner + road width). DXF has no arc entity in
# the minimal writer below, so a rounded corner is approximated as this many
# short LINE segments along the quadratic bezier the frontend draws — bump up
# if a real export ever looks too faceted.
ROAD_INNER_RADIUS_M = 8.0
ROAD_FILLET_SEGMENTS = 8

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
    with open(path, newline="") as f:
        row = next(csv.DictReader(f))
    wind_dir = (row.get("wind_dir") or "").strip()
    return Site(float(row["w"]), float(row["d"]), wind_dir)

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

def _bbox(poly: list):
    xs, ys = [p[0] for p in poly], [p[1] for p in poly]
    return min(xs), min(ys), max(xs), max(ys)

def _is_rack_zone(zone: str) -> bool:
    return zone.upper().startswith("RACK")

def _rack_zones(keepouts: dict):
    """(zone, poly) pairs for pipe-rack zones — a rack is just a keepout
    zone named RACK* (same naming-convention mechanism ROAD*/MAINT* already
    use for their DXF layer, see _zone_layer()). Its bounding box is both
    the corridor equipment must clear (already true for every keepout, no
    rack-specific check needed) AND the piping-routing target (its
    y-center is the rack spine connections rise to / drop from)."""
    return [(z, poly) for z, poly in (keepouts or {}).items() if _is_rack_zone(z)]

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
        # keep-out: named polygon zones — flare radius, blast contours,
        # roads, maintenance corridors, AND pipe racks (a rack is just a
        # zone named RACK* — see _rack_zones()), all just zones in
        # keepouts.csv checked identically.
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

def piping_cost(eq: list, conns: list, site: Site, keepouts: dict = None) -> float:
    # all lines route via a rack: rise to the rack, run along, drop. Each
    # connection picks whichever rack zone's y-center gives it the shortest
    # rise+drop (the run-along-x term is the same regardless of which rack,
    # so it doesn't affect the choice). ponytail: doesn't check that either
    # endpoint's x actually falls inside the chosen rack's x-extent — same
    # simplification the old infinite-width racks made for free; upgrade to
    # excluding/penalizing out-of-bounds routes if a real unit needs it.
    racks = _rack_zones(keepouts)
    if conns and not racks:
        raise RuntimeError("no pipe rack zone defined (a keepouts zone named RACK*)")
    by_tag = {e.tag: e for e in eq}
    total = 0.0
    xs_by_rack = {}
    for a, b, w in conns:
        ea, eb = by_tag[a], by_tag[b]
        zone, ry = min(
            ((z, (_bbox(poly)[1] + _bbox(poly)[3]) / 2) for z, poly in racks),
            key=lambda zr: abs(ea.y - zr[1]) + abs(eb.y - zr[1]),
        )
        total += w * (abs(ea.y - ry) + abs(ea.x - eb.x) + abs(eb.y - ry))
        xs_by_rack.setdefault(zone, []).extend([ea.x, eb.x])
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

def _move_feasible(e, eq, site, spacing, kboxes, wind_dir):
    """Local feasibility check for one moved/rotated equipment e — same
    rules as feasible() but only the checks that involve e: its own site
    bounds, its footprint vs every keepout, its pairwise gap to every other
    item, and its swept rectangles (pull/wind) vs site/keepouts/others. The
    N² pairwise check and the N×K keepout check in feasible() each touch e
    once per pair/zone, so checking only e's half is exact, not an
    approximation — the un-touched items' mutual checks were already true
    before the move and can't change by moving e. Returns True if e's new
    position/size is feasible, else False (caller reverts)."""
    if not (e.w / 2 <= e.x <= site.w - e.w / 2 and
            e.d / 2 <= e.y <= site.d - e.d / 2):
        return False
    x1, y1, x2, y2 = _footprint(e)
    for box in kboxes:
        if _rect_overlap(x1, y1, x2, y2, *box):
            return False
    for o in eq:
        if o is e:
            continue
        if edge_gap(e, o) < min_gap(e.cls, o.cls, spacing):
            return False
    # e's own pull clearance vs site/keepouts/others' footprints...
    pr = _pull_rect(e)
    if pr is not None:
        px1, py1, px2, py2 = pr
        if not (0 <= px1 and px2 <= site.w and 0 <= py1 and py2 <= site.d):
            return False
        for box in kboxes:
            if _rect_overlap(px1, py1, px2, py2, *box):
                return False
        for o in eq:
            if o is e:
                continue
            ox1, oy1, ox2, oy2 = _footprint(o)
            if _rect_overlap(px1, py1, px2, py2, ox1, oy1, ox2, oy2):
                return False
    # ...and e's new footprint vs OTHER items' pull/wind rectangles —
    # feasible() checks pull/wind from each item's own perspective, so
    # moving e into another item's clearance violates that item's check
    # without e itself having a clearance. Same logic, opposite direction.
    for o in eq:
        if o is e:
            continue
        opr = _pull_rect(o)
        if opr is not None and _rect_overlap(x1, y1, x2, y2, *opr):
            return False
        if wind_dir and o.cls == "fired_heater":
            owr = _wind_rect(o, wind_dir)
            if owr is not None and _rect_overlap(x1, y1, x2, y2, *owr):
                return False
    # e's own wind rect (if e is a fired heater) vs others' footprints.
    if wind_dir and e.cls == "fired_heater":
        wr = _wind_rect(e, wind_dir)
        if wr is not None:
            wx1, wy1, wx2, wy2 = wr
            for o in eq:
                if o is e:
                    continue
                ox1, oy1, ox2, oy2 = _footprint(o)
                if _rect_overlap(wx1, wy1, wx2, wy2, ox1, oy1, ox2, oy2):
                    return False
    return True

def solve(eq: list, conns: list, site: Site, spacing: dict = None, keepouts: dict = None,
          seed=0, iters=60000, t0=50.0, t1=0.05, on_progress=None) -> float:
    """Simulated annealing over feasible moves. Returns best cost.
    on_progress: optional callable(fraction in [0,1]) fired ~100 times
    across the run — lets a UI show a real %-done bar instead of a spinner.
    The fraction is k/iters (the loop always runs iters iterations unless
    every item is pinned), so it's a faithful time estimate, not a guess."""
    # ponytail: SA + reject-infeasible. CP-SAT/MILP if this stalls on >30 items.
    spacing = DEFAULT_SPACING if spacing is None else spacing
    pinned = [e for e in eq if e.pinned]
    if pinned and not feasible(pinned, site, spacing, keepouts):
        raise RuntimeError("pinned equipment violates site/spacing/keepout constraints on its own")
    movable = [e for e in eq if not e.pinned]
    rng = random.Random(seed)
    if not random_place(eq, site, spacing, rng, keepouts):
        raise RuntimeError("no feasible initial layout — site too small for spacing table")
    # ponytail: precompute keepout bounding boxes (rect-rect overlap is a
    # far cheaper reject than _rect_hits_poly's point-in-polygon, and exact
    # for axis-aligned rect zones — this repo's only zone shape). _check()
    # still runs the full polygon test after the solve, so a non-rect zone
    # slipping through here would be caught; upgrade to per-edge half-planes
    # only if a real unit ships a concave zone.
    kboxes = [_bbox(poly) for poly in (keepouts or {}).values()]
    wind_dir = site.wind_dir
    cost = piping_cost(eq, conns, site, keepouts)
    best = cost
    best_pos = [(e.x, e.y, e.w, e.d) for e in eq]
    # ponytail: throttle on_progress to ~100 calls (every iters/100
    # iterations) — firing all 60000 would itself become the bottleneck.
    prog_step = max(1, iters // 100) if on_progress else 0
    for k in range(iters):
        if prog_step and k % prog_step == 0:
            on_progress(k / iters)
        if not movable:
            break  # everything pinned — nothing left to optimize
        t = t0 * (t1 / t0) ** (k / iters)
        # ponytail: move mix 60% translate / 20% rotate / 10% swap / 10%
        # relocate. Gaussian translate alone can't exchange the packing
        # order of two items in a tight row (swap does, in one move); pure
        # translate+rotate also loses global exploration as t shrinks and
        # step size with it (relocate restores a random-restart-sized jump
        # at any temperature). Each branch sets `touched` (items whose
        # feasibility needs re-checking) and `undo` (reverts this move only);
        # accept/reject below is shared across all four move kinds.
        r = rng.random()
        if r < 0.6:
            e = rng.choice(movable)
            ox, oy = e.x, e.y
            e.x = min(max(e.x + rng.gauss(0, t / 4 + 0.5), e.w / 2), site.w - e.w / 2)
            e.y = min(max(e.y + rng.gauss(0, t / 4 + 0.5), e.d / 2), site.d - e.d / 2)
            touched = (e,)
            def undo(e=e, ox=ox, oy=oy):
                e.x, e.y = ox, oy
        elif r < 0.8:
            e = rng.choice(movable)
            e.w, e.d = e.d, e.w
            touched = (e,)
            def undo(e=e):
                e.w, e.d = e.d, e.w
        elif r < 0.9:
            if len(movable) < 2:
                continue
            e1, e2 = rng.sample(movable, 2)
            e1.x, e2.x = e2.x, e1.x
            e1.y, e2.y = e2.y, e1.y
            touched = (e1, e2)
            def undo(e1=e1, e2=e2):
                e1.x, e2.x = e2.x, e1.x
                e1.y, e2.y = e2.y, e1.y
        else:
            e = rng.choice(movable)
            ox, oy = e.x, e.y
            e.x = rng.uniform(e.w / 2, site.w - e.w / 2)
            e.y = rng.uniform(e.d / 2, site.d - e.d / 2)
            touched = (e,)
            def undo(e=e, ox=ox, oy=oy):
                e.x, e.y = ox, oy
        # ponytail: local feasibility — only the checks involving `touched`,
        # since every other item's mutual checks were true before this move
        # and can't change. Checking each touched item against the fully
        # post-move layout (including the other touched item, for swap)
        # covers every pair a move could have broken — ~5x fewer rect-overlap
        # tests per iteration than re-running the full N²/N×K feasible(),
        # which the profile showed was 84% of solve time. _check() re-runs
        # the full feasible() after the solve.
        if not all(_move_feasible(t, eq, site, spacing, kboxes, wind_dir) for t in touched):
            undo()
            continue
        new = piping_cost(eq, conns, site, keepouts)
        if new < cost or rng.random() < math.exp((cost - new) / t):
            cost = new
            if cost < best:
                best, best_pos = cost, [(q.x, q.y, q.w, q.d) for q in eq]
        else:
            undo()
    for e, (x, y, w, d) in zip(eq, best_pos):
        e.x, e.y, e.w, e.d = x, y, w, d
    if on_progress:
        on_progress(1.0)
    return best

# ------------------------------------------------------ CP-SAT solver (item 11)
# ponytail: only reached above CPSAT_THRESHOLD movable items — see CLAUDE.md
# self-learning log for the measurement. Past ~30 items, random_place()'s
# scatter-then-reject-infeasible init starts failing outright even on a
# generously oversized site, because the odds of an all-N-item feasible
# random scatter collapse combinatorially. CP-SAT builds a feasible layout
# by constraint construction instead of by rejection sampling, so it
# doesn't have that failure mode — at the cost of a coarse position grid
# (CPSAT_GRID_M) instead of SA's continuous coordinates.

CPSAT_THRESHOLD = 30   # movable-item count above which solve_ranked() switches to CP-SAT
CPSAT_GRID_M = 0.5     # ponytail: position/length discretization for the CP-SAT model.
                       # Every safety-relevant quantity is rounded in the conservative
                       # direction (footprint sizes and clearances UP, site bounds and
                       # keep-out boxes to fully contain the real zone) so a grid-feasible
                       # layout, decoded back to exact meters, is always real-feasible —
                       # feasible()/_check() re-verify this after every CP-SAT solve.
                       # Halving CPSAT_GRID_M roughly doubles model size; tune down only
                       # if a real unit needs sub-0.5m placement precision.

def _g_ceil(meters: float, grid_m: float) -> int:
    return math.ceil(meters / grid_m - 1e-9)

def _g_floor(meters: float, grid_m: float) -> int:
    return math.floor(meters / grid_m + 1e-9)

# ponytail: CP-SAT is free to place a solution exactly touching a clearance
# boundary (its constraints are non-strict <=/>=). Two distinct reasons
# that can flip feasible()'s verdict after decoding back to real meters:
# (1) a strict (`<`) real check (pairwise gap, pull/wind clearance) vs
# CP-SAT's non-strict model — floating-point noise at exact equality can
# land on the wrong side; (2) feasible()'s keep-out check (_rect_hits_poly,
# racks included) is non-strict too, but its ray-casting point-in-polygon
# test is ambiguous for a query point exactly ON a zone edge/vertex —
# measured to matter in practice for rack zones specifically, since the
# piping-cost objective actively pulls equipment flush against a rack's
# edge. Padding every required minimum (gaps, keep-out/rack boxes,
# pull/wind clearance) by this margin before floor/ceil means the modeled
# requirement is always a hair stricter than the real one — decoded
# solutions clear feasible()'s check with room to spare instead of landing
# exactly on its boundary.
CPSAT_EPS_M = 0.01

def _cpsat_no_overlap(model, a, b, gap_grid: int, name: str):
    """a, b: (left, bottom, right, top) linear expressions/ints. Require the
    two rectangles separated by >= gap_grid in x or y (reified 4-way
    disjunction) — the axis-aligned approximation of edge_gap(), stronger
    than the exact Euclidean check in the diagonal case, so every solution
    found this way already satisfies feasible()'s exact check."""
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    left = model.NewBoolVar(f"{name}_l")
    right = model.NewBoolVar(f"{name}_r")
    below = model.NewBoolVar(f"{name}_b")
    above = model.NewBoolVar(f"{name}_a")
    model.Add(ax2 + gap_grid <= bx1).OnlyEnforceIf(left)
    model.Add(bx2 + gap_grid <= ax1).OnlyEnforceIf(right)
    model.Add(ay2 + gap_grid <= by1).OnlyEnforceIf(below)
    model.Add(by2 + gap_grid <= ay1).OnlyEnforceIf(above)
    model.AddBoolOr([left, right, below, above])

def solve_cpsat(eq: list, conns: list, site: Site, spacing: dict = None, keepouts: dict = None,
                 seed: int = 0, time_limit_s: float = 20.0, grid_m: float = CPSAT_GRID_M,
                 on_progress=None) -> float:
    """CP-SAT layout solver — same feasibility rules as feasible()/_check()
    (site bounds, keep-out zones — pipe racks included, they're just a
    zone named RACK* — pairwise class spacing, tube-pull clearance,
    prevailing wind, pinned equipment), reformulated as linear/disjunctive
    constraints on a grid_m-meter grid. Returns the same real (continuous,
    un-rounded) piping_cost() as solve() — see the ponytail notes below for
    the two things this simplifies relative to the SA solver.
    ponytail: keep-out zones (racks included) use their axis-aligned
    bounding box, not the exact polygon — exact for this repo's zones (all
    rectangles; see keepouts.csv), conservative (larger exclusion) for a
    genuinely concave zone. Upgrade to per-edge half-plane constraints if a
    real unit ships a non-rectangular zone this wrongly rejects.
    ponytail: the objective minimizes pipe rise+run+drop (the dominant
    term) but not piping_cost()'s rack-steel-span term — exactly modeling
    "x-span of only the items actually routed onto a used rack" needs
    conditional min/max bookkeeping that isn't worth it for a secondary
    cost term. The RETURNED score is still the true, complete piping_cost()
    (rack steel included), computed after decoding positions — CP-SAT just
    doesn't chase that last term during search.
    """
    spacing = DEFAULT_SPACING if spacing is None else spacing
    keepouts = keepouts or {}
    rack_zones = _rack_zones(keepouts)
    if conns and not rack_zones:
        raise RuntimeError("no pipe rack zone defined (a keepouts zone named RACK*)")
    G = grid_m
    pinned = [e for e in eq if e.pinned]
    if pinned and not feasible(pinned, site, spacing, keepouts):
        raise RuntimeError("pinned equipment violates site/spacing/keepout constraints on its own")

    model = cp_model.CpModel()
    site_w = _g_floor(site.w, G)
    site_d = _g_floor(site.d, G)
    # keep-out boxes (racks included — they're keepouts zones like any
    # other), padded outward by CPSAT_EPS_M. Both _cpsat_no_overlap's gap=0
    # separation and feasible()'s _rect_hits_poly are non-strict at a
    # glance, but _rect_hits_poly's ray-casting point-in-polygon check is
    # ambiguous for a query point exactly ON a polygon edge/vertex — and a
    # rack zone (unlike most keepouts) actively attracts CP-SAT solutions
    # flush against its edge, since hugging the rack minimizes rise/drop in
    # the objective. Measured: without this padding, solve_cpsat regularly
    # returns equipment exactly touching a rack edge that _check() then
    # flags as a keepout hit. Padding outward before flooring/ceiling keeps
    # decoded solutions clear of every zone with real margin, same
    # reasoning as the pairwise-gap and pull/wind-clearance padding below.
    kboxes = []
    for poly in keepouts.values():
        x1, y1, x2, y2 = _bbox(poly)
        kboxes.append((_g_floor(x1 - CPSAT_EPS_M, G), _g_floor(y1 - CPSAT_EPS_M, G),
                        _g_ceil(x2 + CPSAT_EPS_M, G), _g_ceil(y2 + CPSAT_EPS_M, G)))

    L, B, FW, FD, ROT = {}, {}, {}, {}, {}
    for e in eq:
        l = model.NewIntVar(0, site_w, f"L_{e.tag}")
        b = model.NewIntVar(0, site_d, f"B_{e.tag}")
        if e.pinned:
            # pinned position/size is never grid-derived (decode skips it and
            # keeps the exact original x,y,w,d) — so l/fw here must be the
            # tightest grid box that fully CONTAINS the real footprint
            # (floor the low edge, ceil the high edge independently), not
            # floor(real_left) combined with a separately-rounded ceil(w) —
            # those two roundings don't compose to a containing box in
            # general and could let a movable item sit closer than allowed.
            l_val, r_val = _g_floor(e.x - e.w / 2, G), _g_ceil(e.x + e.w / 2, G)
            b_val, t_val = _g_floor(e.y - e.d / 2, G), _g_ceil(e.y + e.d / 2, G)
            fw, fd = r_val - l_val, t_val - b_val
            model.Add(l == l_val)
            model.Add(b == b_val)
        else:
            w_g, d_g = _g_ceil(e.w, G), _g_ceil(e.d, G)
            rot = model.NewBoolVar(f"ROT_{e.tag}")
            fw = model.NewIntVar(min(w_g, d_g), max(w_g, d_g), f"FW_{e.tag}")
            fd = model.NewIntVar(min(w_g, d_g), max(w_g, d_g), f"FD_{e.tag}")
            model.Add(fw == w_g + rot * (d_g - w_g))
            model.Add(fd == d_g + rot * (w_g - d_g))
            ROT[e.tag] = rot
            model.Add(l + fw <= site_w)
            model.Add(b + fd <= site_d)
        L[e.tag], B[e.tag], FW[e.tag], FD[e.tag] = l, b, fw, fd
        for i, box in enumerate(kboxes):
            _cpsat_no_overlap(model, (l, b, l + fw, b + fd), box, 0, f"keep{i}_{e.tag}")

    for i in range(len(eq)):
        for j in range(i + 1, len(eq)):
            ei, ej = eq[i], eq[j]
            gap = _g_ceil(min_gap(ei.cls, ej.cls, spacing) + CPSAT_EPS_M, G)
            a = (L[ei.tag], B[ei.tag], L[ei.tag] + FW[ei.tag], B[ei.tag] + FD[ei.tag])
            b = (L[ej.tag], B[ej.tag], L[ej.tag] + FW[ej.tag], B[ej.tag] + FD[ej.tag])
            _cpsat_no_overlap(model, a, b, gap, f"sp{i}_{j}")

    # tube-pull clearance: swept rectangle vs site bounds/keepouts (racks
    # included)/every other footprint
    for e in eq:
        if not e.pull_side or e.pull_len <= 0:
            continue
        l, b, fw, fd = L[e.tag], B[e.tag], FW[e.tag], FD[e.tag]
        length = _g_ceil(e.pull_len, G)
        pr = {
            "x+": (l + fw, b, l + fw + length, b + fd),
            "x-": (l - length, b, l, b + fd),
            "y+": (l, b + fd, l + fw, b + fd + length),
            "y-": (l, b - length, l + fw, b),
        }.get(e.pull_side.strip())
        if pr is None:
            continue
        px1, py1, px2, py2 = pr
        model.Add(px1 >= 0); model.Add(px2 <= site_w)
        model.Add(py1 >= 0); model.Add(py2 <= site_d)
        for i, box in enumerate(kboxes):
            _cpsat_no_overlap(model, pr, box, 0, f"pullkeep{i}_{e.tag}")
        for other in eq:
            if other is e:
                continue
            ob = (L[other.tag], B[other.tag], L[other.tag] + FW[other.tag], B[other.tag] + FD[other.tag])
            _cpsat_no_overlap(model, pr, ob, 0, f"pull_{e.tag}_{other.tag}")

    # prevailing wind: fired heater's upwind rectangle vs every other footprint
    if site.wind_dir:
        wind_len = _g_ceil(WIND_CLEARANCE_M, G)
        for e in eq:
            if e.cls != "fired_heater":
                continue
            l, b, fw, fd = L[e.tag], B[e.tag], FW[e.tag], FD[e.tag]
            wr = {
                "x+": (l + fw, b, l + fw + wind_len, b + fd),
                "x-": (l - wind_len, b, l, b + fd),
                "y+": (l, b + fd, l + fw, b + fd + wind_len),
                "y-": (l, b - wind_len, l + fw, b),
            }.get(site.wind_dir.strip())
            if wr is None:
                continue
            for other in eq:
                if other is e:
                    continue
                ob = (L[other.tag], B[other.tag], L[other.tag] + FW[other.tag], B[other.tag] + FD[other.tag])
                _cpsat_no_overlap(model, wr, ob, 0, f"wind_{e.tag}_{other.tag}")

    # objective: pipe rise+run+drop, weight scaled to an integer (CP-SAT is integer-only)
    site_d2 = 2 * site_d
    cx2 = {tag: 2 * L[tag] + FW[tag] for tag in L}
    cy2 = {tag: 2 * B[tag] + FD[tag] for tag in L}
    rack_y2 = [round((_bbox(poly)[1] + _bbox(poly)[3]) / G) for _, poly in rack_zones]
    terms = []
    for idx, (a_tag, b_tag, weight) in enumerate(conns):
        run = model.NewIntVar(0, 2 * site_w, f"run{idx}")
        model.Add(run >= cx2[a_tag] - cx2[b_tag])
        model.Add(run >= cx2[b_tag] - cx2[a_tag])
        rise = model.NewIntVar(0, site_d2, f"rise{idx}")
        drop = model.NewIntVar(0, site_d2, f"drop{idx}")
        choose = [model.NewBoolVar(f"choose{idx}_{k}") for k in range(len(rack_zones))]
        model.Add(sum(choose) == 1)
        for k, ry2 in enumerate(rack_y2):
            model.Add(rise >= cy2[a_tag] - ry2).OnlyEnforceIf(choose[k])
            model.Add(rise >= ry2 - cy2[a_tag]).OnlyEnforceIf(choose[k])
            model.Add(drop >= cy2[b_tag] - ry2).OnlyEnforceIf(choose[k])
            model.Add(drop >= ry2 - cy2[b_tag]).OnlyEnforceIf(choose[k])
        terms.append(round(weight * 100) * (run + rise + drop))
    model.Minimize(sum(terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit_s
    solver.parameters.num_search_workers = 8
    solver.parameters.random_seed = seed
    if on_progress:
        on_progress(0.0)  # ponytail: CP-SAT's internal search has no progress hook; just mark start/end
    status = solver.Solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        raise RuntimeError("CP-SAT found no feasible layout within the time limit")
    if on_progress:
        on_progress(1.0)

    for e in eq:
        if e.pinned:
            continue  # exact pinned position/size, never derived from the grid
        rotated = solver.Value(ROT[e.tag])
        w, d = (e.d, e.w) if rotated else (e.w, e.d)
        x = solver.Value(L[e.tag]) * G + w / 2
        y = solver.Value(B[e.tag]) * G + d / 2
        e.x, e.y, e.w, e.d = x, y, w, d
    return piping_cost(eq, conns, site, keepouts)

# --------------------------------------------------------------- DXF writer
# ponytail: hand-rolled DXF R12 (plain text) — ezdxf not needed for lines+text.

def _line(f, x1, y1, x2, y2, layer):
    f.write(f"0\nLINE\n8\n{layer}\n10\n{x1}\n20\n{y1}\n11\n{x2}\n21\n{y2}\n")

def _text(f, x, y, h, s, layer):
    f.write(f"0\nTEXT\n8\n{layer}\n10\n{x}\n20\n{y}\n40\n{h}\n1\n{s}\n")

def _zone_layer(zone: str) -> str:
    # ponytail: naming convention, not a new mechanism — a "road", "pipe
    # rack", or "maintenance corridor" is just a keepout zone. Prefix the
    # zone name to pick which layer it draws on; anything else is a
    # generic keepout.
    z = zone.upper()
    if z.startswith("RACK"):
        return "RACK"
    if z.startswith("ROAD"):
        return "ROADS"
    if z.startswith("MAINT"):
        return "MAINT"
    return "KEEPOUT"

# ------------------------------------------------------------- zone merging
# ponytail: port of the frontend's merge+trace logic (PlotCanvas.jsx
# clusterZones/withCornerFills/unionRoadOutline/convexCornerFlags/
# outerSwingFlags/roundedPolygonPath) so the DXF export traces the true
# merged corridor area for roads and pipe racks instead of drawing each
# zone's own rectangle with a visible seam at every join. MAINT/KEEPOUT
# are area zones with no corridor semantics — they keep the per-polygon
# trace. Stdlib only, same shape as the existing _point_in_poly/_bbox.

def _zone_bbox(poly):
    x1, y1, x2, y2 = _bbox(poly)
    return {"minX": x1, "minY": y1, "maxX": x2, "maxY": y2}

def _bboxes_overlap(a, b, eps=0.05):
    return (a["minX"] <= b["maxX"] + eps and a["maxX"] >= b["minX"] - eps
            and a["minY"] <= b["maxY"] + eps and a["maxY"] >= b["minY"] - eps)

def _is_vertical(b):
    return (b["maxX"] - b["minX"]) <= (b["maxY"] - b["minY"])

def _cluster_zones(entries, should_merge):
    """Union-find clustering of [{zone, poly, bbox}] by a pairwise
    should_merge(a, b) predicate; transitively chains A-B-C into one
    cluster. Returns a list of clusters (each a list of entries)."""
    n = len(entries)
    parent = list(range(n))
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for i in range(n):
        for j in range(i + 1, n):
            if should_merge(entries[i]["bbox"], entries[j]["bbox"]):
                ri, rj = find(i), find(j)
                if ri != rj:
                    parent[ri] = rj
    groups = {}
    for i, e in enumerate(entries):
        groups.setdefault(find(i), []).append(e)
    return list(groups.values())

def _with_corner_fills(rects):
    """For every overlapping perpendicular pair, add the corner square
    (vertical road's x-range × horizontal road's y-range) so a two-click
    L/T/+ join traces as one outline instead of a stair-step notch."""
    out = list(rects)
    for i in range(len(rects)):
        for j in range(i + 1, len(rects)):
            a, b = rects[i], rects[j]
            av, bv = _is_vertical(a), _is_vertical(b)
            if av == bv:
                continue
            if not (a["minX"] < b["maxX"] and b["minX"] < a["maxX"]
                    and a["minY"] < b["maxY"] and b["minY"] < a["maxY"]):
                continue
            v, h = (a, b) if av else (b, a)
            out.append({"minX": v["minX"], "maxX": v["maxX"],
                        "minY": h["minY"], "maxY": h["maxY"]})
    return out

def _union_outline(rects):
    """Union axis-aligned rects into one rectilinear outline via a grid
    trace: build the coordinate grid, mark filled cells, collect each
    filled cell's edges that border the outside, link them tip-to-tail
    into a closed loop, drop collinear points. Assumes a simply-connected
    union (true for how roads/racks get drawn here). Returns [] if empty."""
    if not rects:
        return []
    xs = sorted({r["minX"] for r in rects} | {r["maxX"] for r in rects})
    ys = sorted({r["minY"] for r in rects} | {r["maxY"] for r in rects})
    nx, ny = len(xs) - 1, len(ys) - 1
    if nx <= 0 or ny <= 0:
        return []
    filled = [[any(xs[ix] < r["maxX"] and xs[ix + 1] > r["minX"]
                   and ys[iy] < r["maxY"] and ys[iy + 1] > r["minY"]
                   for r in rects)
               for ix in range(nx)] for iy in range(ny)]
    edges = []
    for iy in range(ny):
        for ix in range(nx):
            if not filled[iy][ix]:
                continue
            x0, x1, y0, y1 = xs[ix], xs[ix + 1], ys[iy], ys[iy + 1]
            if ix == 0 or not filled[iy][ix - 1]:
                edges.append(((x0, y0), (x0, y1)))
            if ix == nx - 1 or not filled[iy][ix + 1]:
                edges.append(((x1, y1), (x1, y0)))
            if iy == 0 or not filled[iy - 1][ix]:
                edges.append(((x1, y0), (x0, y0)))
            if iy == ny - 1 or not filled[iy + 1][ix]:
                edges.append(((x0, y1), (x1, y1)))
    if not edges:
        return []
    key = lambda p: f"{p[0]:.4f},{p[1]:.4f}"
    by_start = {key(e[0]): i for i, e in enumerate(edges)}
    used = [False] * len(edges)
    loop = []
    cur = 0
    for _ in range(len(edges)):
        used[cur] = True
        loop.append(edges[cur][0])
        nxt = by_start.get(key(edges[cur][1]))
        if nxt is None or used[nxt]:
            break
        cur = nxt
    n = len(loop)
    return [p for i, p in enumerate(loop)
            if not ((loop[(i - 1) % n][0] == p[0] == loop[(i + 1) % n][0])
                    or (loop[(i - 1) % n][1] == p[1] == loop[(i + 1) % n][1]))]

def _convex_corner_flags(outline):
    """True at corners that turn outward (outer curb of a bend); False at
    the inner notch. winding sign comes from signed area, then a corner's
    turn cross-product sign tells convex vs concave."""
    n = len(outline)
    if n < 3:
        return [False] * n
    area2 = 0.0
    for i in range(n):
        ax, ay = outline[i]
        bx, by = outline[(i + 1) % n]
        area2 += ax * by - bx * ay
    ccw = area2 > 0
    flags = []
    for i in range(n):
        a = outline[(i - 1) % n]
        p = outline[i]
        c = outline[(i + 1) % n]
        cross = (p[0] - a[0]) * (c[1] - p[1]) - (p[1] - a[1]) * (c[0] - p[0])
        flags.append(cross > 0 if ccw else cross < 0)
    return flags

def _outer_swing_flags(outline, convex, widths, eps=0.01):
    """Among convex corners, flag the outer curb-swing of a real bend
    (rounds wide) vs a dead-end cap (stays sharp). A bend's outer swing
    sits one road-width away on each axis from its paired concave notch."""
    notches = [outline[i] for i in range(len(outline)) if not convex[i]]
    is_width = lambda d: any(abs(d - w) < eps for w in widths)
    return [convex[i] and any(
        is_width(abs(outline[i][0] - q[0])) and is_width(abs(outline[i][1] - q[1]))
        for q in notches) for i in range(len(outline))]

def _rounded_polyline_segments(outline, radii, segments=ROAD_FILLET_SEGMENTS):
    """LINE segments tracing the outline with the flagged corners
    filleted: a straight edge from the previous corner's out-point to this
    corner's in-point, then a quadratic-bezier curve through the true
    corner point to this corner's out-point. Each edge is claimed only by
    the fillets at its own two endpoints (full edge if the far end is
    sharp, half if both round) so two curves can't overlap. A zero radius
    leaves that corner sharp (in-point == out-point == corner). Returns
    [(x1,y1,x2,y2), ...] tracing one closed loop."""
    n = len(outline)
    if n < 3:
        return []
    corners = []
    for i in range(n):
        prev = outline[(i - 1) % n]
        p = outline[i]
        nxt = outline[(i + 1) % n]
        ein = math.hypot(p[0] - prev[0], p[1] - prev[1])
        eout = math.hypot(nxt[0] - p[0], nxt[1] - p[1])
        in_share = ein / 2 if radii[(i - 1) % n] > 1e-9 else ein
        out_share = eout / 2 if radii[(i + 1) % n] > 1e-9 else eout
        r = min(radii[i], in_share, out_share) if radii[i] > 1e-9 else 0.0
        to_prev = ([(prev[0] - p[0]) / ein, (prev[1] - p[1]) / ein] if ein > 1e-6 else [0.0, 0.0])
        to_next = ([(nxt[0] - p[0]) / eout, (nxt[1] - p[1]) / eout] if eout > 1e-6 else [0.0, 0.0])
        corners.append({
            "in": (p[0] + to_prev[0] * r, p[1] + to_prev[1] * r),
            "corner": p,
            "out": (p[0] + to_next[0] * r, p[1] + to_next[1] * r),
            "rounded": r > 1e-6,
        })
    segs = []
    for i in range(n):
        prev_out = corners[(i - 1) % n]["out"]
        c = corners[i]
        start = c["in"] if c["rounded"] else c["corner"]
        # straight edge from the previous corner's out-point to this
        # corner's in-point (collapses to zero length when both ends are
        # the same sharp corner, which the DXF writer just drops visually)
        if math.hypot(start[0] - prev_out[0], start[1] - prev_out[1]) > 1e-9:
            segs.append((prev_out[0], prev_out[1], start[0], start[1]))
        if c["rounded"]:
            # quadratic bezier P(t) = (1-t)^2 start + 2(1-t)t corner + t^2 out
            prev_pt = start
            for k in range(1, segments + 1):
                t = k / segments
                u = 1 - t
                bx = u * u * start[0] + 2 * u * t * c["corner"][0] + t * t * c["out"][0]
                by = u * u * start[1] + 2 * u * t * c["corner"][1] + t * t * c["out"][1]
                segs.append((prev_pt[0], prev_pt[1], bx, by))
                prev_pt = (bx, by)
    return segs

def _merged_zone_segments(zones, round_corners):
    """Trace a merged corridor (roads or crossing racks) as LINE segments.
    `zones` is a list of (zone, poly) pairs already grouped into one
    cluster. `round_corners` picks road curb-radius (True) vs rack sharp
    (False). Returns (segs, label_point) where label_point is the outline
    centroid for the zone label text."""
    rects = [_zone_bbox(poly) for _, poly in zones]
    outline = _union_outline(_with_corner_fills(rects))
    if len(outline) < 3:
        return [], None
    cx = sum(p[0] for p in outline) / len(outline)
    cy = sum(p[1] for p in outline) / len(outline)
    if not round_corners:
        segs = []
        n = len(outline)
        for i in range(n):
            segs.append((outline[i][0], outline[i][1],
                         outline[(i + 1) % n][0], outline[(i + 1) % n][1]))
        return segs, (cx, cy)
    convex = _convex_corner_flags(outline)
    widths = [min(r["maxX"] - r["minX"], r["maxY"] - r["minY"]) for r in rects]
    outer = ROAD_INNER_RADIUS_M + min(widths) if widths else ROAD_INNER_RADIUS_M
    swing = _outer_swing_flags(outline, convex, widths)
    radii = [outer if (convex[i] and swing[i]) else (ROAD_INNER_RADIUS_M if not convex[i] else 0.0)
             for i in range(len(outline))]
    return _rounded_polyline_segments(outline, radii), (cx, cy)

def write_dxf(path: str, eq: list, site: Site, keepouts: dict = None):
    with open(path, "w") as f:
        f.write("0\nSECTION\n2\nENTITIES\n")
        # site boundary
        for (x1, y1), (x2, y2) in [((0, 0), (site.w, 0)), ((site.w, 0), (site.w, site.d)),
                                   ((site.w, site.d), (0, site.d)), ((0, site.d), (0, 0))]:
            _line(f, x1, y1, x2, y2, "SITE")
        # keep-out / road / pipe-rack / maintenance zones. Roads and pipe
        # racks are corridors — overlapping roads (any orientation) and
        # crossing racks (one horizontal, one vertical) merge into one
        # traced outline so the join reads as a single continuous corridor
        # instead of two rectangles with a seam. MAINT/KEEPOUT are area
        # zones with no corridor semantics; each keeps its own polygon.
        kk = keepouts or {}
        road_entries = [{"zone": z, "poly": p, "bbox": _zone_bbox(p)}
                        for z, p in kk.items() if z.upper().startswith("ROAD")]
        rack_entries = [{"zone": z, "poly": p, "bbox": _zone_bbox(p)}
                        for z, p in kk.items() if z.upper().startswith("RACK")]
        merged_names = set()  # zones subsumed by a merged outline (skip per-poly)
        for cluster in _cluster_zones(road_entries, _bboxes_overlap):
            if len(cluster) < 2:
                continue
            segs, label = _merged_zone_segments([(e["zone"], e["poly"]) for e in cluster], True)
            for x1, y1, x2, y2 in segs:
                _line(f, x1, y1, x2, y2, "ROADS")
            if label is not None:
                _text(f, label[0], label[1] + 0.4, 1.0, "ROAD", "ROADS")
            merged_names.update(e["zone"] for e in cluster)
        for cluster in _cluster_zones(
                rack_entries,
                lambda a, b: _bboxes_overlap(a, b) and _is_vertical(a) != _is_vertical(b)):
            if len(cluster) < 2:
                continue
            segs, label = _merged_zone_segments([(e["zone"], e["poly"]) for e in cluster], False)
            for x1, y1, x2, y2 in segs:
                _line(f, x1, y1, x2, y2, "RACK")
            if label is not None:
                _text(f, label[0], label[1] + 0.4, 1.0, "RACK", "RACK")
            merged_names.update(e["zone"] for e in cluster)
        for zone, poly in kk.items():
            if zone in merged_names:
                continue
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

def write_takeoff(path: str, eq: list, conns: list, site: Site, keepouts: dict = None) -> None:
    """Write per-connection pipe length (m), per-rack steel span actually
    used, and total pipe length, in the sample format:
    type,a,b,weight,length_m."""
    racks = _rack_zones(keepouts)
    by_tag = {e.tag: e for e in eq}
    total_pipe_m = 0.0
    xs_by_rack = {}
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["type", "a", "b", "weight", "length_m"])
        for a, b, weight in conns:
            ea, eb = by_tag[a], by_tag[b]
            zone, ry = min(
                ((z, (_bbox(poly)[1] + _bbox(poly)[3]) / 2) for z, poly in racks),
                key=lambda zr: abs(ea.y - zr[1]) + abs(eb.y - zr[1]),
            )
            length = abs(ea.y - ry) + abs(ea.x - eb.x) + abs(eb.y - ry)
            w.writerow(["pipe", a, b, f"{weight:g}", f"{length:.2f}"])
            total_pipe_m += length
            xs_by_rack.setdefault(zone, []).extend([ea.x, eb.x])
        for zone in sorted(xs_by_rack):
            span = max(xs_by_rack[zone]) - min(xs_by_rack[zone])
            w.writerow(["rack_span_used", "", zone, "", f"{span:.2f}"])
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
        # ponytail: item 11's gate, measured — see CLAUDE.md self-learning.
        # random_place()'s scatter-then-reject init starts failing outright
        # above CPSAT_THRESHOLD movable items even on a generously sized
        # site, so CP-SAT (builds a feasible layout by construction) takes
        # over there instead of SA.
        movable = sum(1 for e in eq if not e.pinned)
        if movable > CPSAT_THRESHOLD:
            cost = solve_cpsat(eq, conns, site, spacing, keepouts, seed=seed)
        else:
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
    assert abs(piping_cost(best_eq, best_conns, best_site, best_keepouts) - best_cost) < 1e-6, \
        "takeoff's pipe-length formula disagrees with piping_cost — check for drift"
    write_dxf(out_dxf, best_eq, best_site, best_keepouts)
    write_takeoff(out_takeoff, best_eq, best_conns, best_site, best_keepouts)
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

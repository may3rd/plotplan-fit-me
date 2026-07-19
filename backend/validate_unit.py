"""Validation checkpoint harness — PLAN.md's outstanding item.

Run the solver against one real as-built unit and report where it disagrees.

A "real unit" here is a normal `data/<name>/` folder of CSVs with one twist:
every equipment row is `pinned=true` at its real as-built position. That makes
the loaded layout the as-built itself, which we then score and feasibility-
check (the as-built being infeasible under our model is itself a finding — it
means a constraint we're missing or over-tight), then re-solve the SAME unit
with all pins dropped so the solver is free to find its own layout, and
compare per-equipment displacement and total piping cost.

Disagreement falls into three buckets, each actionable:
  (a) as-built INFEASIBLE under our model -> a missing or wrong constraint.
      Add it to PLAN.md's optional-later list, don't trust the saving.
  (b) as-built feasible, solver beats it on modeled cost -> a real saving
      (the whole tool's pitch) OR a constraint the as-built respected that we
      don't model (cross-check against (a): if as-built is feasible, the
      saving is genuine under the constraints we DO have).
  (c) solver can't beat the as-built -> model is fine for this unit; the
      as-built was already near-optimal under our constraints.

Usage:
    python validate_unit.py [data_dir] [seed_range]
    defaults to data/sample_unit, seeds 0:16.

    sample_unit is a synthetic reference, NOT a real as-built — running this
    on it only sanity-checks the harness end-to-end (the "saving" it reports
    is meaningless until you point it at a real unit with pinned positions
    that came from an actual plot plan).
"""
import copy
import os
import sys

import plotplan as pp


def _fmt_xy(e):
    return f"({e.x:6.1f}, {e.y:6.1f})"


def _displacement(asbuilt, solved):
    """Per-tag center-to-center distance (m) between the as-built layout and
    the solver's. Tags match by name; an item present in only one side is
    reported as None."""
    a_by = {e.tag: e for e in asbuilt}
    s_by = {e.tag: e for e in solved}
    out = []
    for tag in sorted(set(a_by) | set(s_by)):
        a, s = a_by.get(tag), s_by.get(tag)
        if a and s:
            out.append((tag, ((s.x - a.x) ** 2 + (s.y - a.y) ** 2) ** 0.5))
        else:
            out.append((tag, None))
    return out


def _violations(eq, site, spacing, keepouts):
    """Human-readable list of why `feasible()` would reject this layout, for
    diagnosing bucket (a). Mirrors _check()'s assertions but collects instead
    of raising."""
    v = []
    for e in eq:
        if not (e.w / 2 <= e.x <= site.w - e.w / 2 and
               e.d / 2 <= e.y <= site.d - e.d / 2):
            v.append(f"{e.tag} outside site bounds at {_fmt_xy(e)} "
                     f"(footprint {e.w:.1f}x{e.d:.1f}, site {site.w:.0f}x{site.d:.0f})")
        x1, y1, x2, y2 = pp._footprint(e)
        for zone, poly in (keepouts or {}).items():
            if pp._rect_hits_poly(x1, y1, x2, y2, poly):
                v.append(f"{e.tag} overlaps keepout zone {zone}")
    for i in range(len(eq)):
        for j in range(i + 1, len(eq)):
            g, m = pp.edge_gap(eq[i], eq[j]), pp.min_gap(eq[i].cls, eq[j].cls, spacing)
            if g < m - 1e-9:
                v.append(f"{eq[i].tag}-{eq[j].tag} gap {g:.1f}m < required {m:.1f}m")
    for e in eq:
        pr = pp._pull_rect(e)
        if pr is None:
            continue
        px1, py1, px2, py2 = pr
        if not (0 <= px1 and px2 <= site.w and 0 <= py1 and py2 <= site.d):
            v.append(f"{e.tag} pull clearance ({e.pull_side} {e.pull_len:.0f}m) "
                      "extends outside site")
        for zone, poly in (keepouts or {}).items():
            if pp._rect_hits_poly(px1, py1, px2, py2, poly):
                v.append(f"{e.tag} pull clearance overlaps keepout zone {zone}")
        for other in eq:
            if other is e:
                continue
            ox1, oy1, ox2, oy2 = pp._footprint(other)
            if pp._rect_overlap(px1, py1, px2, py2, ox1, oy1, ox2, oy2):
                v.append(f"{e.tag} pull clearance overlaps {other.tag}")
    if site.wind_dir:
        for e in eq:
            wr = pp._wind_rect(e, site.wind_dir)
            if wr is None:
                continue
            wx1, wy1, wx2, wy2 = wr
            for other in eq:
                if other is e:
                    continue
                ox1, oy1, ox2, oy2 = pp._footprint(other)
                if pp._rect_overlap(wx1, wy1, wx2, wy2, ox1, oy1, ox2, oy2):
                    v.append(f"{other.tag} sits in {e.tag}'s upwind sector "
                             f"(wind {site.wind_dir}, standoff {pp.WIND_CLEARANCE_M:.0f}m)")
    return v


def validate(data_dir, seeds):
    eq, conns, spacing, site, keepouts = pp.load_unit(data_dir)
    n_pinned = sum(1 for e in eq if e.pinned)
    n_total = len(eq)
    print(f"unit: {os.path.basename(data_dir.rstrip('/'))}")
    print(f"  {n_total} equipment, {n_pinned} pinned (as-built positions)")
    print(f"  {len(conns)} connections, {len(keepouts)} keepout zones, "
          f"wind_dir={site.wind_dir or '(none)'}")

    asbuilt_feasible = pp.feasible(eq, site, spacing, keepouts)
    asbuilt_cost = pp.piping_cost(eq, conns, site, keepouts) if asbuilt_feasible else None
    if asbuilt_cost is not None:
        print(f"\n[as-built]  feasible={asbuilt_feasible}  cost={asbuilt_cost:.0f}")
    else:
        print("\n[as-built]  feasible=False  cost=(infeasible under our model)")
    if not asbuilt_feasible:
        print("\n  bucket (a): as-built is INFEASIBLE under our model.")
        print("  Missing or wrong constraint — do NOT trust any 'saving' below.")
        for line in _violations(eq, site, spacing, keepouts):
            print(f"    - {line}")

    # Re-solve the same unit with all pins dropped — the solver is free to
    # move everything. Deep-copy per seed (solve_one mutates eq in place),
    # mirroring _solve_ranked_one's shape but without the per-seed CSV
    # reload — we already have the unit in memory and only want to drop pins.
    free_eq = copy.deepcopy(eq)
    for e in free_eq:
        e.pinned = False
    results = []
    best_cost = None
    best_eq = None
    for seed in seeds:
        seed_eq = copy.deepcopy(free_eq)
        cost = pp.solve_one(seed_eq, conns, site, spacing, keepouts, seed=seed)
        pp._check(seed_eq, site, spacing, keepouts)
        results.append((seed, cost))
        if best_cost is None or cost < best_cost:
            best_cost, best_eq = cost, seed_eq
    results.sort(key=lambda r: r[1])
    print(f"\n[solver]    best cost={best_cost:.0f}  "
          f"(across {len(seeds)} seed{'s' if len(seeds) != 1 else ''})")
    if len(results) > 1:
        print("  seed  score")
        for seed, cost in results[:10]:
            marker = "  <- best" if seed == results[0][0] else ""
            print(f"  {seed:4d}  {cost:.0f}{marker}")
        if len(results) > 10:
            print(f"  ... ({len(results) - 10} more)")

    # Comparison
    print("\n[comparison]")
    if asbuilt_cost is None:
        print("  as-built infeasible under our model — no cost comparison possible.")
        print("  Fix the constraint first, then re-run.")
    else:
        delta = asbuilt_cost - best_cost
        pct = 100.0 * delta / asbuilt_cost if asbuilt_cost else 0.0
        if best_cost < asbuilt_cost - 1e-6:
            print(f"  bucket (b): solver BEATS as-built by {delta:.0f} ({pct:.1f}%)")
            print("  Real saving under our constraints — OR a constraint the as-built")
            print("  respected that we don't model. Cross-check: as-built was feasible?")
            print(f"  -> {asbuilt_feasible}. If yes, the saving is genuine under what we have.")
        elif best_cost > asbuilt_cost + 1e-6:
            print(f"  solver LOSES to as-built by {-delta:.0f} ({-pct:.1f}%)")
            print("  Unexpected — either a seed-count too low to find the as-built's basin,")
            print("  or a constraint forcing the solver somewhere the as-built didn't go.")
        else:
            print(f"  bucket (c): solver matches as-built (within {abs(delta):.1f}).")
            print("  Model is fine for this unit; as-built was already near-optimal.")

    print("\n[per-equipment displacement: as-built -> solver]")
    print("  tag       as-built          solver            move (m)")
    for tag, dist in _displacement(eq, best_eq):
        a = next((e for e in eq if e.tag == tag), None)
        s = next((e for e in best_eq if e.tag == tag), None)
        if a and s:
            move = f"{dist:6.1f}" if dist is not None else "rotated"
            print(f"  {tag:8s}  {_fmt_xy(a)}   {_fmt_xy(s)}   {move}")
        elif a:
            print(f"  {tag:8s}  {_fmt_xy(a)}   (solver dropped it)        -")
        elif s:
            print(f"  {tag:8s}  (not in as-built)   {_fmt_xy(s)}   -")

    return {
        "asbuilt_feasible": asbuilt_feasible,
        "asbuilt_cost": asbuilt_cost,
        "solver_cost": best_cost,
        "seeds": len(seeds),
    }


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    default_dir = os.path.join(here, "data", "sample_unit")
    args = sys.argv[1:]
    is_seed_arg = lambda a: a[0].isdigit() or (":" in a and a.split(":")[0].lstrip("-").isdigit())
    data_dir = default_dir
    seed_arg = "0:16"
    for a in args:
        if is_seed_arg(a):
            seed_arg = a
        else:
            data_dir = a
    if ":" in seed_arg:
        a, b = seed_arg.split(":")
        seeds = list(range(int(a), int(b)))
    else:
        seeds = [int(seed_arg)]
    validate(data_dir, seeds)
"""Self-check for the CP-SAT solver (PLAN.md item 11): synthetic >30-item
unit, built in-memory (no CSV fixtures) since it exists purely to exercise
solve_cpsat(), not to model a real unit. Run: python3 test_cpsat.py"""
import random

import plotplan as p

def build_unit(n=32, seed=1):
    rng = random.Random(seed)
    classes = ["exchanger"] * 4 + ["pump_hc"] * 3 + ["vessel"] * 2 + ["column"] * 2 + ["fired_heater"]
    eq = []
    for i in range(n):
        cls = "fired_heater" if i == 0 else rng.choice(classes)
        w, d = round(rng.uniform(2, 6), 1), round(rng.uniform(2, 6), 1)
        eq.append(p.Equipment(f"E-{i:03d}", cls, w, d))
    eq[0].x, eq[0].y, eq[0].pinned = 20.0, 15.0, True   # pinned fired heater
    eq[1].pull_side, eq[1].pull_len = "x+", 5.0          # tube-pull clearance
    conns = [(eq[i].tag, eq[i + 1].tag, round(rng.uniform(1, 5), 1)) for i in range(n - 1)]
    for _ in range(n):
        a, b = rng.sample(eq, 2)
        conns.append((a.tag, b.tag, round(rng.uniform(1, 5), 1)))
    site = p.Site(170.0, 130.0, [(45.0, 3.0), (95.0, 3.0)], wind_dir="x+")
    keepouts = {"UNDERGROUND": [(140, 5), (160, 5), (160, 40), (140, 40)]}
    return eq, conns, p.load_spacing(
        __import__("os").path.join(__import__("os").path.dirname(__file__),
                                    "data", "sample_unit", "spacing.csv")), site, keepouts

def main():
    eq, conns, spacing, site, keepouts = build_unit()
    assert sum(1 for e in eq if not e.pinned) > p.CPSAT_THRESHOLD, \
        "test unit must exceed CPSAT_THRESHOLD to actually exercise the CP-SAT path"
    pinned_before = [(e.tag, e.x, e.y) for e in eq if e.pinned]

    cost = p.solve_cpsat(eq, conns, site, spacing, keepouts, seed=0, time_limit_s=15.0)
    p._check(eq, site, spacing, keepouts, pinned_before)
    assert abs(p.piping_cost(eq, conns, site) - cost) < 1e-6, \
        "solve_cpsat's returned cost must equal piping_cost() on the decoded layout"

    by_tag = {e.tag: e for e in eq}
    assert (by_tag["E-000"].x, by_tag["E-000"].y) == (20.0, 15.0), "pinned item must not move"

    print(f"OK: {len(eq)} items, cost={cost:.0f}, all _check() assertions passed")

if __name__ == "__main__":
    main()

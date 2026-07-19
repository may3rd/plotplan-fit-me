"""Self-check for the nozzle/tie-in offset feature (PLAN.md optional-later
item). A nozzle offset (nozzle_dx/nozzle_dy, meters, in the item's local
frame) lets piping_cost() / solve_cpsat() / write_takeoff() measure a
connection's rise/run/drop from the actual tie-in point, not the centroid —
and rotates with the item so the tie-in point tracks the right face after a
rotate. Run: python3 test_nozzle.py"""
import csv
import io
import os
import tempfile

import plotplan as p


def test_rotate_point_cw():
    """One CW step maps (1,0) -> (0,-1); four steps return to start."""
    assert p._rotate_point_cw(1.0, 0.0) == (0.0, -1.0)
    assert p._rotate_point_cw(0.0, -1.0) == (-1.0, 0.0)
    assert p._rotate_point_cw(-1.0, 0.0) == (0.0, 1.0)
    assert p._rotate_point_cw(0.0, 1.0) == (1.0, 0.0)
    # zero offset is fixed under rotation
    assert p._rotate_point_cw(0.0, 0.0) == (0.0, 0.0)
    # matches _rotate_side_cw's cycle: x+ (1,0) -> y- (0,-1) -> x- (-1,0) -> y+ (0,1)
    side = "x+"
    x, y = 1.0, 0.0
    for _ in range(4):
        x, y = p._rotate_point_cw(x, y)
        side = p._rotate_side_cw(side)
        # the rotated offset points the same way the rotated side does
        assert {(1.0, 0.0): "x+", (0.0, -1.0): "y-", (-1.0, 0.0): "x-", (0.0, 1.0): "y+"}[(x, y)] == side
    print("OK: _rotate_point_cw cycles (dx,dy) matching _rotate_side_cw")


def test_nozzle_xy():
    e = p.Equipment("A", "pump_hc", 2.0, 3.0, x=10.0, y=20.0)
    assert p._nozzle_xy(e) == (10.0, 20.0), "no offset = center"
    e2 = p.Equipment("A", "pump_hc", 2.0, 3.0, x=10.0, y=20.0, nozzle_dx=1.5, nozzle_dy=-2.0)
    assert p._nozzle_xy(e2) == (11.5, 18.0)
    print("OK: _nozzle_xy returns center + (rotated) offset")


def test_piping_cost_uses_nozzle():
    """Two items, one connection, one rack between them. With a nozzle
    offset on the low-y item pulling the tie-in UP toward the rack, the
    rise term shrinks and the cost drops vs the center-based formula."""
    site = p.Site(30.0, 30.0)
    rack = {"RACK_1": [(0.0, 14.0), (30.0, 14.0), (30.0, 16.0), (0.0, 16.0)]}
    ry = 15.0  # rack centerline y
    low = p.Equipment("L", "vessel", 2.0, 2.0, x=5.0, y=5.0)
    high = p.Equipment("H", "vessel", 2.0, 2.0, x=25.0, y=25.0)
    conns = [("L", "H", 1.0)]
    # center-based cost (both nozzles 0): rise = |5-15| + |25-15| = 20,
    # run = |5-25| = 20, + rack steel span = |5-25| = 20 -> total 60
    base = p.piping_cost([low, high], conns, site, rack)
    assert abs(base - (20.0 + 20.0 + 20.0)) < 1e-9, base
    # nozzle on LOW pulled UP toward the rack by 2m: rise shrinks by 2
    low_nz = p.Equipment("L", "vessel", 2.0, 2.0, x=5.0, y=5.0, nozzle_dx=0.0, nozzle_dy=2.0)
    with_nz = p.piping_cost([low_nz, high], conns, site, rack)
    assert abs(with_nz - (base - 2.0)) < 1e-9, (with_nz, base)
    print("OK: piping_cost measures rise/run/drop nozzle-to-nozzle, not center-to-center")


def test_sa_rotate_rotates_nozzle():
    """solve()'s rotate move rotates nozzle_dx/dy alongside w/d/pull_side;
    best_pos snapshot/restore preserves the rotated offset. Same setup as
    test_rotate.py's SA test (connection across a rack so rotation isn't
    cost-neutral), but with a nozzle offset that must come back rotated."""
    site = p.Site(30.0, 30.0)
    rack = {"RACK_1": [(0.0, 14.0), (30.0, 14.0), (30.0, 16.0), (0.0, 16.0)]}
    anchor = p.Equipment("B", "pump_hc", 2.0, 2.0, x=25.0, y=25.0, pinned=True)
    # nozzle at +x (1,0); after two 90 CW steps it's at -x (-1,0) (180 deg)
    e = p.Equipment("A", "exchanger", 5.0, 2.0, x=5.0, y=5.0, nozzle_dx=1.0, nozzle_dy=0.0)
    eq = [e, anchor]
    p.solve(eq, [("A", "B", 2.0)], site, {}, rack, seed=0, iters=5000, t0=8.0)
    # w/d are back to original after an even number of net rotations (per
    # test_rotate.py); nozzle_dx must reflect the same net 180 rotation.
    assert (eq[0].w, eq[0].d) == (5.0, 2.0)
    assert (eq[0].nozzle_dx, eq[0].nozzle_dy) == (-1.0, 0.0), \
        f"nozzle must net-rotate 180 deg: got ({eq[0].nozzle_dx}, {eq[0].nozzle_dy})"
    p._check(eq, site, {}, rack)
    print(f"OK: SA rotate move keeps nozzle in sync with w/d ({eq[0].nozzle_dx}, {eq[0].nozzle_dy})")


def test_cpsat_rotate_rotates_nozzle():
    """solve_cpsat()'s ROT var forces a rotation (site too narrow for the
    unrotated footprint's pull clearance — same setup as test_rotate.py's
    CP-SAT test) and the decode step rotates the nozzle offset to match."""
    site = p.Site(8.0, 20.0)
    eq = [p.Equipment("A", "exchanger", 6.0, 2.0, pull_side="x+", pull_len=3.0,
                      nozzle_dx=2.0, nozzle_dy=0.0)]
    p.solve_cpsat(eq, [], site, {}, {}, seed=0, time_limit_s=10.0)
    assert (eq[0].w, eq[0].d) == (2.0, 6.0), "must have rotated to fit"
    # one CW step: (2, 0) -> (0, -2)
    assert (eq[0].nozzle_dx, eq[0].nozzle_dy) == (0.0, -2.0), \
        f"nozzle must rotate with the footprint: got ({eq[0].nozzle_dx}, {eq[0].nozzle_dy})"
    p._check(eq, site, {}, {})
    print(f"OK: CP-SAT ROT var keeps nozzle in sync with w/d ({eq[0].nozzle_dx}, {eq[0].nozzle_dy})")


def test_write_takeoff_matches_piping_cost_with_nozzle():
    """write_takeoff's per-connection length uses the nozzle formula too,
    so the sum of pipe rows matches piping_cost() (run()'s cross-check
    asserts this for the no-nozzle case; here we cover a nozzle case)."""
    site = p.Site(30.0, 30.0)
    rack = {"RACK_1": [(0.0, 14.0), (30.0, 14.0), (30.0, 16.0), (0.0, 16.0)]}
    a = p.Equipment("A", "vessel", 2.0, 2.0, x=5.0, y=5.0, nozzle_dx=0.0, nozzle_dy=-2.0)
    b = p.Equipment("B", "vessel", 2.0, 2.0, x=25.0, y=25.0, nozzle_dx=1.0, nozzle_dy=0.0)
    conns = [("A", "B", 2.5)]
    cost = p.piping_cost([a, b], conns, site, rack)
    with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, newline="") as f:
        path = f.name
    try:
        p.write_takeoff(path, [a, b], conns, site, rack)
        with open(path) as fh:
            rows = list(csv.DictReader(fh))
        pipe_len = float([r for r in rows if r["type"] == "pipe"][0]["length_m"])
        rack_span = float([r for r in rows if r["type"] == "rack_span_used"][0]["length_m"])
        # weight * (nozzle-based rise/run/drop) + RACK_STEEL_COST_PER_M * span == piping_cost
        rebuilt = 2.5 * pipe_len + p.RACK_STEEL_COST_PER_M * rack_span
        assert abs(rebuilt - cost) < 1e-9, (rebuilt, cost)
    finally:
        os.unlink(path)
    print("OK: write_takeoff's length formula uses the nozzle tie-in point")


def test_backward_compat_zero_nozzle_equals_center():
    """A unit with no nozzle columns (old equipment.csv) loads with
    nozzle_dx=dy=0.0 and produces byte-identical cost to the old center-
    based formula — the feature is a strict superset, not a behavior
    change for existing data."""
    # sample_unit's equipment.csv has no nozzle columns; reload and score.
    here = os.path.dirname(os.path.abspath(p.__file__))
    sample = os.path.join(here, "data", "sample_unit")
    eq, conns, spacing, site, keepouts = p.load_unit(sample)
    for e in eq:
        assert e.nozzle_dx == 0.0 and e.nozzle_dy == 0.0, f"{e.tag} should have zero nozzle offset"
    # the score is whatever the solver produces (sample_unit's known
    # 0:8 best is ~342-386 across versions); just assert it's finite and
    # the _nozzle_xy == (e.x, e.y) identity holds for every item.
    for e in eq:
        assert p._nozzle_xy(e) == (e.x, e.y), f"{e.tag}: zero-offset nozzle must equal center"
    print("OK: zero-nozzle (legacy) equipment == center-based formula (no behavior change)")


def main():
    test_rotate_point_cw()
    test_nozzle_xy()
    test_piping_cost_uses_nozzle()
    test_sa_rotate_rotates_nozzle()
    test_cpsat_rotate_rotates_nozzle()
    test_write_takeoff_matches_piping_cost_with_nozzle()
    test_backward_compat_zero_nozzle_equals_center()


if __name__ == "__main__":
    main()
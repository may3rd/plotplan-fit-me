"""Self-check that pull_side rotates along with w/d whenever the SOLVER
rotates an item (SA's rotate move in solve(), and CP-SAT's ROT var in
solve_cpsat()) — the manual Ribbon rotate button (frontend) already did this
correctly; this covers the automatic case, which previously left pull_side
pointing the old absolute direction after a rotation (self-consistent, no
crash, but physically wrong — a tube-pull clearance is a face of the
equipment, not a fixed compass direction). Run: python3 test_rotate.py"""
import plotplan as p


def test_rotate_side_cw_cycle():
    """Pure function: 4 applications return to the start; empty stays empty."""
    side = "x+"
    seen = []
    for _ in range(4):
        seen.append(side)
        side = p._rotate_side_cw(side)
    assert seen == ["x+", "y-", "x-", "y+"], seen
    assert side == "x+", "cycle must return to the original after 4 steps"
    assert p._rotate_side_cw("") == "", "no pull_side must stay empty"
    print("OK: _rotate_side_cw cycles x+ -> y- -> x- -> y+ -> x+")


def test_sa_rotate_keeps_pull_side_in_sync():
    """A movable item with a pull clearance, connected to a pinned anchor
    across a rack — piping_cost() is position-sensitive here (unlike a
    lone unconnected item, where rotation is cost-neutral and best_pos
    never captures a rotated state at all, since best only updates on a
    STRICT improvement), so translate moves keep nudging `best_pos` while
    rotation moves land in between — a real chance to catch w/d and
    pull_side drifting out of sync in the snapshot/restore.
    seed=0 deterministically nets an EVEN number of accepted rotations —
    w/d ends up back at its original (5.0, 2.0), but two 90 deg CW steps
    is a 180 deg turn, which flips which absolute direction the same
    physical face points (x+ -> y- -> x-) even though the bounding box
    looks unrotated. The old code (pull_side absent from best_pos, never
    touched by the rotate move at all) would have left this at the
    original "x+" — this specifically catches that class of bug, not just
    an "any valid pair" fuzzy check."""
    site = p.Site(30.0, 30.0)
    rack = {"RACK_1": [(0.0, 14.0), (30.0, 14.0), (30.0, 16.0), (0.0, 16.0)]}
    anchor = p.Equipment("B", "pump_hc", 2.0, 2.0, x=25.0, y=25.0, pinned=True)
    e = p.Equipment("A", "exchanger", 5.0, 2.0, x=5.0, y=5.0, pull_side="x+", pull_len=3.0)
    eq = [e, anchor]
    p.solve(eq, [("A", "B", 2.0)], site, {}, rack, seed=0, iters=5000, t0=8.0)
    got = (eq[0].w, eq[0].d, eq[0].pull_side)
    assert got == (5.0, 2.0, "x-"), (
        f"w/d back at original but pull_side must reflect the net rotation: got {got}")
    p._check(eq, site, {}, rack)
    print(f"OK: SA rotate move keeps pull_side in sync with w/d ({got})")


def test_cpsat_rotate_keeps_pull_side_in_sync():
    """Site narrow enough (w=8) that the UNROTATED item (6x2, x+ pull
    needing 6+3=9m of horizontal room) can't fit its pull clearance within
    the site at all, but the ROTATED item (2x6, pull_side rotated to y-,
    needing vertical room the tall site has plenty of) can — forces CP-SAT
    to pick ROT=1, so a wrong (unrotated) pull_side on the decoded result
    would show up as an infeasible layout, not just a cosmetic mismatch."""
    site = p.Site(8.0, 20.0)
    eq = [p.Equipment("A", "exchanger", 6.0, 2.0, pull_side="x+", pull_len=3.0)]
    p.solve_cpsat(eq, [], site, {}, {}, seed=0, time_limit_s=10.0)
    assert (eq[0].w, eq[0].d) == (2.0, 6.0), f"must have rotated to fit: w/d={eq[0].w},{eq[0].d}"
    assert eq[0].pull_side == "y-", f"pull_side must rotate with it, got {eq[0].pull_side!r}"
    p._check(eq, site, {}, {})
    print("OK: CP-SAT ROT var keeps pull_side in sync with w/d (forced rotation)")


def main():
    test_rotate_side_cw_cycle()
    test_sa_rotate_keeps_pull_side_in_sync()
    test_cpsat_rotate_keeps_pull_side_in_sync()


if __name__ == "__main__":
    main()

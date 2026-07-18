"""Self-check for POST /api/relax (PLAN.md items 16-17): calls the endpoint
function directly (no HTTP layer, no test-only dependency needed for it).
Uses hand-built, deterministic layouts rather than ones produced by
solve_one() — relax() only ever calls solve()/warm_start directly, never
solve_cpsat(), so there's no reason to route this test through CP-SAT's
own (documented, non-deterministic-across-runs) parallel search just to
get a starting layout. Run: python3 test_relax.py"""
import api
import plotplan as p

SPACING = [{"a": "vessel", "b": "vessel", "gap": 3.0}]


def _grid_case(n_cols=6, n_rows=5, item=3.0, pitch=7.0, margin=5.0, clear=15.0):
    """n_cols x n_rows grid of `item`x`item` vessels, `pitch` apart center
    to center (edge gap = pitch - item, comfortably above SPACING's 3.0m
    minimum at the pitch=7.0/item=3.0 defaults). Site extends `clear`
    meters past the grid's far edge — comfortably more than `item` + the
    3.0m spacing minimum — so a drag into that margin is unambiguously
    open space, not just visually past the last item's center."""
    equipment = []
    for row in range(n_rows):
        for col in range(n_cols):
            equipment.append({
                "tag": f"V-{row}-{col}", "cls": "vessel", "w": item, "d": item,
                "x": margin + item / 2 + col * pitch, "y": margin + item / 2 + row * pitch,
            })
    grid_max_x = margin + item / 2 + (n_cols - 1) * pitch + item / 2  # right edge of the last column
    grid_max_y = margin + item / 2 + (n_rows - 1) * pitch + item / 2  # top edge of the last row
    site = {"w": grid_max_x + clear + item, "d": grid_max_y + clear + item, "wind_dir": ""}
    return {"name": "grid", "equipment": equipment, "connections": [],
            "site": site, "keepouts": {}, "spacing": SPACING,
            "_grid_max": (grid_max_x, grid_max_y)}  # test-only: not a CaseData field


def test_open_space_drag():
    """Dragging to open space beyond the grid reflows the rest of the
    layout and stays within the round-trip time target (<200ms at N=30)."""
    import time
    case = _grid_case()
    grid_max_x, grid_max_y = case.pop("_grid_max")
    dragged_tag = case["equipment"][0]["tag"]
    new_x, new_y = grid_max_x + 10.0, grid_max_y + 10.0  # 10m past the grid's far edge

    eq0, conns0, spacing0, site0, keepouts0 = api._build_case(api.CaseData(**case))
    trial = p.Equipment(dragged_tag, "vessel", 3.0, 3.0, new_x, new_y, True)
    assert p.feasible([e for e in eq0 if e.tag != dragged_tag] + [trial], site0, spacing0, keepouts0), \
        "test setup problem: chosen drag target isn't actually open space"

    req = api.RelaxRequest(data=api.CaseData(**case), tag=dragged_tag, x=new_x, y=new_y)
    t0 = time.time()
    result = api.relax(req)
    dt_ms = (time.time() - t0) * 1000

    assert result["feasible"], f"relax reported infeasible for an open-space drag: {result}"
    by_tag = {e["tag"]: e for e in result["equipment"]}
    assert (by_tag[dragged_tag]["x"], by_tag[dragged_tag]["y"]) == (new_x, new_y), \
        "dragged item must land exactly at the requested position"
    eq, conns, spacing, site_obj, keepouts = api._build_case(api.CaseData(**case))
    out_eq = [p.Equipment(**e) for e in result["equipment"]]
    p._check(out_eq, site_obj, spacing, keepouts)
    assert dt_ms < 1000, f"round trip {dt_ms:.0f}ms — investigate before trusting the 200ms/N=30 target"
    print(f"OK: open-space drag reflowed and passed _check() in {dt_ms:.0f}ms at N={len(case['equipment'])}")


def test_packed_row_drag_legalizes():
    """PLAN.md item 17: dropping onto (deeply overlapping, not just too
    close to) a packed-row neighbor must be legalized by push_repair
    shoving that neighbor aside, not just reported as a flat failure.
    R-1 sits between R-0 and R-2 along x (a real packed row), so the
    escape route push_repair should find is perpendicular — nudge R-1 out
    of the row along y, into the open space above/below it, rather than
    sideways into a third item (the greedy single-axis heuristic doesn't
    plan multi-item cascades; the drag offset here is along y precisely so
    the minimum-push axis it picks is the unobstructed one)."""
    site = {"w": 60.0, "d": 20.0, "wind_dir": ""}
    equipment = [
        {"tag": "R-0", "cls": "vessel", "w": 4, "d": 4, "x": 5, "y": 10},
        {"tag": "R-1", "cls": "vessel", "w": 4, "d": 4, "x": 13, "y": 10},
        {"tag": "R-2", "cls": "vessel", "w": 4, "d": 4, "x": 21, "y": 10},
        {"tag": "DRAG", "cls": "vessel", "w": 4, "d": 4, "x": 45, "y": 10},
    ]
    case = {"name": "packed_row", "equipment": equipment, "connections": [],
            "site": site, "keepouts": {}, "spacing": SPACING}
    # drop DRAG almost exactly on R-1 (0.5m off in y only — deep overlap,
    # not exactly concentric, and offset along the axis with open room)
    req = api.RelaxRequest(data=api.CaseData(**case), tag="DRAG", x=13.0, y=10.5)
    result = api.relax(req)
    assert result["feasible"], f"push_repair should have legalized this packed-row drop: {result}"
    eq, conns, spacing, site_obj, keepouts = api._build_case(api.CaseData(**case))
    out_eq = [p.Equipment(**e) for e in result["equipment"]]
    p._check(out_eq, site_obj, spacing, keepouts)
    by_tag = {e.tag: e for e in out_eq}
    assert (by_tag["DRAG"].x, by_tag["DRAG"].y) == (13.0, 10.5), \
        "dragged item must still land exactly at the requested cursor position"
    print("OK: packed-row drop legalized by push_repair and passed _check()")


def test_concentric_drop_legalized():
    """Dropping exactly on top of another item's center — e.g. every
    unpinned item in a never-solved project defaults to (0, 0), so this is
    a common starting state, not a rare one — used to be an unresolvable
    dead end (no push direction is defined for two exactly-concentric
    rectangles). push_repair now defaults to an arbitrary-but-deterministic
    direction for that case instead of giving up outright, so this must
    legalize like any other packed drop."""
    case = _grid_case(n_cols=2, n_rows=1)
    case.pop("_grid_max")
    v0, v1 = case["equipment"]
    req = api.RelaxRequest(data=api.CaseData(**case), tag=v0["tag"], x=v1["x"], y=v1["y"])
    result = api.relax(req)
    assert result["feasible"], f"concentric drop should now legalize via push_repair: {result}"
    eq, conns, spacing, site, keepouts = api._build_case(api.CaseData(**case))
    out_eq = [p.Equipment(**e) for e in result["equipment"]]
    p._check(out_eq, site, spacing, keepouts)
    print("OK: concentric drop legalized by push_repair's arbitrary-direction tie-break")


def test_impossible_site_reported_infeasible():
    """A site too small for two items to be separated at all, no matter
    the direction — push_repair must still come back honestly as
    {feasible: False} rather than raising, looping forever, or fabricating
    a bogus success."""
    spacing = [{"a": "vessel", "b": "vessel", "gap": 3.0}]
    # 6x6 vessels need a center-to-center distance >= 3+3+3=9m to clear the
    # gap on any single axis; a 10m site only allows center range [3,7], a
    # spread of 4m — nowhere near enough room in either axis.
    equipment = [
        {"tag": "A", "cls": "vessel", "w": 6, "d": 6, "x": 5, "y": 5},
        {"tag": "B", "cls": "vessel", "w": 6, "d": 6, "x": 5, "y": 5, "pinned": True},
    ]
    case = {"name": "impossible", "equipment": equipment, "connections": [],
            "site": {"w": 10.0, "d": 10.0, "wind_dir": ""}, "keepouts": {}, "spacing": spacing}
    req = api.RelaxRequest(data=api.CaseData(**case), tag="A", x=5.0, y=5.0)
    result = api.relax(req)
    assert result["feasible"] is False and result["cost"] is None, \
        f"expected an honest infeasible report, got: {result}"
    print("OK: genuinely impossible site reported infeasible honestly (no exception, no fake success)")


if __name__ == "__main__":
    test_open_space_drag()
    test_packed_row_drag_legalizes()
    test_concentric_drop_legalized()
    test_impossible_site_reported_infeasible()

"""Self-check for POST /api/relax (PLAN.md item 16): calls the endpoint
function directly (no HTTP layer, no test-only dependency needed for it).
Uses a hand-built, deterministic layout rather than one produced by
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


def test_infeasible_drop_reported_honestly():
    """Dropping directly on top of another item is infeasible (item 16
    alone has no push-repair yet — that's item 17) — must come back as a
    clean {feasible: False}, not raise."""
    case = _grid_case(n_cols=2, n_rows=1)
    case.pop("_grid_max")
    v0, v1 = case["equipment"]
    req = api.RelaxRequest(data=api.CaseData(**case), tag=v0["tag"], x=v1["x"], y=v1["y"])
    result = api.relax(req)
    assert result["feasible"] is False and result["cost"] is None, \
        f"expected an honest infeasible report, got: {result}"
    print("OK: infeasible drop reported honestly (no exception, no fake success)")


if __name__ == "__main__":
    test_open_space_drag()
    test_infeasible_drop_reported_honestly()

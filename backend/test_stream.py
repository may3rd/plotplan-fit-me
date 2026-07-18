"""Self-check for PLAN.md item 18 (anytime on_improve/should_stop): exercises
solve()'s new callback contract directly — the FastAPI/SSE wiring in
api.py's /api/solve is thin plumbing on top of these (see its docstring),
not independently testable without a live HTTP client. Run: python3 test_stream.py"""
import os
import random

import plotplan as p

DATA_DIR = os.path.join(os.path.dirname(p.__file__), "data", "sample_unit")


def test_on_improve_matches_final_best():
    """Every on_improve call reports a monotonically-improving cost, and
    the last one called matches the value solve() actually returns."""
    eq, conns, spacing, site, keepouts = p.load_unit(DATA_DIR)
    calls = []

    def on_improve(cost, positions, k):
        calls.append((cost, positions, k))

    best = p.solve(eq, conns, site, spacing, keepouts, seed=0, on_improve=on_improve)

    assert calls, "on_improve should fire at least once over a full anneal"
    costs = [c for c, _, _ in calls]
    assert costs == sorted(costs, reverse=True), f"on_improve costs must be non-increasing: {costs}"
    assert costs[-1] == best, f"last on_improve cost {costs[-1]} != returned best {best}"
    last_positions = calls[-1][1]
    assert {t for t, *_ in last_positions} == {e.tag for e in eq}, \
        "on_improve positions must cover every equipment tag"
    print(f"OK: on_improve fired {len(calls)} times, monotonically improving to {best:.0f}")


def test_should_stop_returns_feasible_layout():
    """Stopping before a single move is tried still returns the (feasible)
    layout random_place() produced — should_stop is checked before
    anything else in the loop body, so no move ever gets a chance to run."""
    eq_ref, conns_ref, spacing_ref, site_ref, keepouts_ref = p.load_unit(DATA_DIR)
    assert p.random_place(eq_ref, site_ref, spacing_ref, random.Random(0), keepouts_ref), \
        "test setup: random_place should succeed on sample_unit with seed 0"
    starting_cost = p.piping_cost(eq_ref, conns_ref, site_ref, keepouts_ref)

    eq, conns, spacing, site, keepouts = p.load_unit(DATA_DIR)
    stopped_cost = p.solve(eq, conns, site, spacing, keepouts, seed=0, should_stop=lambda: True)
    assert stopped_cost == starting_cost, \
        f"stopping immediately should return random_place()'s untouched cost, got {stopped_cost} vs {starting_cost}"
    p._check(eq, site, spacing, keepouts)
    print(f"OK: should_stop()=True halts before any move; layout stays feasible at cost {stopped_cost:.0f}")


def test_callbacks_dont_change_the_outcome():
    """Passing on_improve/should_stop (with should_stop always False) must
    not perturb the anneal itself — same seed, same final cost, byte-
    identical positions, with or without callbacks attached."""
    eq_a, conns_a, spacing_a, site_a, keepouts_a = p.load_unit(DATA_DIR)
    cost_a = p.solve(eq_a, conns_a, site_a, spacing_a, keepouts_a, seed=3)

    eq_b, conns_b, spacing_b, site_b, keepouts_b = p.load_unit(DATA_DIR)
    cost_b = p.solve(eq_b, conns_b, site_b, spacing_b, keepouts_b, seed=3,
                      on_improve=lambda *a: None, should_stop=lambda: False)

    assert cost_a == cost_b, f"callbacks changed the outcome: {cost_a} vs {cost_b}"
    pos_a = [(e.tag, e.x, e.y, e.w, e.d) for e in eq_a]
    pos_b = [(e.tag, e.x, e.y, e.w, e.d) for e in eq_b]
    assert pos_a == pos_b, "callbacks changed the resulting layout"
    print(f"OK: on_improve/should_stop attached vs. not attached give identical results (cost={cost_a:.0f})")


if __name__ == "__main__":
    test_on_improve_matches_final_best()
    test_should_stop_returns_feasible_layout()
    test_callbacks_dont_change_the_outcome()

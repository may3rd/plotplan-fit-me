# plotplan-fit-me — implementation plan

Build order, one item at a time. Reordered from the README roadmap by
value-over-effort and dependency, not by original numbering. Principle:
get it usable on real data first, then cheap constraints, then structural
work, then heavy stuff last.

**Backend-first.** All items below are `backend/` (Python/CLI) work. The
`frontend/` folder is a placeholder — item 10 is the only item that touches
it, and even item 10 only starts when explicitly asked, not automatically
when its turn comes up.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done

## Order

1. `[x]` **CSV import** — equipment.csv / connections.csv / spacing.csv /
   site.csv loaded via `load_unit(data_dir)`. Sample unit (the original demo
   data) lives at `backend/data/sample_unit/`. CLI: `python plotplan.py
   [data_dir] [seed]`, defaults to sample_unit. `DEFAULT_SPACING` kept as a
   fallback constant for callers that don't pass a table. Verified
   byte-for-byte same scores as the old hardcoded `demo()` (324 @ seed 0,
   361 @ seed 7).
2. `[x]` **Multi-seed ranking** — `run(data_dir, seeds)` takes a list of
   seeds, reloads a fresh equipment copy per seed (solve() mutates in
   place), prints a `seed / score` table sorted ascending with a `<- best`
   marker, and writes only the best layout to DXF. CLI: single seed
   (`python plotplan.py 7`) still runs once exactly as before; a range
   (`python plotplan.py 0:8`) ranks across those seeds. `data_dir` and the
   seed/range arg can be given in either order. Verified against the old
   per-seed scores (unchanged) and confirmed seed 3 beats seed 0 across
   0:8 on the sample unit (320 vs 324).
3. `[x]` **Pinned equipment** — `Equipment.pinned: bool` (default False) +
   optional `x,y,pinned` columns in equipment.csv. Pinned items are excluded
   from `random_place` and from SA move selection in `solve()`; a pre-check
   raises a clear error if pinned items conflict with each other or the site
   before wasting solver tries. `sample_unit` now pins H-101 at (15, 15) as
   the live example. Self-check extended in `_check()`: asserts every pinned
   item's position is byte-identical before/after `solve()`. Verified: H-101
   stayed at (15.0, 15.0) across seeds 0-7 while the rest of the unit solved
   around it; confirmed old 4-column equipment.csv files (no x/y/pinned at
   all) still load with pinned=False; confirmed two pinned items placed on
   top of each other raise the pre-check error instead of exhausting
   `random_place`'s 20000 tries.
4. `[x]` **Polygon keep-outs** — optional `keepouts.csv` (`zone,x,y` rows,
   grouped by zone into ordered vertex lists), loaded by `load_unit()` as a
   5th return value (empty dict if the file doesn't exist — fully backward
   compatible). `feasible()` rejects any equipment whose footprint overlaps
   a zone, checked via `_rect_hits_poly()`: 4 corners + center sampled
   against the polygon (ray casting), plus the polygon's own vertices
   sampled against the rect — catches convex zones and axis-aligned
   rectangles (flare radius, blast contours, underground, drainage); a thin
   diagonal edge slicing through without crossing a sample point is the
   documented ceiling (upgrade path: full polygon-rect clipping). Threaded
   through `random_place`/`solve`/`_check`/`run`. `sample_unit` now has an
   `UNDERGROUND` rectangle keep-out (60-75, 10-25) as the live example.
   Self-check extended: asserts no equipment overlaps any keepout zone.
   Verified: solver routes around the zone across seeds 0-7 (scores rose
   from 320-361 to 337-408 range as expected, more constrained); pinning
   equipment directly on top of a keepout zone correctly raises the
   pre-check error instead of burning through solver tries; a data dir with
   no keepouts.csv still runs unchanged.
5. `[x]` **Roads / maintenance corridors + tube-pull clearance** — roads and
   maintenance corridors turned out to need zero new mechanism: they're just
   more `keepouts.csv` zones, distinguished only by a naming convention
   (`ROAD*` / `MAINT*` prefix → drawn on a `ROADS`/`MAINT` DXF layer instead
   of generic `KEEPOUT`). `sample_unit/keepouts.csv` now also has a
   `ROAD_main` strip along the north edge. Tube-pull clearance *is* new:
   `Equipment.pull_side` (`"x+"/"x-"/"y+"/"y-"`) + `pull_len`, optional CSV
   columns, default `""`/`0.0` (no clearance). `_pull_rect()` computes the
   swept rectangle attached to one footprint side; `feasible()` requires it
   stay inside the site, clear of the rack corridor, clear of every keepout
   zone, and non-overlapping with every other equipment's footprint (zero
   overlap, not spacing-margined — it's swept space, not a machine).
   `sample_unit` gives E-102 a 6m `x+` pull clearance as the live example.
   Also: keep-out zones and pull rectangles are now actually drawn in the
   DXF (`KEEPOUT`/`ROADS`/`MAINT`/`PULL` layers) — previously zones existed
   only in the feasibility check, invisible in the output. Verified: all
   constraint types (pinned + underground zone + road zone + pull
   clearance) hold simultaneously across seeds 0-7; pinning equipment inside
   another's pull-swept path correctly raises the pre-check error; DXF
   confirmed to contain all new layers; old equipment.csv files with no
   pull_side/pull_len columns still load with no clearance defined.
6. `[x]` **Quantity takeoff CSV** — `write_takeoff()` writes
   `plotplan_takeoff.csv`: one `pipe` row per connection (a, b, weight,
   rack-routed length in meters), plus `rack_span_used` (max_x - min_x
   across equipment — the actual rack length needed, not the full site
   width) and `total_pipe_length_m`. Pure reporting, no solver change.
   `run()` now unpacks `conns` alongside the rest for the winning seed and
   writes the takeoff file next to the DXF. Self-check: asserts
   `piping_cost(best_eq, best_conns, best_site) == best_cost` before writing
   anything — catches the takeoff's length formula drifting out of sync
   with the actual scoring formula, since they're intentionally two
   separate lines of arithmetic rather than a shared helper. Verified:
   manual sum of weight×length across all pipe rows matches the printed
   score (331 on sample_unit seed 2); single-seed and legacy (no
   pins/keepouts) data dirs both produce correct takeoff files.
7. `[x]` **Equipment rotation** — SA's move step now picks a 90° rotation
   (swap `w`/`d` in place) 20% of the time instead of a translation, with the
   same accept/reject/revert logic either way — `feasible()` already reads
   `w`/`d` for bounds/gap/keepout/pull checks, so no other change was needed.
   `best_pos` snapshots grew from `(x, y)` to `(x, y, w, d)` since the best
   layout can now have items rotated. Verified: `_check()` (feasible, gaps,
   keepouts, pull clearance, pinned-position) passes across seeds 0-7 on
   sample_unit with no changes to `_check()` itself; pinned equipment never
   rotates (excluded from `movable`, same as translation).
8. `[x]` **Multiple racks** — `Site.rack_y`/`rack_half` became
   `Site.racks: list[(rack_y, rack_half)]`; `site.csv` uses the same
   "grouped rows" convention as `keepouts.csv` (one row per rack, `w`/`d`
   only read from the first row) — a single-row file behaves exactly as
   before. `feasible()` now rejects encroachment on *any* rack's corridor
   (footprint and pull-clearance checks both loop over `site.racks`).
   `piping_cost()` routes each connection via whichever rack minimizes
   rise+drop (the run-along-x term is rack-independent, so it doesn't
   affect the choice) and adds `RACK_STEEL_COST_PER_M ×` the physical span
   of every rack actually used by >=1 connection — more racks isn't free,
   the solver pays for the steel. `write_takeoff()` keeps its own
   independent nearest-rack/length arithmetic (per item 6's
   deliberate-divergence design) and now writes one `rack_span_used` row
   per rack actually used, labeled `y=<rack_y>`, instead of a single
   whole-site row. `sample_unit/site.csv` now has two racks (y=30, y=70;
   site `d` bumped 60->80 for room) as the live example. Verified: manual
   `piping_cost()` calls against hand-built two-rack sites confirm correct
   nearest-rack selection and steel-span costing (tie case, asymmetric
   case); `_check()` passes across seeds 0-8 on the updated sample_unit
   with both rack corridors enforced simultaneously alongside existing
   pinned/keepout/pull constraints.
9. `[x]` **Prevailing wind constraint** — `Site` gained `wind_dir: str = ""`
   (`"x+"/"x-"/"y+"/"y-"`, the side the wind blows *from*, same read-only-
   first-row convention as `w`/`d`/racks). Reused the `_pull_rect` direction
   dict rather than duplicating it: factored out `_side_rect(x1, y1, x2, y2,
   side, length)`, and both `_pull_rect()` (per-item `pull_side`/`pull_len`)
   and the new `_wind_rect()` (fixed `WIND_CLEARANCE_M`, only for
   `cls == "fired_heater"`) call it. `feasible()`/`_check()` reject/flag any
   other equipment footprint overlapping a heater's upwind rectangle — same
   shape of check as the pull-clearance one, no new pattern. DXF gained a
   `WIND` layer. `sample_unit/site.csv` now sets `wind_dir=x+` on H-101's
   rack row as the live example. Verified: hand-built two-item feasibility
   test confirms an item placed inside the upwind sector is rejected and
   the same item placed elsewhere is accepted; `_check()` (including the
   new wind assertion) passes across seeds 0-8 on sample_unit alongside all
   prior constraints (pins, keepouts, multiple racks, pull clearance).
10. `[x]` **Web UI** — started explicitly by the user ahead of the as-built
    validation checkpoint (the gate was "run the CLI against a real unit
    *and* be explicitly asked" — the user chose to skip straight to this
    when asked which gated item to unblock). `backend/api.py`: stateless
    FastAPI app, no database — a unit is always read fresh off its
    `data/<name>/` CSVs via the existing `load_unit()`. `run()`'s
    seed-ranking loop was refactored into `solve_ranked(data_dir, seeds) ->
    (results, best)` (pure, no file writes) so the API could reuse the
    exact same ranking/pinned-precheck/self-check logic instead of
    duplicating that loop — `run()` now just calls `solve_ranked()` then
    does its own printing/DXF/takeoff writing. Three endpoints: `GET
    /api/units` (list data dirs), `GET /api/units/{name}` (equipment/
    connections/site/keepouts as JSON), `POST /api/units/{name}/solve`
    (runs `solve_ranked`, returns the winning layout), `POST
    /api/units/{name}/score` (overlays caller-supplied x/y onto the loaded
    equipment, returns `{feasible, cost}` — used for live drag feedback,
    returns `cost: null` when infeasible since `piping_cost()` doesn't mean
    anything for an infeasible layout). `frontend/`: Vite + React, no state
    library, no UI kit, no canvas/chart dependency — one component, plain
    SVG for the plot (site/racks/keepouts/connections/equipment, north-up
    via a y-flip), native `fetch`, Vite dev-server proxy for `/api`.
    Dragging a non-pinned item posts to `/score` on every move for live
    feedback; pinned equipment (dashed outline) ignores drag. Solve button
    calls `/solve` with the same seed/`a:b`-range syntax as the CLI.
    Verified in-browser: unit loads and renders correctly (site, 2 rack
    corridors, keep-out zone, all 8 equipment); Solve reproduces the CLI's
    exact score (394 for seeds `0:8` on sample_unit); dragging an item into
    a rack corridor, then a keep-out zone, then a fired-heater wind sector
    each correctly flip the header to "infeasible layout" live, and
    dragging to open space recovers a score; H-101 (pinned) doesn't move on
    drag attempts. Not built: editing/saving CSVs from the UI, exporting
    DXF/takeoff from the browser, or per-violation detail beyond the single
    feasible/infeasible flag — see `frontend/README.md`'s "not built"
    section.
11. `[x]` **CP-SAT / MILP solver** — OR-Tools, swapped in only if simulated
    annealing stalls on >30 equipment items. The gate was measured true
    first (see CLAUDE.md self-learning): `random_place()`'s scatter-then-
    reject init starts failing outright above ~27-30 movable items even on
    a generously oversized site. `solve_cpsat()` in `backend/plotplan.py`
    builds a feasible layout by constraint construction on a 0.5 m grid
    instead — same feasibility rules as `feasible()`/`_check()` (site
    bounds, rack corridors, keep-out zones as their bounding box, pairwise
    class spacing, tube-pull clearance, prevailing wind, pinned equipment),
    every safety-relevant conversion rounded in the conservative direction
    so a grid-feasible solution decoded back to real meters is always
    real-feasible. `solve_ranked()` now dispatches to it automatically once
    movable count exceeds `CPSAT_THRESHOLD` (30) — no new CLI flag, no
    change needed in `backend/api.py`. (Superseded by item 14:
    `CPSAT_THRESHOLD` was retired for `CPSAT_SEED_THRESHOLD`, and the hard
    switch below became a CP-SAT-seed-then-SA-refine pipeline — see that
    item for the current dispatch logic.) Objective optimizes pipe rise+run+
    drop (not the rack-steel-span term — see the ponytail note in
    `solve_cpsat()`); the returned score is still the true, complete
    `piping_cost()`. Verified: reproduces SA's exact score (5310) on a site
    SA could still solve; solves a tight 35-item site across 8 seeds that
    previously crashed SA outright, `_check()` passing on all of them; a
    combined-constraint unit (pinned heater, keepout zone, pull clearance,
    wind, two racks, 35 items) passes `_check()` including the pinned
    item's exact-position invariant. `backend/test_cpsat.py` is the
    self-check (no fixtures — the unit is synthetic and built in-memory).
    *Effort: L.*

12. `[x]` **Delta feasibility check** — `_move_feasible()`
    (`backend/plotplan.py:314-376`) checks only the moved/rotated item:
    bounds, footprint vs every zone, pairwise gaps vs the other N-1 items,
    pull rect vs others and others' pull rects vs it, wind rects both
    directions. O(N) per move instead of `feasible()`'s full O(N²)
    re-check. `solve()`'s SA loop calls it at `plotplan.py:431`; full
    `feasible()` stays for init, pinned pre-check, and `_check()`. Landed
    as part of item 18's SSE work (commit e86b41a) — needed to make a
    per-iteration progress callback cheap enough to fire ~100 times per
    run without a full O(N²) recheck each time. No separate action needed;
    listed here only to keep this plan's numbering aligned with the
    upgrade doc it came from.
13. `[x]` **Move set: swap + relocate** — `solve()`'s move step now picks
    one of four moves per iteration (60% translate, 20% rotate, 10% swap,
    10% relocate) instead of just translate/rotate. `swap` exchanges the
    centers of two random movable items; `relocate` jumps one item to a
    uniform random in-bounds position. Both reuse `_move_feasible()`
    (called once per touched item against the fully post-move layout,
    which covers every pair a move could have broken, swap included) and
    a per-branch `undo` closure, sharing one accept/reject block across
    all four move kinds instead of duplicating revert logic per move type.
    Verified: sample_unit seeds 0:20 best score improved 378 → 343 (swap
    lets the solver reorder items a packed row's Gaussian steps couldn't);
    `test_cpsat.py` and `test_dxf_merge.py` still pass unchanged (CP-SAT
    path doesn't touch `solve()`'s move step).
14. `[x]` **CP-SAT seed → SA refine pipeline** — new `solve_one()` is now
    the single place that decides how to solve one seed: plain SA below
    `CPSAT_SEED_THRESHOLD` (15) movable items (with a fallback to the
    CP-SAT path if `random_place()` still fails there), else
    `solve_cpsat()` builds a feasible initial layout by construction and
    `solve(..., warm_start=True)` anneals from it — `solve()` gained a
    `warm_start` param that skips `random_place()` and instead asserts the
    supplied layout is already feasible. Replaces item 11's hard switch
    (SA-only vs. CP-SAT-only) with a pipeline so large layouts get
    continuous refinement (translate/rotate/swap/relocate) and the
    rack-steel-span cost term CP-SAT's objective doesn't model. Old
    `CPSAT_THRESHOLD` (30) retired in favor of `CPSAT_SEED_THRESHOLD` (15,
    lower on purpose — CP-SAT+refine beats SA-alone before SA's init
    actually starts failing). `solve_ranked()` (CLI) and `api.py`'s
    `/api/solve` worker both call `solve_one()` now instead of each
    re-implementing the same dispatch decision — that duplication existed
    only because `api.py` needed a progress callback `solve_ranked()`
    didn't expose; `solve_one()` takes `on_progress` too (wired to the SA
    phase only — see its docstring on why not the CP-SAT phase). Verified:
    extended `test_cpsat.py` compares `solve_one()` vs. CP-SAT-only cost
    on the existing 32-item synthetic unit across seeds 0-3 — pipeline
    matches or beats CP-SAT-only on every seed; `test_dxf_merge.py` and
    sample_unit CLI (seeds 0:8) unaffected (8 items, well under threshold).
15. `[x]` **Parallel seed ranking** — `solve_ranked()`'s per-seed loop body
    pulled out to a top-level `_solve_ranked_one(data_dir, seed)` (had to be
    top-level, not a closure, for `multiprocessing` to pickle it to a
    worker) and run across a stdlib `multiprocessing.Pool` sized
    `min(len(seeds), os.cpu_count())` — each worker reloads the unit fresh
    from `data_dir` via `load_unit()`, same as the old sequential loop, so
    no shared-state issues. A single seed skips the Pool entirely (no
    process-spawn cost for the common single-seed API-style call). Note:
    `api.py`'s `POST /api/solve` already runs the solve in a background
    `threading.Thread` to bridge into SSE — that's for async I/O, not CPU
    parallelism, and stayed sequential since per-seed progress fractions
    are attributed assuming seeds run in order. Verified: a scratch script
    comparing `solve_ranked()`'s parallel path against calling
    `_solve_ranked_one()` sequentially for the same seeds (sample_unit
    0:8) — identical per-seed costs, 9.30s sequential vs. 1.88s parallel
    (4.94x). `test_dxf_merge.py`, `test_cpsat.py`, and the CLI's own
    seeds-0:8 run all unaffected (344 @ seed 1, matching item 14's run).
16. `[x]` **Warm-start incremental solve (`POST /api/relax`)** — new
    endpoint, the core of real-time drag-to-reflow. Request body:
    `{data: CaseData, tag, x, y, iters=3000, t0=3.0}` — full current layout,
    the dragged tag, and its new (cursor) position. Server pins that item
    at `(x, y)` for this call only (a fresh in-memory `Equipment` copy each
    request, nothing written back), then — if the pinned position is
    already feasible against everyone else — runs a short, cool SA
    (`solve(..., warm_start=True)`, item 14's `warm_start` param) starting
    every other item from its *current* position (no `random_place`), so a
    drag reads as a live nudge instead of a fresh solve. If the pinned
    position is already infeasible, returns `{feasible: false, cost: null}`
    with positions unchanged rather than raising — item 17 adds a
    push-repair pass for that case instead of just reporting failure.
    Verified in `backend/test_relax.py`: a hand-built 30-item grid (deterministic
    — no `solve_one()`/CP-SAT in the test setup, since `relax()` only ever
    calls `solve()` directly and CP-SAT's parallel search is documented
    non-deterministic run to run, which an earlier draft of this test
    learned the hard way) — dragging the corner item 10m clear of the grid
    round-trips in ~70ms (well under the 200ms/N=30 target) and the rest of
    the layout reflows and passes `_check()`; a 2-item case dragged directly
    onto the other equipment returns `{feasible: False, cost: None}`
    cleanly, no exception. Frontend wiring (`PlotCanvas.jsx`/`App.jsx`) —
    a Home ribbon "Real-time" toggle, throttled ~100ms `/relax` calls
    during drag, flush-on-drop — landed afterward at explicit user request;
    off by default. Verified in-browser: toggling on and dragging one item
    reflows a second, non-dragged item elsewhere (confirmed via network
    log); toggling off fires zero `/relax` calls on a subsequent drag.
17. `[x]` **Push-repair before relax** — new `push_repair(eq, site,
    spacing, keepouts, cap=50)` in `plotplan.py`: loop up to `cap` times,
    find every pairwise spacing violation with at least one movable side,
    worst first; for each, try both of `_axis_push_candidates()`'s
    single-axis translations (clamped to site bounds) and keep whichever
    leaves the *whole layout's* total deficit lower — falling through to
    the next-worst violation if the top one's best candidate makes no
    real progress — repeat; returns `True` once fully `feasible()`,
    `False` if every violation is stuck or the cap is hit. `api.py`'s
    `/api/relax` calls it when the freshly-pinned drag position is
    infeasible, before the item-16 SA refine. Pure stdlib geometry —
    reuses `edge_gap`/`min_gap`/`feasible`, not `_move_feasible`
    (considered it per the original plan text, but the loop's "are we
    done" question always has one unambiguous answer via a full
    `feasible()` scan at cheap item counts, so introducing an incremental
    per-move check would've added a real correctness trap — see
    `push_repair`'s docstring — for no benefit at this scale).
    Two real bugs caught and fixed during implementation (both found by
    testing against a genuinely common scenario — a never-solved unit,
    where every unpinned equipment.csv row with blank x/y defaults to
    exactly (0, 0), not a synthetic edge case): (1) `_push_vector()`'s
    first draft used the *needed excess* itself as the push distance,
    which silently undershoots by exactly the overlap depth whenever two
    footprints deeply overlap — fixed to push to the *target absolute
    center distance* (half-width-sum + needed excess) instead, and it
    also refused to pick any direction at all for two exactly-concentric
    items (5+ items literally stacked at the same point, as a fresh
    project's default state is) — fixed by defaulting to +x/+y rather
    than giving up, since a deterministic-but-arbitrary separating push is
    still better than none. (2) The original "always take the single
    cheapest-axis push" greedy design had a real local-minimum deadlock:
    the worst violation's only escape route can itself be clamped right
    back to where it started by a site/pinned-neighbor boundary (e.g. a
    vessel wedged between a pinned heater and the site edge) — a
    permanent no-op that got retried every remaining iteration while a
    *separate* stuck cluster elsewhere never got a turn. Fixed by
    evaluating both axis candidates against total layout deficit (not
    just the one pair) and falling through to the next-worst violation
    when the top one can't make progress, rather than fixating on it.
    Net effect: successfully separates several items that default to the
    exact same point (verified: 4 of 6 stacked items untangle cleanly
    before the remainder hits a genuine N-way tangle needing coordinated
    multi-item placement — beyond what a one-step-lookahead heuristic can
    solve; that's `solve()`'s job, not a quick nudge repair's). Verified
    in `test_relax.py`: a 3-item row with a 4th item dropped onto the
    middle one legalizes; a drop exactly concentric with another item
    (previously an unresolvable dead end) now also legalizes via the
    arbitrary-direction default; a site genuinely too small to separate
    two items on any axis still reports `{feasible: False}` honestly.
18. `[x]` **Anytime progress streaming** — `solve()`'s `on_progress(fraction)`
    replaced outright with two independent, decoupled params: `on_improve
    (best_cost, positions, k)`, fired every time (unthrottled — a true
    anytime stream, not a periodic heartbeat) SA accepts a new best —
    `positions` is a `(tag, x, y, w, d)` tuple snapshot, safe to hold onto
    after the call unlike the live `eq` objects, which keep mutating; and
    `should_stop()` (no args, checked every iteration, breaks the loop
    early on a truthy return). Both default `None` — zero behavior change
    for CLI callers. `solve_one()` threads both through to its SA call(s)
    only — CP-SAT's own construction (`solve_cpsat`) is a one-shot
    constraint solve, not an iterative anneal, so "new best"/"stop early"
    aren't meaningful mid-construction (matches item 14's existing
    on_progress-not-passed-to-CP-SAT precedent).
    `api.py`'s `POST /api/solve` now emits an `improve` SSE event (seed,
    iteration, cost, positions) alongside the existing per-seed-start
    `progress` event, and the stream loop is now `async`, polling its
    queue non-blockingly so it can also poll `request.is_disconnected()`
    each cycle — a closed connection (a future frontend Stop button, or
    just the client navigating away) sets a `threading.Event` that
    `should_stop` reads, so the background solve winds down instead of
    running to completion for a client that's gone.
    ponytail ceiling: a disconnect during CP-SAT's own construction phase
    (>`CPSAT_SEED_THRESHOLD` movable items) isn't interruptible until it
    reaches the SA phase — CP-SAT has no stop hook (same limitation
    `solve_cpsat`'s docstring already documents for progress). Fine for
    now since sample_unit-scale units (this item's verify target) never
    hit that path; upgrade CP-SAT's own call with a time-boxed retry loop
    checking `should_stop` between attempts if large-unit responsiveness
    ever matters.
     Verified in `backend/test_stream.py`: `on_improve` fires 100+ times
     on sample_unit with monotonically non-increasing costs, its last call
     matches `solve()`'s returned best; `should_stop=lambda: True` halts
     before any move runs and still returns `random_place()`'s (feasible)
     starting layout; attaching both callbacks with `should_stop` always
     `False` gives byte-identical costs/positions to not attaching them at
     all (same seed). Also smoke-tested the live endpoint directly (`curl`
     against a running `uvicorn`): a real 2-seed SSE stream on sample_unit
     produces `progress`/`improve`/`done` events and a final cost matching
     the CLI (344 @ seed 1); forcibly disconnecting mid-solve (`curl
     --max-time`, a 31-item unit) leaves the server responsive to
     subsequent requests immediately after, no hang or crash.
19. `[x]` **Nozzle / tie-in offsets** — optional `nozzle_dx,nozzle_dy`
    columns in equipment.csv (meters, in the item's local/un-rotated frame,
    relative to the center) name the physical point a pipe actually
    connects at. `piping_cost()`, `write_takeoff()`, and `solve_cpsat()`'s
    objective all route rise/run/drop from this tie-in point instead of the
    centroid — a strict superset of the old center-based formula (offset
    0,0 = center, so existing data is byte-for-byte unchanged). Rotation
    rotates the offset to match w/d/pull_side: a 90° CW rotate maps
    `(dx,dy) -> (dy,-dx)` (new `_rotate_point_cw`, mirroring the frontend's
    `rotatePointCW`), so a tie-in on the item's east face stays on its
    south face after one CW step. `solve()`'s SA rotate move,
    `solve_cpsat()`'s decode step, and the frontend's manual Ribbon
    rotate all apply it; `best_pos`/`on_improve`/SSE `improve` tuples all
    grew `(nozzle_dx, nozzle_dy)` to match. CP-SAT's objective builds the
    nozzle world x/y as a per-item linear expression conditioned on the
    item's `ROT` var (`OnlyEnforceIf rot`/`rot.Not()`), so search optimizes
    the true tie-in-to-tie-in route length, not a centroid approximation.
    The frontend draws connection lines nozzle-to-nozzle and renders a
    small `nozzle` marker on the canvas; the equipment edit dialog got two
    offset fields. Verified in `backend/test_nozzle.py`: the rotation
    cycle, the cost-measured-from-nozzle-vs-center difference, SA and
    CP-SAT both keep the nozzle in sync with a forced rotation,
    `write_takeoff` matches `piping_cost` with a nozzle, and legacy
    zero-nozzle equipment is byte-identical to the old center formula.
    *Effort: S.*

## Optional later (not scheduled)

- Penalty-based SA (accept infeasible states with a cost penalty) only if
  reject-infeasible + item 13 still stalls on very tight sites. Keep
  reject-infeasible as default: it is simpler and every intermediate
  layout stays presentable, which item 16/17 depend on.
- **Real-time move (item 16-17) UX needs improvement** — flagged 2026-07-18
  after the mechanism itself was verified working end-to-end (backend
  `/api/relax`, push_repair, and the frontend throttle/toggle all confirmed
  live). Specifics of what to improve not yet captured — ask before
  picking this up.
- ~~Solver-rotated equipment's `pull_side` staying stale~~ — done
  2026-07-18, see CLAUDE.md self-learning. Also fixed in passing: the
  frontend never applied a solve/relax response's `w`/`d`/`pull_side` back
  onto `data.equipment` at all (only `x`/`y`), so a rotated result would
  have silently rendered with the pre-solve shape.

## Non-goals (explicit, don't creep in)

3D, ML, terrain/cut-fill, detailed pipe routing (that's a routing tool, not a
plot plan tool), cost database integration. Also explicitly out: an
occupancy-grid flood-fill distance engine (Dijkstra/BFS per machine,
A*-per-pair) for material-handling-cost routing — an early upgrade proposal
suggested this, modeled on Besbes et al. (2021)'s generic facility-layout
formulation, but it solves a bottleneck this repo doesn't have.
`piping_cost()` is already an O(connections) analytic rack-routing formula
(rise + run + drop along whichever `RACK*` zone is nearest), not an
A*-per-pair search — there's no flood-fill-shaped hot spot to fix here.

## Validation checkpoint (still outstanding)

Run the CLI against one real as-built unit plot plan. Where the solver
disagrees with the as-built, it's either a missing constraint (goes on this
list) or a real saving (the pitch for the whole tool). Item 10 shipped ahead
of this checkpoint (the user chose to unblock it explicitly), so this is
still worth doing — it's the only way to know if items 5–9 are the right
five, independent of the web UI now existing.

`backend/validate_unit.py` is the harness for this — give it a unit folder
whose `equipment.csv` has every row `pinned=true` at its real as-built
position and it sorts the disagreement into one of three buckets (missing
constraint / real saving / already near-optimal) with a per-equipment
displacement table. The only remaining step is pointing it at a real unit's
CSVs — the tooling itself is done and sanity-checks end-to-end on
`sample_unit` (which reports bucket (a) as expected, since it pins just one
item). See `backend/HELP.md` use case 7.

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
10. `[ ]` **Web UI** — FastAPI backend wrapping the existing solver + a real
    React app in `frontend/` (drag equipment, live score). Gated: only start
    after the CLI has been run against a real unit **and** the user
    explicitly asks for the web app — do not start this automatically just
    because earlier items are done. *Effort: L.*
11. `[ ]` **CP-SAT / MILP solver** — OR-Tools, swapped in only if simulated
    annealing stalls on >30 equipment items. *Effort: L.*

## Non-goals (explicit, don't creep in)

3D, ML, terrain/cut-fill, detailed pipe routing (that's a routing tool, not a
plot plan tool), cost database integration, any `frontend/` scaffolding
before item 10 is explicitly triggered.

## Validation checkpoint

Before item 10 (web UI): run the CLI against one real as-built unit plot
plan. Where the solver disagrees with the as-built, it's either a missing
constraint (goes on this list) or a real saving (the pitch for the whole
tool). Do this checkpoint even if it delays the roadmap — it's the only way
to know if items 5–9 are the right five.

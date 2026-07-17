# CLAUDE.md

Context for Claude Code (or any Claude instance) working in this repo.

## What this is

`plotplan-fit-me` — a TestFit-style generative plot plan tool for refinery /
petrochemical unit layout. Given equipment, a spacing table, and piping
connections, it generates a spacing-compliant 2D layout ranked by
rack-routed piping cost, and exports DXF.

See `README.md` for the feature list, `PLAN.md` for build order and status,
`backend/HELP.md` for the CSV format reference and worked examples.

## Repo structure

```
plotplan-fit-me/
├── backend/
│   ├── plotplan.py        solver + CLI — the solver itself, still where
│   │                      most constraint/scoring work happens
│   ├── api.py             FastAPI app wrapping the solver for frontend/
│   ├── requirements.txt   fastapi, uvicorn — install into backend/.venv
│   ├── HELP.md            CSV format reference + simple use cases
│   └── data/
│       └── sample_unit/   equipment.csv, connections.csv, spacing.csv,
│                          site.csv, keepouts.csv
├── frontend/               React + Vite UI, see frontend/README.md to run it
├── README.md
├── PLAN.md
└── CLAUDE.md
```

**Backend-first, historical note.** Item 10 (web UI) was gated behind an
explicit user ask and a real-unit validation checkpoint; the user chose to
unblock item 10 explicitly ahead of that checkpoint (still outstanding, see
PLAN.md). The gate no longer applies — `frontend/` is a real Vite/React app
now, not a placeholder. Any *further* frontend work (new pages, a build
pipeline, a UI framework beyond plain React/SVG) should still get a quick
sanity check with the user rather than assumed, since the original ask was
scoped to "drag equipment, live score, Solve button" — not a general go-ahead
for arbitrary frontend expansion.

## How to work in this repo

- **Ponytail, full intensity, always.** Stdlib first, one file before many,
  shortest working diff. Mark deliberate simplifications with a `ponytail:`
  comment naming the ceiling and the upgrade path (see existing comments in
  `backend/plotplan.py` for the pattern).
- Every non-trivial change (a branch, a loop, a new constraint) leaves one
  runnable check: extend the assert checks in `_check()`/`run()`, or add a
  `test_*.py` if the check doesn't fit there. No test frameworks unless the
  project outgrows stdlib `assert`.
- Work through `PLAN.md` **one item at a time**, top to bottom. Update the
  status checkbox when an item lands. Don't jump ahead to a later item
  because it looks easy — the order encodes real dependencies.
- A unit's data lives in a `backend/data/<unit_name>/` folder of CSVs:
  `equipment.csv`, `connections.csv`, `spacing.csv`, `site.csv` (required),
  `keepouts.csv` (optional). Load with `load_unit(data_dir)`. Never hardcode
  a new unit's data into `plotplan.py` — add a data folder instead.
- Don't add a web framework, database, or config system ahead of the
  roadmap item that needs it. If tempted, check PLAN.md non-goals first.
- When a CSV format changes (new column, new file), update `backend/HELP.md`
  in the same change — it's the format reference, not just PLAN.md's changelog.

## How the CLI works right now

```
python plotplan.py [data_dir] [seed | start:end]
```

- Neither arg given → sample_unit, seed 0.
- A plain int → runs once with that seed (original behavior, unchanged).
- `start:end` → runs every seed in that range, prints a ranked score table,
  writes only the best layout to `plotplan.dxf` + `plotplan_takeoff.csv`.
- `data_dir` and the seed/range arg can appear in either order — detected by
  whether the arg looks like a seed (`isdigit()` or `a:b` with digit `a`).

`run()` reloads `load_unit(data_dir)` fresh for every seed in the loop —
`solve()` mutates `Equipment.x/y` in place, so reuse across seeds would leak
positions between runs. Keep that reload pattern for any future per-seed
loop.

## equipment.csv format

Required columns: `tag,cls,w,d`. Optional columns: `x,y,pinned,pull_side,pull_len`.

- `pinned` truthy values: `1`, `true`, `yes` (case-insensitive). `x,y` only
  read when `pinned` is truthy for that row.
- `pull_side` is one of `x+`, `x-`, `y+`, `y-` (which face the maintenance
  clearance extends from); `pull_len` is the clearance length in meters.
  Blank/0 means no pull clearance.
- Any missing/blank optional cell resolves to the field's safe default —
  files with just the 4 required columns still load fine.
- Pinned items are fixed for the whole solve: excluded from
  `random_place`'s initial scatter and from `solve()`'s SA move selection.
  `solve()` pre-checks pinned-vs-pinned and pinned-vs-site/keepout
  feasibility before running, so a bad pin fails fast with a clear message
  instead of exhausting `random_place`'s retry budget.

`sample_unit/equipment.csv` pins H-101 at (15, 15) and gives E-102 a 6m `x+`
pull clearance — the live reference for both.

## keepouts.csv format (optional file)

```
zone,x,y
UNDERGROUND,60,10
UNDERGROUND,75,10
UNDERGROUND,75,25
UNDERGROUND,60,25
```

Rows sharing a `zone` name form one polygon, vertices in the order given
(closes automatically). A unit with no `keepouts.csv` gets an empty zone
dict — fully backward compatible, no behavior change.

**Roads and maintenance corridors are not a separate mechanism** — they're
keepout zones with a naming convention: a zone name starting with `ROAD`
draws on the `ROADS` DXF layer, `MAINT` draws on `MAINT`, anything else
draws on generic `KEEPOUT`. All three are checked identically in
`feasible()`. Don't build a second zone-loading path for roads if asked —
point at this convention instead.

The overlap check (`_rect_hits_poly`) samples each equipment's 4 corners +
center against the polygon, plus the polygon's vertices against the
equipment's bounding rect — good enough for convex zones and axis-aligned
rectangles, not full polygon-rectangle clipping. Documented ceiling in the
code; upgrade to Sutherland-Hodgman only if a real unit's zone shape needs it.

`sample_unit/keepouts.csv` has an `UNDERGROUND` rectangle and a `ROAD_main`
strip as the live examples.

## Outputs

`run()` writes two files for the winning seed:
- `plotplan.dxf` — layers SITE / RACK / EQUIPMENT / TAGS / KEEPOUT / ROADS /
  MAINT / PULL.
- `plotplan_takeoff.csv` — `write_takeoff()`: one `pipe` row per connection
  (a, b, weight, rack-routed length in meters), plus `rack_span_used` and
  `total_pipe_length_m` summary rows. Pure reporting — computed from the
  already-solved layout, doesn't touch the solver. Its length formula is
  intentionally a separate line of arithmetic from `piping_cost()`, not a
  shared helper; `run()` asserts they agree on the total before writing
  anything, which is the thing that would catch them drifting apart.

## Self-learning

This section is a running log Claude keeps for itself across sessions —
things learned about this specific codebase/domain that aren't obvious from
reading the code cold. Append short entries here as they're discovered.
Prune entries that get superseded.

Format: `- [date] finding — why it matters`

<!-- entries below this line -->
- [2026-07-16] Repo restructured into backend/ + frontend/ (frontend is a
  placeholder). plotplan.py lives at backend/plotplan.py, not repo root.
  Frontend build is explicitly gated on user request, not on reaching
  PLAN.md item 10 automatically.
- [2026-07-16] Item 1 (CSV import) done. `min_gap()`/`feasible()`/`solve()`
  now take a `spacing` dict param instead of reading a module-level global —
  matters for later items (multi-seed ranking, pinned equipment) that will
  call these with different units/tables in the same process. `DEFAULT_SPACING`
  is only a fallback; real units always ship their own spacing.csv.
- [2026-07-16] Item 2 (multi-seed ranking) done. `run()` signature changed
  from `run(data_dir, seed=0)` to `run(data_dir, seeds)` — seeds is always a
  list now, even for a single seed. CLI still accepts a single seed and
  behaves exactly as before; the `start:end` range syntax is new. Equipment
  must be reloaded fresh per seed inside the ranking loop, never reused —
  `solve()` mutates positions in place.
- [2026-07-16] Item 3 (pinned equipment) done. Any future feature that adds
  a per-equipment flag should follow the same shape: field on `Equipment`
  with a safe default, optional CSV column, filtered out of whatever list
  `solve()`/`random_place()` iterate over to mutate positions — not a
  separate parallel list. `_check()` takes an optional `pinned_before` arg;
  extend that same function rather than adding a second checker when the
  next per-item invariant shows up.
- [2026-07-16] Item 4 (polygon keep-outs) done. `load_unit()` now returns a
  5-tuple (added `keepouts` at the end) — grep for `load_unit(` before
  adding a 6th thing rather than trusting memory that every call site got
  updated. `feasible()`/`random_place()`/`solve()`/`_check()` all take a
  `keepouts` param threaded alongside `spacing`.
- [2026-07-16] Item 5 done. Roads/maintenance corridors needed *no* new
  loading mechanism — reused keepouts.csv with a name-prefix convention for
  DXF layer routing (`_zone_layer()`). Only genuinely new thing was
  tube-pull clearance (`pull_side`/`pull_len` on `Equipment`, `_pull_rect()`
  computing the swept rect, checked in `feasible()`). Also: `_rect_hits_poly`
  was refactored mid-item from `(cx, cy, w, d, poly)` to `(x1, y1, x2, y2,
  poly)` because pull rectangles aren't naturally center+size — check both
  call sites in `feasible()` and `_check()` if touching that signature
  again. DXF now draws keepout zones and pull rects for the first time; any
  new constraint type going forward should get a DXF layer too, not just a
  `feasible()` check.
- [2026-07-16] Item 6 (quantity takeoff CSV) done. `run()`'s `best` tuple
  grew again — now `(cost, eq, conns, site, keepouts)`, 5 elements. Same
  "grep before assuming" caution as item 4's `load_unit()` change applies
  here too if `best`'s shape changes again. `write_takeoff()` is pure
  reporting: it never touches solver state, only reads the already-solved
  layout. Deliberately did NOT factor the per-connection length formula out
  into a shared helper with `piping_cost()` — two independent
  implementations plus an assert that they agree is a better regression
  net than one shared function that could be wrong in a way that's
  invisible from either caller.
- [2026-07-16] Item 7 (equipment rotation) done. No new `Equipment` field —
  rotation is just `e.w, e.d = e.d, e.w` inside `solve()`'s move step (20%
  of moves, coin-flipped alongside the existing translation move), since
  `feasible()`/`_footprint()`/`_pull_rect()`/DXF/takeoff all already read
  `w`/`d` directly and don't care how the item got that footprint. Only
  ripple: `best_pos` snapshots in `solve()` grew from `(x, y)` to
  `(x, y, w, d)` tuples so the best-found layout can preserve rotations.
  `_check()` needed zero changes — its existing feasible/gap/keepout/pull
  assertions already cover a rotated footprint. Pinned equipment is
  excluded from `movable`, so it never rotates, matching how it already
  never translates.
- [2026-07-16] Item 8 (multiple racks) done. `Site.rack_y`/`rack_half`
  (two scalar fields) became `Site.racks: list[(rack_y, rack_half)]` — grep
  for `site.rack` before assuming a call site still has the old fields,
  same caution as `load_unit()`'s and `best`'s past shape changes.
  `site.csv` reuses the keepouts.csv "grouped rows" pattern: one row per
  rack, `w`/`d` only read from row 0. `feasible()`'s rack-corridor checks
  (both the plain footprint one and the pull-clearance one) became `any(...
  for ry, rhalf in site.racks)` instead of a single comparison — loop over
  every rack, not just check the nearest one, since equipment must clear
  *all* corridors. `piping_cost()` now does two things per connection:
  picks the rack minimizing rise+drop (an `min(..., key=...)` over
  `site.racks`), and separately accumulates `RACK_STEEL_COST_PER_M ×` the
  x-span of whichever equipment got routed onto each rack, so adding a
  rack has a real cost, not just a free routing option. `write_takeoff()`
  deliberately does NOT call the same rack-selection code as
  `piping_cost()` — same reasoning as item 6, two independent
  implementations plus `run()`'s existing total-cost assert catches drift
  between them. `rack_span_used` takeoff rows changed shape: now one row
  per rack in use, labeled `y=<rack_y>` in the `b` column, instead of one
  whole-site row — any code reading that CSV by row-count/position instead
  of `type` value would break.
- [2026-07-16] Item 9 (prevailing wind) done. `Site.wind_dir` follows the
  same "only read from the first CSV row" pattern as `w`/`d` — no new
  loading mechanism. The one refactor: `_pull_rect()`'s x+/x-/y+/y-
  direction dict got pulled out into `_side_rect(x1, y1, x2, y2, side,
  length)` so the new `_wind_rect()` (heater-only, fixed
  `WIND_CLEARANCE_M`) could reuse it instead of copy-pasting the same four
  branches a second time — do the same if a third directional-rectangle
  constraint shows up rather than writing a third copy. The wind check
  itself is a straight copy of the pull-clearance check's shape
  (rect-vs-every-other-footprint overlap) in both `feasible()` and
  `_check()`, not factored further — the two clearance types have
  different trigger conditions (per-item flag vs. per-class + site flag)
  so a shared function would need parameters threading through both call
  sites for marginal benefit.
- [2026-07-16] Item 10 (web UI) done, started explicitly by the user ahead
  of the as-built validation checkpoint. `run()`'s seed-ranking loop got
  pulled out into `solve_ranked(data_dir, seeds) -> (results, best)` (no
  file writes) so `backend/api.py` could reuse it byte-for-byte instead of
  re-implementing the loop — verified the CLI's printed scores are
  unchanged after the refactor before writing any API code. `backend/.venv`
  is a real venv (Homebrew's system Python is externally-managed and
  refuses bare `pip install`) — `requirements.txt` has just `fastapi` +
  `uvicorn[standard]`, nothing else. The `/score` endpoint intentionally
  returns only `{feasible, cost}`, no per-violation detail — `feasible()`
  returns a bare bool with no reason, and threading reasons through would
  touch every check in `feasible()`; skipped for this pass, `cost: null`
  when infeasible since `piping_cost()` is meaningless there.
  `frontend/App.jsx` is deliberately one component: unit picker, an SVG
  plot (native SVG, no canvas/chart lib — site/racks/keepouts/connections/
  equipment, y-flipped for north-up), drag-to-score (posts to `/score` on
  every pointermove, guards against out-of-order responses with a request-
  id ref), and a Solve button hitting `/solve` with the same seed/`a:b`
  syntax as the CLI. No state library, no UI kit — `useState` was enough.
  One gotcha: `preview_start`'s own subprocess launcher failed for the
  FastAPI backend ("getcwd: cannot access parent directories: Operation
  not permitted") even with absolute paths in `.claude/launch.json` — ran
  uvicorn directly via a backgrounded Bash command instead, and only used
  `preview_start`/the Browser pane for the Vite frontend, which worked
  fine from launch.json. If that error recurs, don't keep retrying
  preview_start with path tweaks — go straight to Bash.
- [2026-07-16] Item 11's gate ("only if SA stalls on >30 items") tested with
  a synthetic unit generator (scratchpad, not committed — realistic class
  mix matching sample_unit's proportions: heaters rare, exchangers/pumps
  dominant, since fired_heater's 15m omnidirectional spacing is what breaks
  small sites, not equipment count alone). Confirmed the gate is true:
  `random_place()`'s pure-random-scatter-then-reject-infeasible init starts
  failing outright around N=27-30 even on a site sized ~4x more generously
  (by area ratio) than sample_unit's — and even there, 1 of 8 seeds still
  hit the `RuntimeError` at N=30. Where init did succeed, full `solve()`
  (60000 iters, unchanged from N=8) took ~8s/seed vs ~3.8s/seed at N=8, and
  cross-seed score spread widened to ~25% (5003-6242) vs sample_unit's
  ~16% (394-457) — same iteration budget spread over more variables
  converges less reliably, not just slower. Net: item 11 is justified, not
  speculative — the failure mode is really in `random_place()`'s
  initialization strategy (probability of an all-N-item-feasible random
  scatter collapses combinatorially), which a CP-SAT/MILP replacement would
  sidestep entirely by construction. Have not yet implemented it — next
  step if asked is either replace just the init (seed SA from a
  constructive/greedy placement instead of pure random) or the full
  OR-tools swap PLAN.md item 11 describes.
- [2026-07-16] Item 11 (CP-SAT/MILP) implemented. `solve_cpsat()` mirrors
  `feasible()`'s constraint set (bounds/racks/keepouts/spacing/pull/wind/
  pinned) as CP-SAT linear/disjunctive constraints on a `CPSAT_GRID_M`
  (0.5m) grid, dispatched from `solve_ranked()` automatically once movable
  count exceeds `CPSAT_THRESHOLD` (30) — `solve()`/SA is untouched below
  that, `backend/api.py` needed zero changes since it only calls
  `solve_ranked()`. Two correctness traps hit and fixed during
  implementation, worth knowing before touching this function again:
  (1) pinned equipment's grid box can't be `floor(left)` combined with a
  separately-`ceil`'d width — those two roundings don't compose into a box
  that's guaranteed to *contain* the real footprint; had to compute
  `floor(real_left)` and `ceil(real_right)` independently and take the
  difference as the grid width. (2) CP-SAT's non-strict `<=`/`>=`
  constraints let it place solutions exactly touching a clearance boundary,
  which floating-point noise can then flip to a violation once decoded to
  real meters and re-checked by `feasible()`'s strict `<`; fixed by padding
  every required-minimum conversion (pairwise gap, rack half-width) with
  `CPSAT_EPS_M` (1cm) before rounding, so decoded solutions clear the real
  check with margin instead of landing exactly on its float boundary.
  Zero-margin checks (pull clearance, wind — plain non-overlap, no minimum
  distance) don't need this, only the ones with an actual required-distance
  threshold do. The objective deliberately does NOT include the rack-steel-
  span term from `piping_cost()` (needs conditional min/max bookkeeping
  across "items actually routed onto a used rack" that isn't worth exact-
  modeling for a secondary cost term) — `solve_cpsat()` still *returns* the
  true complete `piping_cost()` after decoding, so `run()`'s existing
  cross-check assert holds regardless of which solver ran. Keep-out zones
  are approximated as their bounding box in the CP-SAT model (exact for
  every zone this repo's data actually has — all rectangles — an
  overestimate of the exclusion for a hypothetical concave zone); same
  ceiling as `_rect_hits_poly`'s existing documented approximation, not a
  new one. `ortools` added to `backend/requirements.txt` — the one
  dependency addition this repo's ponytail rules explicitly anticipate,
  since the roadmap item itself names OR-Tools as the tool.
- [2026-07-17] `backend/api.py`'s mutating endpoints changed shape, done at
  explicit user request for File > New/Open/Save/Save As/Export in the
  frontend (not a PLAN.md item). `POST /api/units/{name}/score|solve|
  export/*` (position-overlay-onto-a-named-unit) were replaced outright by
  `POST /api/score`, `/api/solve`, `/api/export/dxf`, `/api/export/takeoff`
  — all take the FULL case study inline in the request body (a `CaseData`
  pydantic model: equipment/connections/site/keepouts/spacing/name) instead
  of a `{name}` path param + position overlay. `GET /api/units` and `GET
  /api/units/{name}` are unchanged — still the only things that read
  `data/<name>/` CSVs, now used only to seed a project's *starting* state.
  Reasoning: a project opened from (or saved to) a `.json` file in the
  frontend never has to correspond to an on-disk unit — `_build_case()`
  converts posted JSON into the same `(eq, conns, spacing, site, keepouts)`
  tuple `load_unit()` produces, then every existing function
  (`feasible()`/`piping_cost()`/`solve()`/`solve_cpsat()`/`write_dxf()`/
  `write_takeoff()`) is called exactly as before — no solver changes.
  `/api/solve`'s per-seed loop rebuilds fresh `Equipment` objects from the
  posted spec each iteration (not by reloading CSVs, since there's no file)
  — same reload-per-seed rule as `solve_ranked()`, for the same mutation
  reason. Frontend's `src/lib/project.js` mirrors this shape
  (`buildCaseData()`/`projectFileContents()`/`parseProjectFile()`) with its
  own runnable check; `src/lib/raster.js` (PNG/JPG export, client-side SVG
  rasterization) has no check — it's inherently DOM/Canvas-dependent,
  verified manually in-browser instead. If a mutating endpoint's request
  shape needs to change again, grep `CaseData` and `_build_case` first —
  same "grep before assuming" caution as every other shape change logged
  above.
- [2026-07-17] Pipe racks unified into `keepouts` as a `RACK*`-named zone
  (same mechanism ROAD*/MAINT* already used), at explicit user request so
  a rack could become a real rectangle drawable on the canvas instead of a
  `(rack_y, rack_half)` band implicitly spanning the whole site width.
  `Site.racks` is gone entirely — `Site` is just `w, d, wind_dir` now.
  `_rack_zones(keepouts)` (grep this before assuming a call site still
  takes a `racks` param) pulls out `RACK*` zones; their bounding box is
  both the exclusion (for free, via the existing generic keepout-overlap
  check — no rack-specific feasibility code needed anymore) and the
  piping-routing target (`piping_cost()`/`solve_cpsat()`'s objective pick
  whichever rack zone's y-center gives the shortest rise+drop, unchanged
  reasoning from before). `piping_cost()`/`solve_cpsat()` raise a clear
  error if a unit has connections but no `RACK*` zone — but only when
  `conns` is non-empty, since a blank/equipment-less project (frontend's
  File > New) must still score cleanly at cost 0 without one.
  Two correctness traps hit during the refactor, worth knowing before
  touching this again: (1) migrating sample_unit's two racks to zones
  spanning the full site width at the same y-bands changed the CLI's best
  score for seeds 0:8 from 394 to 386 — NOT a bug, confirmed via a 500k-case
  fuzz test showing `feasible()`'s new keepout-based rack check is exactly
  equivalent to the old formula for any footprint inside site bounds; the
  score differs only because SA pushes equipment to the site's edge
  (`site.d - e.d/2`), which for this unit's specific dimensions lands
  exactly on a rack's edge too — old code's strict `<` let that
  exact-touching case slide, the new shared keepout check (already
  non-strict/inclusive, same as every other zone) correctly treats it as a
  hit, and SA finds a different (here, better) path from there. (2) CP-SAT
  needed `CPSAT_EPS_M` padding added to `kboxes` (previously zero-padded,
  since a plain keepout's zero-margin non-strict check seemed consistent
  with `_cpsat_no_overlap`'s gap=0) — measured via `test_cpsat.py` that
  `_rect_hits_poly`'s ray-casting point-in-polygon test is ambiguous for a
  query point exactly ON a zone edge/vertex, and the piping-cost objective
  actively pulls solutions flush against a rack's edge (unlike most plain
  keepouts, which nothing is attracted toward), reliably triggering that
  ambiguity for racks specifically. Frontend: `PlotCanvas.jsx` gained a
  rubber-band draw tool (`draw-road`/`draw-rack`, tool value convention
  matches the `DRAW_PREFIX` map) — drag on the canvas background commits a
  new `{PREFIX}_{n}` zone via `onAddZone`; click-to-select (only in the
  `select` tool) + Delete/Backspace removes one via `onDeleteZone`. Both
  live in `App.jsx`, mutating `data.keepouts` the same way drag/solve
  mutate `positions` — no new persistence concept, Save/Save As already
  serialize whatever's in `data`.

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
│   ├── plotplan.py        solver + CLI — all active development happens here
│   ├── HELP.md            CSV format reference + simple use cases
│   └── data/
│       └── sample_unit/   equipment.csv, connections.csv, spacing.csv,
│                          site.csv, keepouts.csv
├── frontend/               placeholder only, see frontend/README.md
├── README.md
├── PLAN.md
└── CLAUDE.md
```

**Backend-first, hard rule.** Do not create `package.json`, scaffold a React
app, or add any frontend framework files in `frontend/` unless the user
explicitly asks for it in that session — not automatically when PLAN.md
reaches item 10. If a task seems to require frontend work, stop and ask
rather than scaffolding it.

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

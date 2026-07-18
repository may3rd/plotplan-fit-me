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
now, not a placeholder, and has since grown well past the original ask
(zone drawing, road/rack merging, view modes). Any *further* frontend
expansion (new pages, a build pipeline, a UI framework/state library beyond
plain React/SVG + `useState`) should still get a quick sanity check with the
user rather than assumed.

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
- Several core data shapes have changed repeatedly as roadmap items landed
  (`load_unit()`'s return tuple, `run()`'s `best` tuple, `Site`'s fields,
  the set of special `keepouts` zone prefixes). **Grep for the symbol before
  touching a call site** — don't trust memory of its old shape; the
  Self-learning log below records why each change happened, not always
  what the *current* shape is.

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

## How the frontend works

`frontend/` is a Vite + React app: one `App.jsx` owning all state, driving
two components — `Ribbon.jsx` (the Word-style toolbar/menus) and
`PlotCanvas.jsx` (the SVG plot itself: equipment, zones, connections, and
essentially all rendering/interaction logic). No state library, no UI kit
beyond shadcn/ui primitives — `useState` is enough for this size; don't add
one without asking.

A project is `data = {equipment, connections, site, keepouts, spacing,
wind_clearance_m, name}` plus a separate `positions` map (`tag -> {x,y}`)
that the canvas mutates as equipment gets dragged. `keepouts` is the same
`{zone_name: [[x,y],...]}` shape the backend's keepouts.csv loads into —
`ROAD*`/`RACK*`/`MAINT*` prefixes get special rendering (color, hatch,
merging), anything else renders as a generic keep-out. File > Save/Open
round-trips the whole `data` object as JSON (`src/lib/project.js`); a
project never has to correspond to an on-disk backend unit.

Drawing a zone (Insert > Draw road/rack/maint/underground/keepout) is one
press-drag-release gesture, not two clicks. `DRAW_KINDS[kind].shape` in
PlotCanvas.jsx picks the interaction — `'centerline'` (road/rack: a plain
tap drops a full-site-width horizontal line; dragging gives a custom h/v
line snapped to whichever axis the drag is closer to) or `'rect'`
(maint/underground/keepout: a tap drops a fixed 10m square centered on the
click, dragging gives a custom two-corner rectangle). Extend that map for
a new zone kind rather than special-casing by kind elsewhere.

Roads and pipe racks that overlap/touch get merged into one visual shape
instead of showing a seam at the join — always a pure rendering overlay:
the underlying `keepouts` entries are never combined or deleted, a merged
member just renders invisible (`.merged-quiet`, still clickable via CSS
`pointer-events: all`) and shows its own true shape again once selected.
Roads merge on *any* overlap/touch regardless of orientation (a chain reads
as one continuous road) with rounded corners at real turns. Pipe racks
merge *only* where they actually cross (perpendicular — same-orientation
overlaps stay separate, distinct segments), into the true L/T-shaped union
of the real footprints, with sharp corners (no rounding — racks are
structural corridors, not vehicle paths). Both reuse the same
`clusterZones`/`unionRoadOutline`/`withCornerFills` trio with a different
merge predicate; see the 2026-07-18 Self-learning entry for the geometry
details.

View mode (Normal / Wireframe / DXF, in the View tab, `viewMode` prop) only
changes how PlotCanvas.jsx renders — fill vs. outline-only vs. a monochrome
DXF-like preview that shows every zone's true separate/unrounded shape and
real name. It never touches `data`/`keepouts`, and every merge/rounding
feature above is gated `!== 'dxf'` since the real DXF export never merges.

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

**Roads, pipe racks, and maintenance corridors are not a separate
mechanism** — they're keepout zones with a naming convention: a zone name
starting with `ROAD` draws on the `ROADS` DXF layer, `RACK` draws on the
`RACK` layer (and is the piping-cost/CP-SAT routing target — see
`_rack_zones()`), `MAINT` draws on `MAINT`, anything else draws on generic
`KEEPOUT`. All are checked identically in `feasible()`. Don't build a
second zone-loading path for roads or racks if asked — point at this
convention instead.

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
Prune or condense entries that get superseded — a note that a mechanism was
fully replaced is worth more than the stale details of how it used to work.

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
  5-tuple (added `keepouts` at the end). `feasible()`/`random_place()`/
  `solve()`/`_check()` all take a `keepouts` param threaded alongside
  `spacing`.
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
  grew again — now `(cost, eq, conns, site, keepouts)`, 5 elements.
  `write_takeoff()` is pure reporting: it never touches solver state, only
  reads the already-solved layout. Deliberately did NOT factor the
  per-connection length formula out into a shared helper with
  `piping_cost()` — two independent implementations plus an assert that
  they agree is a better regression net than one shared function that
  could be wrong in a way that's invisible from either caller.
- [2026-07-16] Item 7 (equipment rotation) done. No new `Equipment` field —
  rotation is just `e.w, e.d = e.d, e.w` inside `solve()`'s move step (20%
  of moves, coin-flipped alongside the existing translation move), since
  `feasible()`/`_footprint()`/`_pull_rect()`/DXF/takeoff all already read
  `w`/`d` directly and don't care how the item got that footprint. Only
  ripple: `best_pos` snapshots in `solve()` grew from `(x, y)` to
  `(x, y, w, d)` tuples so the best-found layout can preserve rotations.
  Pinned equipment is excluded from `movable`, so it never rotates, matching
  how it already never translates.
- [2026-07-16] Item 8 (multiple racks) originally added `Site.racks:
  list[(rack_y, rack_half)]` (two-scalar `Site.rack_y`/`rack_half` became a
  list) — **fully superseded** by the 07-17 rack-to-keepouts-zone refactor
  below. `Site` is just `w, d, wind_dir` now; `site.racks` no longer exists.
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
  re-implementing the loop. `backend/.venv` is a real venv (Homebrew's
  system Python is externally-managed and refuses bare `pip install`) —
  `requirements.txt` has just `fastapi` + `uvicorn[standard]`. The
  `/score` endpoint intentionally returns only `{feasible, cost}`, no
  per-violation detail — `feasible()` returns a bare bool with no reason,
  and threading reasons through would touch every check in `feasible()`.
  One gotcha: `preview_start`'s own subprocess launcher failed for the
  FastAPI backend ("getcwd: cannot access parent directories: Operation
  not permitted") even with absolute paths in `.claude/launch.json` — ran
  uvicorn directly via a backgrounded Bash command instead, and only used
  `preview_start`/the Browser pane for the Vite frontend, which worked
  fine from launch.json. If that error recurs, don't keep retrying
  preview_start with path tweaks — go straight to Bash.
- [2026-07-16] Item 11 (CP-SAT/MILP) implemented, after confirming the gate
  ("only if SA stalls on >30 items") with a synthetic unit generator
  (scratchpad, not committed): `random_place()`'s pure-random-scatter-then-
  reject-infeasible init starts failing outright around N=27-30 even on a
  site sized ~4x more generously (by area) than sample_unit's, and even
  successful runs saw cross-seed score spread widen to ~25% vs
  sample_unit's ~16% — the failure is really in `random_place()`'s init
  strategy, not solver quality, which a constructive solver sidesteps by
  construction.
  `solve_cpsat()` mirrors `feasible()`'s constraint set (bounds/racks/
  keepouts/spacing/pull/wind/pinned) as CP-SAT constraints on a
  `CPSAT_GRID_M` (0.5m) grid, dispatched from `solve_ranked()`
  automatically once movable count exceeds `CPSAT_THRESHOLD` (30) —
  `solve()`/SA untouched below that, `backend/api.py` needed zero changes.
  Two correctness traps worth knowing before touching this again: (1)
  pinned equipment's grid box needs `floor(real_left)`/`ceil(real_right)`
  computed independently, not `floor(left)` combined with a
  separately-`ceil`'d width — those two roundings don't compose into a box
  guaranteed to *contain* the real footprint. (2) CP-SAT's non-strict
  `<=`/`>=` lets it place solutions exactly touching a boundary, which
  float noise can then flip to a violation once decoded and re-checked by
  `feasible()`'s strict `<` — fixed by padding every required-minimum
  conversion (pairwise gap, rack half-width) with `CPSAT_EPS_M` (1cm)
  before rounding; zero-margin checks (pull/wind — plain non-overlap, no
  minimum distance) don't need this. The objective deliberately excludes
  the rack-steel-span term from `piping_cost()` (not worth exact-modeling
  for a secondary cost term) — `solve_cpsat()` still *returns* the true
  complete `piping_cost()` after decoding, so `run()`'s cross-check assert
  holds regardless of which solver ran. Keep-out zones are approximated as
  their bounding box in the CP-SAT model (exact for every zone this repo's
  data actually has — all rectangles). `ortools` added to
  `backend/requirements.txt`.
- [2026-07-17] `backend/api.py`'s mutating endpoints changed shape, at
  explicit user request for File > New/Open/Save/Save As/Export in the
  frontend (not a PLAN.md item). `POST /api/units/{name}/score|solve|
  export/*` (position-overlay-onto-a-named-unit) were replaced outright by
  `POST /api/score`, `/api/solve`, `/api/export/dxf`, `/api/export/takeoff`
  — all take the FULL case study inline in the request body (a `CaseData`
  pydantic model: equipment/connections/site/keepouts/spacing/name) instead
  of a `{name}` path param + position overlay. `GET /api/units` and
  `GET /api/units/{name}` are unchanged — still the only things that read
  `data/<name>/` CSVs, now used only to seed a project's *starting* state.
  A project opened from (or saved to) a `.json` file in the frontend never
  has to correspond to an on-disk unit — `_build_case()` converts posted
  JSON into the same `(eq, conns, spacing, site, keepouts)` tuple
  `load_unit()` produces, then every existing function is called exactly
  as before — no solver changes. `/api/solve`'s per-seed loop rebuilds
  fresh `Equipment` objects from the posted spec each iteration (no CSVs
  to reload). Frontend's `src/lib/project.js` mirrors this shape
  (`buildCaseData()`/`projectFileContents()`/`parseProjectFile()`);
  `src/lib/raster.js` (PNG/JPG export, client-side SVG rasterization) has
  no automated check — inherently DOM/Canvas-dependent, verify manually
  in-browser.
- [2026-07-17] Pipe racks unified into `keepouts` as a `RACK*`-named zone
  (same mechanism ROAD*/MAINT* already used), at explicit user request so
  a rack could become a real rectangle drawable on the canvas instead of a
  `(rack_y, rack_half)` band implicitly spanning the whole site width (see
  the now-dead Item 8 entry above). `_rack_zones(keepouts)` pulls out
  `RACK*` zones; their bounding box is both the exclusion (via the existing
  generic keepout-overlap check — no rack-specific feasibility code
  needed) and the piping-routing target (`piping_cost()`/`solve_cpsat()`'s
  objective pick whichever rack zone's y-center gives the shortest
  rise+drop). `piping_cost()`/`solve_cpsat()` raise a clear error if a unit
  has connections but no `RACK*` zone — only when `conns` is non-empty,
  since a blank/equipment-less project (frontend's File > New) must still
  score cleanly at cost 0 without one.
  Two correctness traps hit during the refactor: (1) migrating
  sample_unit's two racks to zones spanning the full site width changed the
  CLI's best score for seeds 0:8 from 394 to 386 — NOT a bug (confirmed via
  a 500k-case fuzz test that the new keepout-based rack check is exactly
  equivalent to the old formula for any footprint inside site bounds); the
  score differs only because SA pushes equipment flush to the site edge,
  which for this unit's dimensions lands exactly on a rack's edge — the
  old strict `<` let that exact-touching case slide, the new shared
  keepout check (non-strict/inclusive, like every other zone) correctly
  treats it as a hit, and SA finds a different (better) path from there.
  (2) CP-SAT needed `CPSAT_EPS_M` padding added to `kboxes` (previously
  zero-padded) — `_rect_hits_poly`'s ray-casting point-in-polygon test is
  ambiguous for a query point exactly ON a zone edge/vertex, and the
  piping-cost objective actively pulls solutions flush against a rack's
  edge (unlike most plain keepouts), reliably triggering that ambiguity
  for racks specifically.
- [2026-07-18] Frontend zone-drawing/rendering overhaul, all in
  PlotCanvas.jsx/App.jsx/App.css, no backend changes (the OLD rubber-band
  drag-to-add-zone description from the 07-17 entry above is superseded by
  this). (1) Added a Normal/Wireframe/DXF view mode (`viewMode` prop, pure
  rendering switch — DXF view shows every zone's true separate/unrounded
  shape with its real name, previewing the actual export; gates every
  merge/rounding feature below). (2) Zone drawing switched from two clicks
  to one press-drag-release gesture with a tap shortcut
  (`DRAW_TAP_THRESHOLD_M`); `DRAW_KINDS[kind].shape` (`'centerline'` vs
  `'rect'`) branches the interaction — extend that map, don't add a third
  special-cased drawing path. (3) Roads that overlap/touch merge into one
  rounded shape (`clusterRoadZones` — any orientation merges) via a shared
  `clusterZones(entries, shouldMerge)` union-find helper, `unionRoadOutline`
  (grid-trace boundary of a rect cluster) + `withCornerFills` (adds a ghost
  corner-square rect for any overlapping perpendicular pair — two
  roads/racks drawn as centerline+width only reach each other's
  *centerline*, not the far edge, so without this the union comes out
  notched instead of a clean corner) + `roundedPolygonPath` (fillets only
  the corners the merge actually created, not original dead-end corners —
  see `junctionCornerFlags` — and only the outer swing of a real bend, not
  every convex corner, via `outerSwingFlags`; the inner notch rounds tight
  at `ROAD_INNER_RADIUS_M`, the outer swing rounds wide at that plus the
  narrowest road width in the cluster). (4) Pipe racks reuse the same
  `clusterZones`/`withCornerFills`/`unionRoadOutline` trio but with a
  DIFFERENT merge predicate (`clusterRackZones` — only perpendicular/
  crossing pairs merge; same-orientation overlaps stay separate, distinct
  segments) and NO rounding (plain sharp-cornered polygon — racks are
  structural corridors, not a vehicle path). (5) Rack width (7.5m) and a
  new rack beam/cross-tie spacing (6m, `rackBeamSpacing` state, a "Beam
  spacing (m)" field added to the same draw-rack width-prompt dialog) are
  both adjustable; `rackHatchSegments(poly, spacing, excludeDRanges)`
  derives its beam anchor from the polygon's own bounding box (left edge
  if wider-than-tall, top/max-Y edge if taller-than-wide) — NOT draw order
  — so spacing is deterministic for both a lone rack and a merged cluster;
  the last regular beam snaps exactly to the far end if its gap would be
  under `RACK_BEAM_END_MIN_GAP_M` (3m). On a crossing, each original rack
  still draws its own beams along its own length, just none inside the
  square where it actually crosses another rack (excluded via
  `rackCrossDRange`) — and that square is framed on all 4 sides rather
  than left empty, by re-adding a beam exactly at each exclusion range's
  boundary (one rack contributes the left/right frame edges, the crossing
  rack the top/bottom). All zone merging (road AND rack) is a pure
  rendering overlay — `keepouts` entries are never combined or deleted; a
  merged member renders invisible (`.merged-quiet`, CSS `pointer-events:
  all` so it stays clickable) and shows its own true shape again once
  selected.

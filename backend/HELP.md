# HELP — input CSV files and simple use cases

A "unit" is a folder of CSV files. Point the CLI at the folder:

```
cd backend
python plotplan.py data/my_unit        # seed 0
python plotplan.py data/my_unit 7       # seed 7
python plotplan.py data/my_unit 0:20    # rank seeds 0-19, keep the best
```

With no folder given it defaults to `data/sample_unit/`, the reference
dataset used throughout this doc.

---

## The files

### equipment.csv — required

One row per piece of equipment.

| column | required? | meaning |
|---|---|---|
| `tag` | yes | equipment name, e.g. `C-101` |
| `cls` | yes | spacing class — must match a class used in `spacing.csv` |
| `w` | yes | footprint width, meters (x-direction) |
| `d` | yes | footprint depth, meters (y-direction) |
| `x`, `y` | no | fixed position — only used when `pinned` is true |
| `pinned` | no | `true`/`yes`/`1` to fix this item in place; anything else (or blank) means the solver places it |
| `pull_side` | no | `x+`, `x-`, `y+`, or `y-` — which face has a maintenance/tube-pull clearance |
| `pull_len` | no | length in meters of that clearance; blank or `0` means none |

You can omit `x,y,pinned,pull_side,pull_len` entirely — a plain 4-column
file (`tag,cls,w,d`) still works, every item is just freely placed with no
clearances.

### connections.csv — required

One row per pipe run between two equipment tags.

| column | meaning |
|---|---|
| `a`, `b` | the two equipment tags this line connects |
| `weight` | relative cost per meter of route — roughly `line_count × size_factor`. A 3.0 means "treat this like 3x the piping of a weight-1.0 line." |

Every line is assumed to route via the pipe rack (up to rack height, along
the rack, down to the destination) — that's what the solver is minimizing.

### spacing.csv — required

The minimum edge-to-edge clearance between two equipment classes.

| column | meaning |
|---|---|
| `cls_a`, `cls_b` | the two classes this rule applies to |
| `min_gap` | minimum clearance in meters |

Only list each pair once (order doesn't matter — `A,B` also covers `B,A`).
Any pair not listed defaults to 3 m (generic access clearance). This is
where you'd paste in your company's actual spacing table (GAP.2.5.2, API RP
752/753, NFPA 30, etc.) — the shipped values in `sample_unit/spacing.csv`
are placeholders.

### site.csv — required

Describes the site rectangle. One row (extra rows are ignored):

| column | meaning |
|---|---|
| `w`, `d` | site extent in meters (x, y) |
| `wind_dir` | optional — see the wind constraint below |

```
w,d
90,60
```

An optional `wind_dir` column sets the prevailing wind direction — `x+`,
`x-`, `y+`, or `y-`, the side the wind blows *from* (the upwind side of
every fired heater). No equipment may sit within `WIND_CLEARANCE_M` (a
module constant in `plotplan.py`) of that side of any `fired_heater`-class
item — a hydrocarbon release there would blow straight into the open
flame. Leave the column blank or omit it for no wind constraint:

```
w,d,wind_dir
90,80,x+
```

That says wind blows from the east (`x+`): nothing may sit east of a fired
heater within the clearance distance.

### keepouts.csv — required (at least one `RACK*` zone)

Rows sharing a `zone` name form one polygon, vertices in the order given
(it closes automatically — don't repeat the first point).

| column | meaning |
|---|---|
| `zone` | polygon name — shared across rows to group vertices |
| `x`, `y` | one vertex |

**Roads, maintenance corridors, and pipe racks are all the same
mechanism** — a keep-out zone, not a separate file or field. The zone
*name* decides both its DXF layer and (for racks only) its extra role:

| name prefix | DXF layer | also... |
|---|---|---|
| `RACK` | `RACK` | a piping-routing target — every connection rises to, runs along, and drops from whichever `RACK*` zone's y-center gives it the shortest rise+drop. At least one `RACK*` zone is required — `piping_cost()`/`solve()` raise a clear error without one. Rack steel is costed too: for each rack zone actually used by at least one connection, its physical span (leftmost to rightmost x among the equipment routed onto it) is added to the score at `RACK_STEEL_COST_PER_M` (a module constant in `plotplan.py`) — more racks means more steel to pay for, not a free lunch. |
| `ROAD` | `ROADS` | nothing extra — a pure exclusion, same as any other keep-out |
| `MAINT` | `MAINT` | nothing extra — a pure exclusion |
| anything else | `KEEPOUT` | nothing extra — a pure exclusion |

Every zone (rack or not) is a hard exclusion: no equipment footprint,
pull-clearance rectangle, or wind sector may overlap it. A rack's
rectangle is usually a full-width horizontal (or vertical) strip, but
there's no requirement it span the whole site — a rack can be any
rectangle anywhere in the site (this is also what lets the frontend draw
one interactively rather than only loading it from a CSV).

```
zone,x,y
RACK_1,0,26
RACK_1,90,26
RACK_1,90,34
RACK_1,0,34
```

That's a rack spine 8m wide (y 26–34) spanning the full site width — the
same shape the old `rack_y=30,rack_half=4` format described, just as an
explicit rectangle instead of an implicit infinite-width band.

Non-rack zones use the exact same file, e.g. a road:

```
zone,x,y
ROAD_main,0,50
ROAD_main,90,50
ROAD_main,90,56
ROAD_main,0,56
```

A circle (e.g. a flare sterile radius) is approximated as a many-sided
polygon — more points, smoother circle.

See `data/sample_unit/keepouts.csv` for worked `RACK`, `ROAD`, and generic
(`UNDERGROUND`) examples.

---

## Use case 1: the simplest possible unit

Two vessels, one pipe run, no pins, no other keep-outs — just the required
pipe rack.

`equipment.csv`
```
tag,cls,w,d
A,vessel,4,3
B,vessel,4,3
```

`connections.csv`
```
a,b,weight
A,B,1.0
```

`spacing.csv`
```
cls_a,cls_b,min_gap
vessel,vessel,3.0
```

`site.csv`
```
w,d
50,40
```

`keepouts.csv`
```
zone,x,y
RACK_1,0,17
RACK_1,50,17
RACK_1,50,23
RACK_1,0,23
```

Run it:
```
python plotplan.py data/my_unit
```
Output: a score, the (x, y) of A and B, and `plotplan.dxf` +
`plotplan_takeoff.csv`.

---

## Use case 2: finding the best layout

One layout from one seed isn't necessarily the best packing. Run a range
and let the solver rank them:

```
python plotplan.py data/my_unit 0:30
```

Prints a `seed / score` table sorted best-first, and writes only the
winning layout's DXF and takeoff CSV. More seeds = more chances at a better
score, at the cost of more runtime (each seed is a full solve).

---

## Use case 3: pin a piece of equipment that's already located

Say the fired heater's position is already fixed by other constraints (an
existing structure, a tie-in point) and you want the rest of the unit to
solve around it. Add `x,y,pinned` to that row only:

```
tag,cls,w,d,x,y,pinned
H-101,fired_heater,8,8,15,15,true
C-101,column,6,6,,,false
...
```

Blank `x`/`y`/`pinned` on the other rows is fine — they're only read when
`pinned` is true for that row. If a pin conflicts with another pin, the
site, or a keep-out zone, the solver fails fast with a clear error instead
of quietly retrying thousands of times.

See `data/sample_unit/equipment.csv` — H-101 is pinned at (15, 15).

---

## Use case 4: a flare radius / underground line / blast contour / road / pipe rack

All five are the exact same file and mechanism — see the `keepouts.csv`
section above for the full name-prefix table (`RACK`/`ROAD`/`MAINT`/
anything else). A rectangle needs 4 rows:

```
zone,x,y
UNDERGROUND,60,10
UNDERGROUND,75,10
UNDERGROUND,75,25
UNDERGROUND,60,25
```

No equipment footprint may overlap this rectangle. A circle (e.g. a flare
sterile radius) is approximated as a many-sided polygon — more points,
smoother circle.

See `data/sample_unit/keepouts.csv` for worked `RACK`, `ROAD`, and generic
(`UNDERGROUND`) examples.

---

## Use case 5: tube-pull / maintenance clearance

A heat exchanger needs a clear straight run in front of it to pull the tube
bundle for maintenance. Add `pull_side` and `pull_len` to that row:

```
tag,cls,w,d,x,y,pinned,pull_side,pull_len
E-102,exchanger,5,2,,,false,x+,6
```

This says: E-102 needs 6 meters of clear space extending from its `+x`
face. That swept rectangle must stay inside the site, clear of every
keep-out zone (pipe racks included), and clear of every other piece of
equipment — nothing may sit in the pull path, even if it would otherwise
satisfy normal spacing rules.

`pull_side` is one of `x+`, `x-`, `y+`, `y-` (which face). Leave both
columns blank (or `pull_len` at 0) for equipment with no pull clearance.

This is also present on E-102 in `data/sample_unit/equipment.csv`.

---

## Use case 6: prevailing wind constraint

Add `wind_dir` to `site.csv` to keep equipment out of a fired heater's
upwind side:

```
w,d,wind_dir
90,80,x+
```

Wind blows from the east (`x+`) here, so no equipment may sit within
`WIND_CLEARANCE_M` east of any `fired_heater`-class item. Leave the column
blank for no wind constraint.

This is also present in `data/sample_unit/site.csv` (heater H-101, wind
from `x+`).

---

## Reading the outputs

### plotplan.dxf

Layers: `SITE` (boundary), `EQUIPMENT` + `TAGS` (footprints and labels),
`RACK`/`KEEPOUT`/`ROADS`/`MAINT` (keepouts.csv zones, split by name
prefix — pipe racks included), `PULL` (tube-pull/maintenance swept
rectangles), `WIND` (fired heater upwind exclusion sectors).

### plotplan_takeoff.csv

A quantity takeoff for early cost estimation — every result is a plain
number, no formulas to unpick:

```
type,a,b,weight,length_m
pipe,H-101,C-101,3,25.47
pipe,C-101,E-101,2,21.09
...
rack_span_used,,RACK_1,,24.90
total_pipe_length_m,,,,197.08
```

- `pipe` rows: one per connection, with the rack-routed length (meters)
  between those two tags at the final positions — each routed via whichever
  `RACK*` zone is shortest for that connection.
- `rack_span_used`: one row per rack zone actually used by at least one
  connection, `b` identifying which zone and `length_m` the x-distance
  between the leftmost and rightmost equipment routed onto it — how much
  physical rack steel this layout actually needs (not the zone's full
  width, which is usually more than what's used). A single-rack unit still
  gets exactly one such row.
- `total_pipe_length_m`: sum of all `pipe` row lengths (unweighted — this
  is meters of pipe, not the piping cost score).

## Common errors

- **`no pipe rack zone defined (a keepouts zone named RACK*)`** — every
  unit needs at least one `keepouts.csv` zone named `RACK*`; add one (see
  the `keepouts.csv` section above).
- **`no feasible initial layout — site too small for spacing table`** — the
  site can't fit everything given the spacing rules and keep-outs. Enlarge
  the site or loosen spacing.
- **`pinned equipment violates site/spacing/keepout constraints on its
  own`** — two pinned items (or a pin and a keep-out zone, or a pin and
  another pin's pull-clearance path) conflict before the solver even starts
  moving anything. Fix the pin coordinates.
- Any `KeyError` on a CSV column name means a required column is missing or
  misspelled — check the tables above.

## Use case 7: validate against a real as-built plot plan

`validate_unit.py` is the validation-checkpoint harness (PLAN.md's
outstanding item). It takes a normal unit folder whose `equipment.csv` has
every row `pinned=true` at its real as-built position — that makes the
loaded layout the as-built itself — then re-solves the same unit with all
pins dropped so the solver is free to find its own layout, and reports
where they disagree.

```
python validate_unit.py data/my_real_unit        # seeds 0:16
python validate_unit.py data/my_real_unit 0:32   # more seeds for a bigger unit
```

It sorts the disagreement into one of three buckets:

- **(a) as-built INFEASIBLE under our model** — a missing or wrong
  constraint. The harness lists every violation (out of bounds, gap
  shortfalls, keepout/pull/wind overlaps). Add the constraint to PLAN.md's
  optional-later list; don't trust any "saving" the solver reports until
  the as-built is feasible.
- **(b) as-built feasible, solver BEATS it on modeled cost** — a real
  saving under the constraints we have (the whole tool's pitch), OR a
  constraint the as-built respected that we don't model (cross-check
  against bucket (a): if the as-built was feasible, the saving is genuine
  under what we currently enforce).
- **(c) solver can't beat the as-built** — the model is fine for this unit;
  the as-built was already near-optimal under our constraints.

A per-equipment displacement table (as-built center → solver center, in
meters) follows, so you can see exactly which items the solver would move
and how far. Running it on `sample_unit` only sanity-checks the harness —
`sample_unit` pins just one item, so its "as-built" is the default (0, 0)
stack and always reports bucket (a). Point it at a real unit's CSVs for a
meaningful check.

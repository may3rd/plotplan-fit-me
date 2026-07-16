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

Describes the site rectangle and one or more pipe racks.

| column | meaning |
|---|---|
| `w`, `d` | site extent in meters (x, y) — only read from the first row |
| `rack_y` | y-coordinate of a rack spine's centerline |
| `rack_half` | half-width of that rack's corridor — equipment can't encroach within this + its own half-depth of the centerline |

One row = one rack spine, same "grouped rows" idea as `keepouts.csv`. A
single row is the original single-rack format, unchanged:

```
w,d,rack_y,rack_half
90,60,30,4
```

For more than one rack (parallel spines), add a row per rack — leave `w,d`
blank on the extra rows, they're ignored past the first:

```
w,d,rack_y,rack_half
90,80,30,4
,,70,4
```

Every connection routes via whichever rack gives it the shorter rise+drop
(the run-along-x term doesn't depend on which rack, so it never affects the
choice). Equipment can't encroach on *any* rack's corridor. Rack steel is
also costed: for each rack actually used by at least one connection, its
physical span (leftmost to rightmost x among the equipment routed onto it)
is added to the score at `RACK_STEEL_COST_PER_M` (a module constant in
`plotplan.py`, same units as piping weight×length) — more racks means more
steel to pay for, not a free lunch.

An optional `wind_dir` column (only read from the first row, like `w`/`d`)
sets the prevailing wind direction — `x+`, `x-`, `y+`, or `y-`, the side the
wind blows *from* (the upwind side of every fired heater). No equipment may
sit within `WIND_CLEARANCE_M` (a module constant in `plotplan.py`) of that
side of any `fired_heater`-class item — a hydrocarbon release there would
blow straight into the open flame. Leave the column blank or omit it for no
wind constraint (the original behavior):

```
w,d,rack_y,rack_half,wind_dir
90,80,30,4,x+
,,70,4,
```

That says wind blows from the east (`x+`): nothing may sit east of a fired
heater within the clearance distance.

### keepouts.csv — optional

Only needed if the site has exclusion zones. Rows sharing a `zone` name
form one polygon, vertices in the order given (it closes automatically —
don't repeat the first point).

| column | meaning |
|---|---|
| `zone` | polygon name — shared across rows to group vertices |
| `x`, `y` | one vertex |

**Roads and maintenance corridors are the same mechanism**, not a separate
file: name the zone starting with `ROAD` or `MAINT` and it draws on its own
DXF layer, but it's checked identically to any other keep-out.

If a unit has no exclusion zones, just don't create this file.

---

## Use case 1: the simplest possible unit

Two vessels, one pipe run, no pins, no keep-outs.

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
w,d,rack_y,rack_half
50,40,20,3
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

## Use case 4: a flare radius / underground line / blast contour

Add `keepouts.csv` with one polygon per zone. A rectangle needs 4 rows:

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

See `data/sample_unit/keepouts.csv` for a worked `UNDERGROUND` example.

---

## Use case 5: a road or maintenance corridor

Same file, same mechanism as use case 4 — just name the zone with a
`ROAD` or `MAINT` prefix so it draws on its own DXF layer:

```
zone,x,y
ROAD_main,0,50
ROAD_main,90,50
ROAD_main,90,56
ROAD_main,0,56
```

That's a road strip along the north edge of the site (also present in
`data/sample_unit/keepouts.csv`). Equipment still can't be placed on it — a
road is a keep-out from the solver's point of view.

---

## Use case 6: tube-pull / maintenance clearance

A heat exchanger needs a clear straight run in front of it to pull the tube
bundle for maintenance. Add `pull_side` and `pull_len` to that row:

```
tag,cls,w,d,x,y,pinned,pull_side,pull_len
E-102,exchanger,5,2,,,false,x+,6
```

This says: E-102 needs 6 meters of clear space extending from its `+x`
face. That swept rectangle must stay inside the site, clear of the rack
corridor, clear of every keep-out zone, and clear of every other piece of
equipment — nothing may sit in the pull path, even if it would otherwise
satisfy normal spacing rules.

`pull_side` is one of `x+`, `x-`, `y+`, `y-` (which face). Leave both
columns blank (or `pull_len` at 0) for equipment with no pull clearance.

This is also present on E-102 in `data/sample_unit/equipment.csv`.

---

## Use case 7: prevailing wind constraint

Add `wind_dir` to `site.csv` to keep equipment out of a fired heater's
upwind side:

```
w,d,rack_y,rack_half,wind_dir
90,80,30,4,x+
```

Wind blows from the east (`x+`) here, so no equipment may sit within
`WIND_CLEARANCE_M` east of any `fired_heater`-class item. Leave the column
blank for no wind constraint.

This is also present in `data/sample_unit/site.csv` (heater H-101, wind
from `x+`).

---

## Reading the outputs

### plotplan.dxf

Layers: `SITE` (boundary), `RACK` (pipe rack corridor), `EQUIPMENT` +
`TAGS` (footprints and labels), `KEEPOUT`/`ROADS`/`MAINT` (exclusion zones,
split by name prefix), `PULL` (tube-pull/maintenance swept rectangles),
`WIND` (fired heater upwind exclusion sectors).

### plotplan_takeoff.csv

A quantity takeoff for early cost estimation — every result is a plain
number, no formulas to unpick:

```
type,a,b,weight,length_m
pipe,H-101,C-101,3,25.47
pipe,C-101,E-101,2,21.09
...
rack_span_used,,y=30,,24.90
total_pipe_length_m,,,,197.08
```

- `pipe` rows: one per connection, with the rack-routed length (meters)
  between those two tags at the final positions — each routed via whichever
  rack spine is shortest for that connection.
- `rack_span_used`: one row per rack actually used by at least one
  connection, `b` identifying which rack (`y=<rack_y>`) and `length_m` the
  x-distance between the leftmost and rightmost equipment routed onto it —
  how much physical rack steel this layout actually needs (not the full
  site width, which is usually more than what's used). A single-rack site
  still gets exactly one such row.
- `total_pipe_length_m`: sum of all `pipe` row lengths (unweighted — this
  is meters of pipe, not the piping cost score).

## Common errors

- **`no feasible initial layout — site too small for spacing table`** — the
  site can't fit everything given the spacing rules and keep-outs. Enlarge
  the site or loosen spacing.
- **`pinned equipment violates site/spacing/keepout constraints on its
  own`** — two pinned items (or a pin and a keep-out zone, or a pin and
  another pin's pull-clearance path) conflict before the solver even starts
  moving anything. Fix the pin coordinates.
- Any `KeyError` on a CSV column name means a required column is missing or
  misspelled — check the tables above.

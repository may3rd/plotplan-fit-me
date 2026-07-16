# plotplan-fit-me

TestFit-style generative plot plan tool for refinery / petrochemical unit layout.
Generates spacing-compliant 2D equipment layouts ranked by rack-routed piping cost.

## Repo structure

```
plotplan-fit-me/
├── backend/          Python solver + CLI + FastAPI backend
│   ├── plotplan.py
│   ├── api.py          FastAPI app wrapping the solver (PLAN.md item 10)
│   ├── HELP.md         CSV format reference + simple use cases — start here
│   └── data/
│       └── sample_unit/   equipment.csv, connections.csv, spacing.csv,
│                          site.csv, keepouts.csv
├── frontend/         React + Vite UI — drag equipment, live score, Solve
├── README.md          this file
├── PLAN.md            build order + status
└── CLAUDE.md          working conventions + self-learning log
```

The CLI and CSV workflow in `backend/` is still the primary way to run a
real unit end-to-end (DXF + takeoff export); the web UI in `frontend/` is
for interactively exploring/solving a layout in a browser — see
`frontend/README.md` to run it.

**New to the CSV files?** Read `backend/HELP.md` — it covers every column
and walks through worked examples from a bare layout up to pinned
equipment, keep-out zones, roads, and tube-pull clearance.

## Run it

```
cd backend
python plotplan.py                 # sample_unit, seed 0
python plotplan.py 7                # sample_unit, seed 7
python plotplan.py 0:20             # sample_unit, rank seeds 0-19, keep the best
python plotplan.py data/my_unit 3   # any unit dir, any seed
```

Writes `plotplan.dxf` and `plotplan_takeoff.csv`. A `start:end` seed range
prints a ranked score table and writes only the best-scoring layout. Stdlib
only — no installs.

## A unit's data

```
equipment.csv     tag,cls,w,d[,x,y,pinned,pull_side,pull_len]   required
connections.csv   a,b,weight                                     required
spacing.csv       cls_a,cls_b,min_gap                             required
site.csv          w,d,rack_y,rack_half,wind_dir (1+ rows = 1+ racks) required
keepouts.csv      zone,x,y                                         optional
```

Full column reference and worked examples: `backend/HELP.md`. Working
reference dataset: `backend/data/sample_unit/`.

## Features (v1 — done)

- **Spacing matrix** — edge-to-edge min clearances per equipment-class pair
  (GAP.2.5.2-style placeholder data; swap in company spacing table). Hard constraint.
- **Site + pipe rack(s)** — rectangular site, one or more parallel
  horizontal rack spines, each corridor a keep-out for equipment.
- **Piping cost objective** — Σ weight × Manhattan route via the nearest
  rack spine (rise + run-along-rack + drop), plus the physical steel span
  of every rack actually used. Weight ≈ line count × size factor.
- **Solver** — simulated annealing over feasible moves, seeded/reproducible,
  reject-infeasible. Handles ~10–30 equipment items.
- **DXF R12 export** — layers SITE / RACK / EQUIPMENT / TAGS / KEEPOUT /
  ROADS / MAINT / PULL. Opens in AutoCAD.
- **CSV data loading** — a unit is a folder of CSVs, loaded via `load_unit()`.
- **Multi-seed ranking** — run a seed range, get a sorted score table, best one wins.
- **Pinned equipment** — fix any item's position; solver optimizes the rest.
- **Polygon keep-outs** — named zones (flare radius, blast contours,
  underground, drainage) that no equipment footprint may overlap.
- **Roads / maintenance corridors** — same keep-out zones, name-prefix
  convention (`ROAD*` / `MAINT*`) picks the DXF layer.
- **Tube-pull clearance** — a swept rectangle attached to one side of an
  item that must stay clear of the rack, other equipment, and keep-out zones.
- **Quantity takeoff CSV** — per-connection pipe length, per-rack span used,
  total pipe length, written next to the DXF.
- **Equipment rotation** — SA can rotate any movable item 90° (swap w/d).
- **Prevailing wind constraint** — optional `wind_dir` on the site keeps
  equipment out of a fired heater's upwind sector.
- **Self-check** — every result re-verified against the spacing matrix,
  keep-out zones, pull clearances, exact pinned position, and takeoff-vs-score
  consistency, by assert.
- **Web UI** — FastAPI backend (`backend/api.py`) wrapping the solver +
  React/Vite frontend: drag equipment with live feasibility/score feedback,
  or click Solve to run the CLI's seed-ranking solver in the browser. See
  `frontend/README.md`.

## Nice to have (see PLAN.md for build order)

1. CP-SAT / MILP solver (only if SA stalls on >30 items)

## Non-goals for now

3D, ML, terrain/cut-fill, detailed pipe routing (that's a routing tool, not a
plot plan tool), cost database integration.

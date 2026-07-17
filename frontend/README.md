# frontend

React + Vite UI for plotplan-fit-me, laid out like an Office-style app:
menu bar, a tabbed ribbon, a zoomable/pannable canvas, and a status bar.
Pick a unit, drag equipment with live feasibility/score feedback, or Solve
to lay it out automatically.

Plain SVG for the plot (no canvas/chart library), native `fetch` for API
calls, no state library. The chrome uses [shadcn/ui](https://ui.shadcn.com)
(radix-nova style) on Tailwind CSS v4 — `Menubar`, `Tabs`, `Select`,
`Input`, `Button`, `Badge`, `ToggleGroup` in `src/components/ui/`, config in
`components.json`. The SVG plot stays hand-rolled; shadcn has no primitives
for it.

Structure: `App.jsx` owns state and composes `Ribbon` (menu + ribbon tabs),
`PlotCanvas` (SVG + rulers + grid + zoom/pan), and `StatusBar`. The
viewBox/zoom/pan math lives in `src/lib/view.js` as pure functions with a
runnable check (`node src/lib/view.test.js`).

## Run it

Backend (from `backend/`, first `python3 -m venv .venv && .venv/bin/pip
install -r requirements.txt` if you haven't):

```
backend/.venv/bin/uvicorn api:app --reload --port 8000 --app-dir backend
```

Frontend (from `frontend/`, first `npm install`):

```
npm run dev
```

Open the printed localhost URL (default `http://localhost:5173`). The Vite
dev server proxies `/api/*` to `http://127.0.0.1:8000` (see
`vite.config.js`) so the two servers just need to both be running.

## What it does

- **Menu bar** — File (New/Open/Save/Save As, Export submenu, Solve, Fit to
  view), View (toggle Grid/Rulers, zoom), Help. Mirrors the ribbon's actions
  for keyboard/menu users.
- **Ribbon** — *Home* tab: case-study picker (`GET /api/units`), seed input,
  Solve, and a Results button (seed/score table) once a solve has run.
  *View* tab: a Word-style Zoom dialog + fit-width, Grid/Rulers toggles,
  grid/ruler spacing override, a Select/Pan tool switch, and a Snap-to-grid
  toggle.
- **Canvas** — SVG rendering of the site boundary, pipe-rack corridor(s)
  (labeled, hatched), keep-out/road/maintenance zones (labeled), pull- and
  wind-clearance zones, connections, and equipment (colored by spacing
  class), north-up. Mouse-wheel zooms toward the cursor; the Pan tool (or
  middle-drag) pans. Optional metre grid and rulers (major + minor ticks) on
  both axes, which track zoom/pan. The viewBox aspect always matches the
  canvas so equipment shapes stay true.
- **Drag to test** — with the Select tool, drag any non-pinned equipment;
  every move posts to `POST /api/score` and the score updates live,
  flipping to "infeasible" the moment a move breaks
  spacing/keep-out/rack/pull/wind. A live dashed measurement line shows the
  distance to the most spacing-critical neighbor, turning red (and
  outlining the dragged item) once it's under the required gap. Pinned
  equipment (dashed) can't be moved.
- **Solve** — runs `POST /api/solve` with a seed or `a:b` range (same syntax
  as the CLI) and snaps equipment to the winning layout.
- **Project files** — File > New starts a blank project; Open loads a
  `.json` project file (see `src/lib/project.js`); Save/Save As download the
  current project (including live equipment positions) as `.json`. A
  project is fully self-contained — Score/Solve/Export all operate on
  whatever's currently loaded, not a named backend unit, so an
  opened/hand-edited project never needs to exist under `backend/data/`.
- **Export** — DXF and takeoff CSV come from the backend
  (`POST /api/export/dxf` / `/api/export/takeoff`); PNG/JPG are rasterized
  client-side from the live SVG (`src/lib/raster.js`), no backend round-trip.
- **Status bar** — project name (open filename if one's set), feasibility/
  score, live cursor coordinates (m), active tool, and zoom percent.

## API shape

`GET /api/units` / `GET /api/units/{name}` read a case study from
`backend/data/{name}/` CSVs — that's the only thing tied to on-disk units,
used to seed a project's *starting* state. Every mutating endpoint
(`POST /api/score`, `/api/solve`, `/api/export/dxf`, `/api/export/takeoff`)
takes the full case study inline in the request body (`{ data: {...} }`,
same shape `GET /api/units/{name}` returns) instead of a unit name — see
`backend/api.py`'s `CaseData` model.

## Not built (out of scope for this pass)

Editing CSVs from the UI, adding/removing equipment from a blank (File >
New) project via the canvas, PDF export, and any per-violation detail
beyond the single feasible/infeasible flag — `backend/api.py`'s `/score`
endpoint only returns a bool, not which constraint failed.

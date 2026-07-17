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

- **Menu bar** — File (Solve, Fit to view), View (toggle Grid/Rulers, zoom),
  Help. Mirrors the ribbon's actions for keyboard/menu users.
- **Ribbon** — *Home* tab: unit picker (`GET /api/units`), seed input, Solve.
  *View* tab: zoom in/out/fit, Grid and Rulers toggles, and a Select/Pan
  tool switch.
- **Canvas** — SVG rendering of the site boundary, rack corridor(s),
  keep-out/road/maintenance zones, connections, and equipment (colored by
  spacing class), north-up. Mouse-wheel zooms toward the cursor; the Pan
  tool (or middle-drag) pans. Optional metre grid and rulers on both axes,
  which track zoom/pan. The viewBox aspect always matches the canvas so
  equipment shapes stay true.
- **Drag to test** — with the Select tool, drag any non-pinned equipment;
  every move posts to `POST /api/units/<name>/score` and the score updates
  live, flipping to "infeasible" the moment a move breaks
  spacing/keep-out/rack/pull/wind. Pinned equipment (dashed) can't be moved.
- **Solve** — runs `POST /api/units/<name>/solve` with a seed or `a:b`
  range (same syntax as the CLI) and snaps equipment to the winning layout.
- **Status bar** — unit, feasibility/score, live cursor coordinates (m),
  active tool, and zoom percent.

## Not built (out of scope for this pass)

Editing CSVs from the UI, saving a dragged layout back to disk, exporting
DXF/takeoff from the browser (use the CLI for that), and any per-violation
detail beyond the single feasible/infeasible flag — `backend/api.py`'s
`/score` endpoint only returns a bool, not which constraint failed.

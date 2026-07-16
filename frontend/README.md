# frontend

React + Vite UI for plotplan-fit-me: pick a unit, drag equipment around
with live feasibility/score feedback from the backend, or click Solve to
run the simulated-annealing solver and lay it out automatically.

No build tooling beyond Vite/React itself — plain SVG for the plot (no
canvas/chart library), native `fetch` for API calls, no state library
(the whole UI is one component's `useState`).

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

- **Unit picker** — lists `backend/data/*` folders via `GET /api/units`.
- **Plot view** — SVG rendering of the site boundary, rack corridor(s),
  keep-out/road/maintenance zones, connections, and equipment (colored by
  spacing class), north-up.
- **Drag to test** — drag any non-pinned equipment; every move posts the
  current positions to `POST /api/units/<name>/score` and the header shows
  the live piping-cost score, or "infeasible layout" the moment a move
  breaks spacing/keep-out/rack/pull/wind constraints. Pinned equipment
  (dashed outline) can't be dragged.
- **Solve** — runs `POST /api/units/<name>/solve` with a seed or `a:b`
  seed range (same syntax as the CLI) and snaps equipment to the winning
  layout.

## Not built (out of scope for this pass)

Editing CSVs from the UI, saving a dragged layout back to disk, exporting
DXF/takeoff from the browser (use the CLI for that), and any per-violation
detail beyond the single feasible/infeasible flag — `backend/api.py`'s
`/score` endpoint only returns a bool, not which constraint failed.

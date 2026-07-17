"""FastAPI backend wrapping the plotplan solver.

GET /api/units[/{name}] read a starting case study from data/<name>/ CSVs —
that's the only thing tied to on-disk units. Everything that scores, solves,
or exports a layout (POST /api/score, /api/solve, /api/export/*) takes the
FULL case study inline in the request body instead of a unit name, so a
project loaded from (or never backed by) a CSV folder — e.g. a saved/opened
.json project file in the frontend — can be scored/solved/exported exactly
the same way. Still stateless: nothing is written to disk except the
temp file each export briefly uses to reuse write_dxf()/write_takeoff().

Run: uvicorn api:app --reload --port 8000
"""
import os
import tempfile
from dataclasses import asdict

from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from plotplan import (
    CPSAT_THRESHOLD,
    Equipment,
    Site,
    WIND_CLEARANCE_M,
    feasible,
    load_unit,
    piping_cost,
    solve,
    solve_cpsat,
    write_dxf,
    write_takeoff,
)

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

app = FastAPI(title="plotplan-fit-me API")
# ponytail: single-user local dev tool, no auth model yet — wide open CORS
# is fine for a Vite dev server on localhost. Tighten if this ever leaves
# a developer's machine.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def _unit_dir(name: str) -> str:
    path = os.path.join(DATA_DIR, name)
    if not os.path.isdir(path):
        raise HTTPException(404, f"unknown unit: {name}")
    return path


@app.get("/api/units")
def list_units():
    return sorted(d for d in os.listdir(DATA_DIR) if os.path.isdir(os.path.join(DATA_DIR, d)))


@app.get("/api/units/{name}")
def get_unit(name: str):
    eq, conns, spacing, site, keepouts = load_unit(_unit_dir(name))
    return {
        "name": name,
        "equipment": [asdict(e) for e in eq],
        "connections": [{"a": a, "b": b, "weight": w} for a, b, w in conns],
        "site": asdict(site),
        "keepouts": keepouts,
        "spacing": [{"a": a, "b": b, "gap": g} for (a, b), g in spacing.items()],
        "wind_clearance_m": WIND_CLEARANCE_M,
    }


# ------------------------------------------------------- inline case data

class EquipmentIn(BaseModel):
    tag: str
    cls: str
    w: float
    d: float
    x: float = 0.0
    y: float = 0.0
    pinned: bool = False
    pull_side: str = ""
    pull_len: float = 0.0


class ConnectionIn(BaseModel):
    a: str
    b: str
    weight: float


class SpacingEntryIn(BaseModel):
    a: str
    b: str
    gap: float


class SiteIn(BaseModel):
    w: float
    d: float
    wind_dir: str = ""


class CaseData(BaseModel):
    """The full self-contained shape of a project — same fields GET
    /api/units/{name} returns, minus wind_clearance_m (that's a fixed
    backend constant, not per-project data). Pipe racks are just a
    `keepouts` zone named RACK* (see plotplan._rack_zones()) — no separate
    field, same as roads/maintenance corridors."""
    name: str = "layout"
    equipment: list[EquipmentIn]
    connections: list[ConnectionIn] = []
    site: SiteIn
    keepouts: dict[str, list[list[float]]] = {}
    spacing: list[SpacingEntryIn] = []


def _build_case(data: CaseData):
    """CaseData -> the (eq, conns, spacing, site, keepouts) tuple every
    plotplan.py function expects. Kept fresh per call (never reused across
    solve() seeds) since solve()/solve_cpsat() mutate Equipment in place —
    same reload-per-seed rule load_unit()-based code follows."""
    eq = [Equipment(**e.dict()) for e in data.equipment]
    conns = [(c.a, c.b, c.weight) for c in data.connections]
    spacing = {(s.a, s.b): s.gap for s in data.spacing}
    site = Site(data.site.w, data.site.d, data.site.wind_dir)
    keepouts = {zone: [(p[0], p[1]) for p in poly] for zone, poly in data.keepouts.items()}
    return eq, conns, spacing, site, keepouts


class ScoreRequest(BaseModel):
    data: CaseData


@app.post("/api/score")
def score_data(req: ScoreRequest):
    """Score a layout (e.g. after dragging an item in the UI) — positions
    already live in req.data.equipment, nothing is overlaid."""
    eq, conns, spacing, site, keepouts = _build_case(req.data)
    ok = feasible(eq, site, spacing, keepouts)
    return {"feasible": ok, "cost": piping_cost(eq, conns, site, keepouts) if ok else None}


class SolveRequest(BaseModel):
    data: CaseData
    seeds: list[int] = [0]


@app.post("/api/solve")
def solve_data(req: SolveRequest):
    """Same ranking loop as plotplan.solve_ranked(), but building each
    seed's Equipment list fresh from the posted CaseData instead of
    reloading CSVs from disk."""
    results = []
    best = None  # (cost, eq)
    for seed in req.seeds:
        eq, conns, spacing, site, keepouts = _build_case(req.data)
        movable = sum(1 for e in eq if not e.pinned)
        if movable > CPSAT_THRESHOLD:
            cost = solve_cpsat(eq, conns, site, spacing, keepouts, seed=seed)
        else:
            cost = solve(eq, conns, site, spacing, keepouts, seed=seed)
        results.append((seed, cost))
        if best is None or cost < best[0]:
            best = (cost, eq)
    results.sort(key=lambda r: r[1])
    return {
        "results": [{"seed": s, "cost": c} for s, c in results],
        "cost": best[0],
        "equipment": [asdict(e) for e in best[1]],
    }


@app.post("/api/export/dxf")
def export_dxf(req: ScoreRequest):
    eq, conns, spacing, site, keepouts = _build_case(req.data)
    fd, path = tempfile.mkstemp(suffix=".dxf")
    os.close(fd)
    try:
        write_dxf(path, eq, site, keepouts)
        with open(path, "rb") as f:
            content = f.read()
    finally:
        os.unlink(path)
    return Response(
        content=content,
        media_type="application/dxf",
        headers={"Content-Disposition": f'attachment; filename="{req.data.name}.dxf"'},
    )


@app.post("/api/export/takeoff")
def export_takeoff(req: ScoreRequest):
    eq, conns, spacing, site, keepouts = _build_case(req.data)
    fd, path = tempfile.mkstemp(suffix=".csv")
    os.close(fd)
    try:
        write_takeoff(path, eq, conns, site, keepouts)
        with open(path, "rb") as f:
            content = f.read()
    finally:
        os.unlink(path)
    return Response(
        content=content,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{req.data.name}_takeoff.csv"'},
    )

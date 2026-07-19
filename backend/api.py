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
import asyncio
import json
import os
import tempfile
from dataclasses import asdict

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from plotplan import (
    Equipment,
    Site,
    WIND_CLEARANCE_M,
    feasible,
    load_unit,
    piping_cost,
    push_repair,
    solve,
    solve_one,
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


class RelaxRequest(BaseModel):
    data: CaseData
    tag: str          # the equipment being dragged
    x: float          # its new (cursor) position
    y: float
    iters: int = 3000  # short + cool vs. a full solve — reflow, not re-optimize
    t0: float = 3.0


@app.post("/api/relax")
def relax(req: RelaxRequest):
    """PLAN.md item 16 — Mode 2's core: reflow the rest of the layout
    around one dragged item. Pins `tag` at (x, y) for this call only (the
    posted CaseData's own pinned flags are otherwise untouched — this is a
    fresh in-memory copy, nothing written back), then runs a short, cool SA
    warm-started from every OTHER item's current position (no
    random_place) so a drag reads as a live nudge, not a fresh solve.
    Stateless like /score: nothing persists between calls, the frontend
    re-posts the whole current layout each time.
    If the dragged position violates spacing against a neighbor, item 17's
    push_repair() first legalizes by shoving movable neighbors aside
    (capped iteration count) — the common "dropped into a packed row"
    case — before the SA refine runs. If push_repair can't legalize within
    its cap (or the drop is infeasible for a reason it doesn't attempt to
    fix, e.g. landing in a keepout zone), this returns {feasible: false}
    honestly rather than looping further or trusting a broken layout."""
    eq, conns, spacing, site, keepouts = _build_case(req.data)
    by_tag = {e.tag: e for e in eq}
    if req.tag not in by_tag:
        raise HTTPException(404, f"unknown equipment tag: {req.tag}")
    dragged = by_tag[req.tag]
    dragged.x, dragged.y, dragged.pinned = req.x, req.y, True
    if not feasible(eq, site, spacing, keepouts) and not push_repair(eq, site, spacing, keepouts):
        return {"feasible": False, "cost": None, "equipment": [asdict(e) for e in eq]}
    cost = solve(eq, conns, site, spacing, keepouts, seed=0, iters=req.iters, t0=req.t0, warm_start=True)
    return {"feasible": True, "cost": cost, "equipment": [asdict(e) for e in eq]}


class SolveRequest(BaseModel):
    data: CaseData
    seeds: list[int] = [0]


@app.post("/api/solve")
def solve_data(req: SolveRequest, request: Request):
    """Same ranking loop as plotplan.solve_ranked(), but building each
    seed's Equipment list fresh from the posted CaseData instead of
    reloading CSVs from disk. Streams a `progress` SSE event per seed-start
    and an `improve` event every time that seed's SA finds a new best
    (PLAN.md item 18 — an anytime stream: the frontend can plot a live
    score curve instead of just a %-done bar), then a final `done` event
    with the result. `done`'s `cases` field carries every seed's own full
    layout (not just the winner's, which is also duplicated at the
    top-level `equipment` field for convenience) so the frontend can let a
    user browse/preview each case, not only the best one.
    ponytail: a background thread runs the blocking solver while the
    request thread yields SSE chunks from a queue — FastAPI's
    StreamingResponse drives the SSE wire format, the thread + queue
    bridge the sync solver to the async stream. No async rewrite of
    plotplan.py needed. The stream loop polls the queue instead of
    blocking on it so it can also poll request.is_disconnected() — a
    closed connection (the frontend's Stop button, or just navigating
    away) sets stop_event, which solve()'s should_stop checks every
    iteration and returns the best-so-far (always feasible — see
    solve()'s docstring) instead of running to completion pointlessly.
    """
    import queue as _q
    import threading

    q: _q.Queue = _q.Queue()
    stop_event = threading.Event()

    def emit(kind, payload=None):
        q.put({"event": kind, "data": json.dumps(payload) if payload is not None else ""})

    def worker():
        try:
            n = len(req.seeds)
            results = []
            cases = []  # every seed's own full layout, not just the winner — lets the
                        # frontend let a user browse/preview each case, not just the best
            best = None  # (cost, eq)
            for i, seed in enumerate(req.seeds):
                if stop_event.is_set():
                    break
                emit("progress", {"fraction": i / n, "seed": seed, "seed_index": i, "seed_count": n})
                eq, conns, spacing, site, keepouts = _build_case(req.data)

                def on_improve(cost, positions, k, _seed=seed, _i=i):
                    emit("improve", {"seed": _seed, "seed_index": _i, "iteration": k, "cost": cost,
                                     "equipment": [{"tag": t, "x": x, "y": y, "w": w, "d": d, "pull_side": p}
                                                   for t, x, y, w, d, p in positions]})

                cost = solve_one(eq, conns, site, spacing, keepouts, seed=seed,
                                 on_improve=on_improve, should_stop=stop_event.is_set)
                results.append((seed, cost))
                cases.append({"seed": seed, "cost": cost, "equipment": [asdict(e) for e in eq]})
                if best is None or cost < best[0]:
                    best = (cost, eq)
            if best is None:
                emit("error", {"message": "stopped before any seed finished"})
                return
            results.sort(key=lambda r: r[1])
            cases.sort(key=lambda c: c["cost"])
            emit("done", {
                "results": [{"seed": s, "cost": c} for s, c in results],
                "cost": best[0],
                "equipment": [asdict(e) for e in best[1]],
                "stopped": stop_event.is_set(),
                "cases": cases,
            })
        except Exception as e:  # ponytail: surface solver errors to the UI instead of a hung stream
            emit("error", {"message": str(e)})
        finally:
            q.put(None)  # sentinel: stream ends here

    threading.Thread(target=worker, daemon=True).start()

    async def stream():
        while True:
            if await request.is_disconnected():
                stop_event.set()
            try:
                msg = q.get_nowait()
            except _q.Empty:
                await asyncio.sleep(0.05)
                continue
            if msg is None:
                break
            yield f"event: {msg['event']}\ndata: {msg['data']}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


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

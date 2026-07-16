"""FastAPI backend wrapping the plotplan solver — read units, solve them,
and score a live (possibly user-dragged) layout. Stateless: a "unit" is
always read fresh from its data/<name>/ CSV folder, no database.

Run: uvicorn api:app --reload --port 8000
"""
import os
from dataclasses import asdict

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from plotplan import feasible, load_unit, piping_cost, solve_ranked

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
        "equipment": [asdict(e) for e in eq],
        "connections": [{"a": a, "b": b, "weight": w} for a, b, w in conns],
        "site": asdict(site),
        "keepouts": keepouts,
    }


class SolveRequest(BaseModel):
    seeds: list[int] = [0]


@app.post("/api/units/{name}/solve")
def solve_unit(name: str, req: SolveRequest):
    results, best = solve_ranked(_unit_dir(name), req.seeds)
    cost, eq, conns, site, keepouts = best
    return {
        "results": [{"seed": s, "cost": c} for s, c in results],
        "cost": cost,
        "equipment": [asdict(e) for e in eq],
    }


class LayoutEquipment(BaseModel):
    tag: str
    x: float
    y: float


class ScoreRequest(BaseModel):
    equipment: list[LayoutEquipment]


@app.post("/api/units/{name}/score")
def score_unit(name: str, req: ScoreRequest):
    """Score a caller-supplied layout (e.g. after dragging an item in the
    UI) against the unit's own equipment/spacing/keepouts — everything
    except position comes from the CSVs, only x/y are overridden."""
    eq, conns, spacing, site, keepouts = load_unit(_unit_dir(name))
    by_tag = {e.tag: e for e in eq}
    for item in req.equipment:
        if item.tag not in by_tag:
            raise HTTPException(400, f"unknown equipment tag: {item.tag}")
        by_tag[item.tag].x, by_tag[item.tag].y = item.x, item.y
    ok = feasible(eq, site, spacing, keepouts)
    return {"feasible": ok, "cost": piping_cost(eq, conns, site) if ok else None}

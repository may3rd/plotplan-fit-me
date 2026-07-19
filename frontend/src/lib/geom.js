// Pure spacing/footprint math for the plot canvas — a JS mirror of the
// backend's edge_gap/min_gap/_side_rect (backend/plotplan.py). Kept as an
// independent implementation (not shared code) so the live drag readout
// needs no round-trip to /score; same reasoning as write_takeoff() vs
// piping_cost() in plotplan.py — two small independent implementations
// plus a runnable check catch drift better than one shared function would.

/** Edge-to-edge distance between two axis-aligned boxes {x, y, w, d}
 * (center + full width/depth), 0 if they overlap. Mirrors edge_gap(). */
export function edgeGap(a, b) {
  const dx = Math.max(0, Math.abs(a.x - b.x) - (a.w + b.w) / 2)
  const dy = Math.max(0, Math.abs(a.y - b.y) - (a.d + b.d) / 2)
  return Math.hypot(dx, dy)
}

/** Build a `"clsA|clsB"` (both directions) lookup from the unit's
 * `spacing` array (`[{a, b, gap}, ...]`, as returned by GET /api/units/:name). */
export function buildSpacingMap(spacing) {
  const m = new Map()
  for (const { a, b, gap } of spacing ?? []) {
    m.set(`${a}|${b}`, gap)
    m.set(`${b}|${a}`, gap)
  }
  return m
}

/** Required gap between two spacing classes, 3m default. Mirrors min_gap(). */
export function minGap(clsA, clsB, spacingMap) {
  return spacingMap.get(`${clsA}|${clsB}`) ?? 3.0
}

// closest point on each axis between intervals [a1,a2] and [b1,b2]: touching
// ends of the gap if disjoint, else the midpoint of their overlap.
function axisClosest(a1, a2, b1, b2) {
  if (a2 < b1) return [a2, b1]
  if (b2 < a1) return [a1, b2]
  const mid = (Math.max(a1, b1) + Math.min(a2, b2)) / 2
  return [mid, mid]
}

/** The two closest points (one on each box's boundary) between boxes
 * {x, y, w, d} `a` and `b` — for drawing a measurement line. The distance
 * between them equals edgeGap(a, b). */
export function closestPoints(a, b) {
  const [ax1, ax2, ay1, ay2] = [a.x - a.w / 2, a.x + a.w / 2, a.y - a.d / 2, a.y + a.d / 2]
  const [bx1, bx2, by1, by2] = [b.x - b.w / 2, b.x + b.w / 2, b.y - b.d / 2, b.y + b.d / 2]
  const [pax, pbx] = axisClosest(ax1, ax2, bx1, bx2)
  const [pay, pby] = axisClosest(ay1, ay2, by1, by2)
  return [[pax, pay], [pbx, pby]]
}

/** Among all other equipment, the one most critical to `tag` (the dragged
 * item) — minimum (gap - required gap), so a violation always wins over a
 * merely-nearby item that already clears its own smaller requirement.
 * `positions` overrides x/y per tag (live drag state), falling back to the
 * equipment's own x/y. Returns null if `tag` isn't found. */
export function closestPair(tag, positions, equipment, spacingMap) {
  const box = (e) => {
    const p = positions[e.tag] ?? { x: e.x, y: e.y }
    return { x: p.x, y: p.y, w: e.w, d: e.d }
  }
  const me = equipment.find((e) => e.tag === tag)
  if (!me) return null
  const a = box(me)
  let best = null
  for (const other of equipment) {
    if (other.tag === tag) continue
    const b = box(other)
    const gap = edgeGap(a, b)
    const need = minGap(me.cls, other.cls, spacingMap)
    const score = gap - need
    if (!best || score < best.score) {
      best = { other: other.tag, gap, need, score, points: closestPoints(a, b) }
    }
  }
  return best
}

/** Footprint corners [x1, y1, x2, y2] of equipment `e` at position `pos`
 * ({x, y}, defaults to e's own x/y). Mirrors _footprint(). */
export function footprint(e, pos) {
  const p = pos ?? { x: e.x, y: e.y }
  return [p.x - e.w / 2, p.y - e.d / 2, p.x + e.w / 2, p.y + e.d / 2]
}

/** Rectangle of `length` extending outward from one side ("x+"/"x-"/"y+"/"y-")
 * of a footprint, or null if side/length is empty. Mirrors _side_rect(). */
export function sideRect(x1, y1, x2, y2, side, length) {
  if (!side || length <= 0) return null
  switch (side) {
    case 'x+': return [x2, y1, x2 + length, y2]
    case 'x-': return [x1 - length, y1, x1, y2]
    case 'y+': return [x1, y2, x2, y2 + length]
    case 'y-': return [x1, y1 - length, x2, y1]
    default: return null
  }
}

// Rotating a footprint 90deg clockwise cycles a direction the same way a
// compass needle would: x+ -> y- -> x- -> y+ -> x+. Used to keep pull_side
// pointing the same way relative to the equipment after a manual rotate.
// `rotatePointCW` mirrors the backend's `_rotate_point_cw` for a nozzle
// offset — one CW step maps (dx, dy) -> (dy, -dx). The backend's SA rotate
// and CP-SAT decode both rotate pull_side and the nozzle offset alongside
// w/d; the frontend's manual rotate (rotateEquipment) must too, so the
// rendered tie-in point and the backend's cost stay in sync after a click.
const ROTATE_CW = { 'x+': 'y-', 'y-': 'x-', 'x-': 'y+', 'y+': 'x+' }

/** `side` ("x+"/"x-"/"y+"/"y-"/"") rotated `deg` (90/180/270) clockwise. */
export function rotateSide(side, deg) {
  let s = side
  for (let i = 0; i < (deg / 90) % 4; i++) s = ROTATE_CW[s] ?? s
  return s
}

/** A 2D offset (dx, dy) rotated `deg` (90/180/270) clockwise. */
export function rotatePointCW(dx, dy, deg) {
  let x = dx, y = dy
  for (let i = 0; i < (deg / 90) % 4; i++) { [x, y] = [y, -x] }
  return [x, y]
}

// Rotate a polygon (array of [x, y] world points) `deg` (90/180/270)
// clockwise about its centroid. 180° is the degenerate case: vertices map
// onto each other in reverse order, so re-rotate the first vertex by an
// extra 90° and reverse the list to keep the polygon's winding (and thus
// its on-canvas outline direction) stable — otherwise a 180°-rotated
// rect would render identical to its unrotated self but with a flipped
// SVG path direction, which is invisible for a plain fill but can matter
// for stroke-dash/merge outlines. For 90°/270° the per-vertex rotation
// already preserves order.
export function rotatePolyCW(poly, deg) {
  if (!poly?.length) return poly
  const steps = (deg / 90) % 4
  if (steps === 0) return poly
  const cx = poly.reduce((s, [x]) => s + x, 0) / poly.length
  const cy = poly.reduce((s, [, y]) => s + y, 0) / poly.length
  const rot = ([x, y]) => {
    let nx = x, ny = y
    for (let i = 0; i < steps; i++) { const ox = nx; nx = cx + (ny - cy); ny = cy - (ox - cx) }
    return [nx, ny]
  }
  const out = poly.map(rot)
  if (steps === 2) out.reverse()
  return out
}

// ---- snapping ---------------------------------------------------------------
// Pure snap helpers for the drag interaction (PlotCanvas). Each returns a
// snapped point {x, y, kind} or null (no snap within threshold). `kind` tells
// the indicator what color to draw. The drag handler composes them in
// priority order (object > grid > border — an object near a grid line wins
// because the user put it there on purpose) and the indicator shows the
// winning snap's kind. Callers read `snap.{grid,objects,borders}` to decide
// which helpers to run; Alt/Shift modifier is handled at the call site, not
// here, so the helpers stay pure and testable in isolation.

/** Snap (x, y) to the nearest grid tick at `step` on each axis. */
export function snapToGrid(x, y, stepX, stepY) {
  if (!stepX || !stepY) return null
  return {
    x: Math.round(x / stepX) * stepX,
    y: Math.round(y / stepY) * stepY,
    kind: 'grid',
  }
}

/** Snap (x, y) to the nearest of a list of candidate points within `thresh`
 * (world meters). `candidates` is an array of [x, y] (e.g. every equipment
 * center + every zone vertex). Returns null if none are within thresh. */
export function snapToObject(x, y, candidates, thresh) {
  let best = null
  let bestD = Infinity
  for (const [cx, cy] of candidates) {
    const d = Math.hypot(cx - x, cy - y)
    // strict < keeps the FIRST-seen candidate on a tie (deterministic by
    // input order — equipment centers before zone vertices), rather than
    // letting a later equal-distance one overwrite.
    if (d <= thresh && d < bestD) {
      best = { x: cx, y: cy, kind: 'object' }
      bestD = d
    }
  }
  return best
}

/** Snap (x, y) to the nearest site border (low/high on each axis) within
 * `thresh`. Independent per axis so a point near the west border but far
 * from north/south still snaps to x=low while keeping its y. Returns the
 * snapped point or null if neither axis is in range. */
export function snapToBorder(x, y, w, d, thresh) {
  let nx = x, ny = y, snapped = false
  if (Math.abs(x - 0) < thresh) { nx = 0; snapped = true }
  else if (Math.abs(x - w) < thresh) { nx = w; snapped = true }
  if (Math.abs(y - 0) < thresh) { ny = 0; snapped = true }
  else if (Math.abs(y - d) < thresh) { ny = d; snapped = true }
  return snapped ? { x: nx, y: ny, kind: 'border' } : null
}

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
// pointing the same way relative to the equipment after a manual rotate
// (unlike solve()'s SA rotate move, which only swaps w/d and leaves
// pull_side untouched — fine there since SA never rotates a pulled item's
// meaning, only its bounding box).
const ROTATE_CW = { 'x+': 'y-', 'y-': 'x-', 'x-': 'y+', 'y+': 'x+' }

/** `side` ("x+"/"x-"/"y+"/"y-"/"") rotated `deg` (90/180/270) clockwise. */
export function rotateSide(side, deg) {
  let s = side
  for (let i = 0; i < (deg / 90) % 4; i++) s = ROTATE_CW[s] ?? s
  return s
}

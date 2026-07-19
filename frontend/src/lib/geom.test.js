// Runnable check for geom.js. No framework: `node src/lib/geom.test.js`.
import assert from 'node:assert'
import { edgeGap, buildSpacingMap, minGap, closestPoints, closestPair, footprint, sideRect,
  snapToGrid, snapToObject, snapToBorder } from './geom.js'

// edgeGap: touching boxes -> 0, separated -> straight gap, diagonal -> hypot
assert.equal(edgeGap({ x: 0, y: 0, w: 4, d: 4 }, { x: 4, y: 0, w: 4, d: 4 }), 0) // touching
assert.equal(edgeGap({ x: 0, y: 0, w: 4, d: 4 }, { x: 10, y: 0, w: 4, d: 4 }), 6) // 10-2-2=6 gap
assert.equal(edgeGap({ x: 0, y: 0, w: 4, d: 4 }, { x: 2, y: 2, w: 2, d: 2 }), 0) // overlapping
assert.equal(
  edgeGap({ x: 0, y: 0, w: 2, d: 2 }, { x: 4, y: 4, w: 2, d: 2 }),
  Math.hypot(2, 2), // diagonal gap
)

// buildSpacingMap + minGap: both directions covered, unlisted pair falls back to 3.0
const spacing = [{ a: 'fired_heater', b: 'column', gap: 15 }, { a: 'column', b: 'column', gap: 3 }]
const sm = buildSpacingMap(spacing)
assert.equal(minGap('fired_heater', 'column', sm), 15)
assert.equal(minGap('column', 'fired_heater', sm), 15)
assert.equal(minGap('column', 'column', sm), 3)
assert.equal(minGap('pump_hc', 'pump_hc', sm), 3.0) // default fallback

// closestPoints: distance between the two returned points equals edgeGap
for (const [a, b] of [
  [{ x: 0, y: 0, w: 4, d: 4 }, { x: 10, y: 0, w: 4, d: 4 }], // separated on x
  [{ x: 0, y: 0, w: 4, d: 4 }, { x: 0, y: 10, w: 4, d: 4 }], // separated on y
  [{ x: 0, y: 0, w: 2, d: 2 }, { x: 4, y: 4, w: 2, d: 2 }], // diagonal
  [{ x: 0, y: 0, w: 4, d: 4 }, { x: 1, y: 0, w: 4, d: 4 }], // overlapping
]) {
  const [p1, p2] = closestPoints(a, b)
  const dist = Math.hypot(p1[0] - p2[0], p1[1] - p2[1])
  assert.ok(Math.abs(dist - edgeGap(a, b)) < 1e-9, `closestPoints distance mismatch for ${JSON.stringify(a)},${JSON.stringify(b)}`)
}

// closestPair: picks the violating neighbor over a merely-nearer one that
// already clears its own (smaller) requirement
const equipment = [
  { tag: 'H', cls: 'fired_heater', w: 8, d: 8, x: 0, y: 0 },
  { tag: 'C', cls: 'column', w: 6, d: 6, x: 10, y: 0 }, // gap=6, need=15 -> violates by -9
  { tag: 'P', cls: 'pump_hc', w: 2, d: 2, x: 6, y: 0 }, // gap=2, need=15 -> violates by -13 (closer distance but H-P also spacing-critical)
]
const spacing2 = buildSpacingMap([
  { a: 'fired_heater', b: 'column', gap: 15 },
  { a: 'fired_heater', b: 'pump_hc', gap: 15 },
])
const pair = closestPair('H', {}, equipment, spacing2)
assert.equal(pair.other, 'P') // -13 is worse (more negative) than -9
assert.ok(pair.gap < pair.need)

// closestPair uses `positions` override, not the equipment's own x/y
const moved = closestPair('H', { H: { x: 100, y: 100 }, C: { x: 100, y: 100 } }, equipment, spacing2)
assert.equal(moved.gap, 0) // now coincident with C

assert.equal(closestPair('nonexistent', {}, equipment, spacing2), null)

// footprint: corners centered on w/d, position override works
assert.deepEqual(footprint({ x: 0, y: 0, w: 4, d: 2 }), [-2, -1, 2, 1])
assert.deepEqual(footprint({ x: 0, y: 0, w: 4, d: 2 }, { x: 10, y: 10 }), [8, 9, 12, 11])

// sideRect: one rect per side, null when side/length empty
assert.deepEqual(sideRect(0, 0, 4, 2, 'x+', 6), [4, 0, 10, 2])
assert.deepEqual(sideRect(0, 0, 4, 2, 'x-', 6), [-6, 0, 0, 2])
assert.deepEqual(sideRect(0, 0, 4, 2, 'y+', 6), [0, 2, 4, 8])
assert.deepEqual(sideRect(0, 0, 4, 2, 'y-', 6), [0, -6, 4, 0])
assert.equal(sideRect(0, 0, 4, 2, '', 6), null)
assert.equal(sideRect(0, 0, 4, 2, 'x+', 0), null)

// snapToGrid: rounds to the nearest tick on each axis independently
assert.deepEqual(snapToGrid(7.3, 4.6, 2, 1), { x: 8, y: 5, kind: 'grid' })
assert.deepEqual(snapToGrid(7.3, 4.6, 1, 1), { x: 7, y: 5, kind: 'grid' })
assert.equal(snapToGrid(7, 4, 0, 1), null, 'zero step = no snap')

// snapToObject: nearest candidate within thresh wins; out-of-range = null
const cands = [[0, 0], [10, 0], [10, 10]]
assert.deepEqual(snapToObject(0.4, 0.3, cands, 1.0), { x: 0, y: 0, kind: 'object' })
assert.deepEqual(snapToObject(9.7, 0.2, cands, 1.0), { x: 10, y: 0, kind: 'object' })
assert.equal(snapToObject(5, 5, cands, 1.0), null, '5,5 is >1m from any candidate')
// ties go to the first-seen nearest (<= thresh, stable order)
assert.deepEqual(snapToObject(1, 0, [[0, 0], [2, 0]], 1.0), { x: 0, y: 0, kind: 'object' })

// snapToBorder: independent per axis, within thresh only
assert.deepEqual(snapToBorder(0.3, 50, 100, 100, 1.0), { x: 0, y: 50, kind: 'border' })
assert.deepEqual(snapToBorder(99.7, 99.8, 100, 100, 1.0), { x: 100, y: 100, kind: 'border' })
assert.equal(snapToBorder(50, 50, 100, 100, 1.0), null, 'center is nowhere near a border')

console.log('geom.test.js OK')

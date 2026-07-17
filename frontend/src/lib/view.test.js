// Runnable check for view.js. No framework: `node src/lib/view.test.js`.
import assert from 'node:assert'
import { fitView, reaspect, toWorld, zoomAt, panBy, zoomPercent, niceStep, MIN_W } from './view.js'

const rect = { width: 800, height: 600 }
const site = { w: 60, d: 80 }

// fitView matches the canvas aspect (0.75) and contains site+margin
const v = fitView(site, rect, 5)
assert.ok(Math.abs(v.h / v.w - 0.75) < 1e-9, 'view aspect must match canvas')
assert.ok(v.x <= -5 && v.x + v.w >= 65, 'site x range not contained')
assert.ok(v.y <= -5 && v.y + v.h >= 85, 'site y range not contained')

// toWorld maps rect corners to the viewBox corners
assert.deepEqual(toWorld(v, rect, 0, 0), { x: v.x, y: v.y })
assert.deepEqual(toWorld(v, rect, 800, 600), { x: v.x + v.w, y: v.y + v.h })

// reaspect keeps center and adopts the new aspect
const r2 = reaspect(v, { width: 400, height: 400 })
assert.ok(Math.abs(r2.h - r2.w) < 1e-9, 'reaspect should make square view for square canvas')
assert.ok(Math.abs((r2.y + r2.h / 2) - (v.y + v.h / 2)) < 1e-9, 'reaspect must keep center')

// zoomAt keeps the world point under the cursor pixel fixed
for (const [px, py, f] of [[400, 300, 0.5], [100, 500, 1.4], [800, 0, 0.8]]) {
  const before = toWorld(v, rect, px, py)
  const after = toWorld(zoomAt(v, rect, px, py, f), rect, px, py)
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9,
    `zoom fixed-point failed at ${px},${py} f=${f}`)
}

// zoom clamps at MIN_W and preserves aspect ratio
const tiny = zoomAt(v, rect, 400, 300, 0.0001)
assert.equal(tiny.w, MIN_W)
assert.ok(Math.abs(tiny.w / tiny.h - v.w / v.h) < 1e-9, 'aspect not preserved on clamp')

// panBy shifts the world origin opposite the drag direction
const p = panBy(v, rect, 80, -60) // drag right 80px, up 60px
assert.ok(Math.abs(p.x - (v.x - 0.1 * v.w)) < 1e-9) // 80/800 = 0.1
assert.ok(Math.abs(p.y - (v.y + 0.1 * v.h)) < 1e-9) // -60/600 = -0.1

// zoomPercent: half-width view reads as 200%
assert.equal(zoomPercent({ ...v, w: 35 }, 70), 200)

// niceStep snaps up to 1/2/5 * 10^n
assert.equal(niceStep(0.7), 1)
assert.equal(niceStep(1.5), 2)
assert.equal(niceStep(3), 5)
assert.equal(niceStep(8), 10)
assert.equal(niceStep(23), 50)
assert.equal(niceStep(120), 200)

console.log('view.test.js OK')

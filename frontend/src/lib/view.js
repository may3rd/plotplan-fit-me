// Pure viewBox math for the plot canvas. A "view" is an SVG viewBox
// {x, y, w, h} in world/meter space; "rect" is the canvas's on-screen
// bounding box {width, height} in CSS px. Kept pure + separate so the
// zoom-toward-cursor and pan arithmetic can be checked without a browser
// (see view.test.js).

export const MIN_W = 2 // don't zoom in past a 2 m-wide view
export const MAX_W = 100000 // don't zoom out past 100 km-wide view

/** viewBox that frames the whole site with a margin (meters), matching the
 * canvas aspect ratio so equipment shapes stay true (no distortion). */
export function fitView(site, rect, margin = 5) {
  const aspect = rect.height / rect.width
  const w = Math.max(site.w + 2 * margin, (site.d + 2 * margin) / aspect)
  const h = w * aspect
  return { x: site.w / 2 - w / 2, y: site.d / 2 - h / 2, w, h }
}

/** Re-fit a view's height to a (new) canvas aspect ratio, keeping its
 * center — call on canvas resize so the viewBox aspect always matches the
 * canvas and the world→screen mapping stays undistorted. */
export function reaspect(view, rect) {
  const h = view.w * (rect.height / rect.width)
  return { ...view, y: view.y + (view.h - h) / 2, h }
}

/** World point under a screen pixel (px,py measured from the canvas rect's
 * top-left). Inverse of the viewBox mapping, aspect-ratio agnostic because
 * the canvas uses preserveAspectRatio="none". */
export function toWorld(view, rect, px, py) {
  return {
    x: view.x + (px / rect.width) * view.w,
    y: view.y + (py / rect.height) * view.h,
  }
}

/** Zoom by `factor` (>1 zooms out, <1 zooms in) keeping the world point
 * under the cursor pixel fixed on screen. */
export function zoomAt(view, rect, px, py, factor) {
  let w = view.w * factor
  let h = view.h * factor
  // clamp on width, scale height to match so aspect stays put
  const clamped = Math.min(Math.max(w, MIN_W), MAX_W)
  h *= clamped / w
  w = clamped
  const before = toWorld(view, rect, px, py)
  return { x: before.x - (px / rect.width) * w, y: before.y - (py / rect.height) * h, w, h }
}

/** Pan by a screen-pixel delta (drag). */
export function panBy(view, rect, dxPx, dyPx) {
  return {
    ...view,
    x: view.x - (dxPx / rect.width) * view.w,
    y: view.y - (dyPx / rect.height) * view.h,
  }
}

/** Zoom percent relative to a reference (fit) width, for the status bar. */
export function zoomPercent(view, refWidth) {
  return Math.round((refWidth / view.w) * 100)
}

/** A "nice" tick step (…1,2,5,10,20,50…) >= the raw step, so rulers/grid
 * stay readable at any zoom. `raw` is the ideal world-space step. */
export function niceStep(raw) {
  if (raw <= 0) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(raw)))
  const n = raw / pow
  const mult = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return mult * pow
}

/** Scale a user-chosen base step (meters/tick) by powers of 2 so the major
 * tick count across `span` stays within [minTicks, maxTicks] — the grid
 * "keeps up" with zoom instead of a fixed step becoming too dense/sparse. */
export function adaptiveStep(base, span, minTicks = 4, maxTicks = 20) {
  let step = base
  while (span / step > maxTicks) step *= 2
  while (span / step < minTicks) step /= 2
  return step
}

/** Major + minor tick positions (world units) inside [lo, hi]. `gridStep`
 * (meters/tick) anchors the major step when given (a truthy positive
 * number, scaled per `adaptiveStep`); otherwise it's an auto "nice" step
 * from the visible span. Minor ticks subdivide each major step into 5,
 * skipping any that land on a major tick. */
export function ticks(lo, hi, span, gridStep) {
  const step = gridStep > 0 ? adaptiveStep(gridStep, span) : niceStep(span / 10)
  const out = []
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) out.push(Math.round(t / step) * step)
  const minorStep = step / 5
  const minorOut = []
  for (let t = Math.ceil(lo / minorStep) * minorStep; t <= hi; t += minorStep) {
    const r = Math.round(t / minorStep) * minorStep
    const ratio = r / step
    if (Math.abs(ratio - Math.round(ratio)) > 1e-6) minorOut.push(r)
  }
  return { step, out, minorStep, minorOut }
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { panBy, tickStep, ticksAtStep, zoomAt } from '@/lib/view'
import { buildSpacingMap, closestPair, footprint, sideRect } from '@/lib/geom'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

const CLASS_COLOR = {
  fired_heater: '#e05a47',
  column: '#4a7fd6',
  vessel: '#3fa66b',
  exchanger: '#c98a2b',
  pump_hc: '#8a5fd6',
}

const RULER = 26 // px thickness of each ruler strip
const RACK_HATCH_SPACING = 4 // meters between pipe-rack cross-tie lines
const SOFT_SNAP_M = 1.0 // soft-snap to the site border when a dragged point is within this many meters
// Maximum INNER road-turn fillet radius, in meters (the tight notch on the
// inside of a bend). Fixed for now rather than derived — ponytail: promote
// to a per-project/user setting if it matters, plain constant is enough
// today. The OUTER curb radius of a 90-degree turn is this plus the road's
// own width (a car swings wide, so the outside arc is one lane bigger than
// the inside). Either is capped by whatever its adjacent road stubs actually
// allow (see roundedPolygonPath).
const ROAD_INNER_RADIUS_M = 8
const RACK_COLUMN_SIZE = 1.0 // meters, side length of the tiny column marker square

// engineering-drawing dimension offsets (all in world meters)
const DIM_OFFSET = 3.0  // dimension line offset from the zone edge
const EXT_GAP = 0.5     // gap from zone corner to extension-line start
const EXT_OVER = 1.0    // extension-line overshoot past the dimension line
const ARROW = 1.2       // arrowhead open-angle size

// Soft-snap a world coordinate to the nearest site border (0 or the site's
// extent on that axis) when it's within SOFT_SNAP_M, otherwise leave it. Used
// while dragging/resizing zones so a side can drop flush against the site edge.
function softBorder(val, low, high) {
  if (Math.abs(val - low) < SOFT_SNAP_M) return low
  if (Math.abs(val - high) < SOFT_SNAP_M) return high
  return val
}

// tool -> the zone-name prefix it draws (see backend plotplan._rack_zones /
// _zone_layer — a zone's name prefix is the only thing that decides its
// role/layer; "RACK"/"ROAD"/"MAINT" mirror that same convention, while
// "UNDERGROUND"/"KEEPOUT" stay generic keep-out zones).
const DRAW_KINDS = {
  road: { prefix: 'ROAD', label: 'Road' },
  rack: { prefix: 'RACK', label: 'Pipe Rack' },
  maint: { prefix: 'MAINT', label: 'Maintenance' },
  underground: { prefix: 'UNDERGROUND', label: 'Underground' },
  keepout: { prefix: 'KEEPOUT', label: 'Keep-out' },
}
const DRAW_PREFIX = Object.fromEntries(
  Object.entries(DRAW_KINDS).map(([k, v]) => [`draw-${k}`, v.prefix]),
)

function svgPoint(svg, clientX, clientY) {
  const pt = svg.createSVGPoint()
  pt.x = clientX
  pt.y = clientY
  return pt.matrixTransform(svg.getScreenCTM().inverse())
}

function centroid(poly) {
  const cx = poly.reduce((s, [x]) => s + x, 0) / poly.length
  const cy = poly.reduce((s, [, y]) => s + y, 0) / poly.length
  return [cx, cy]
}

// next unused "{PREFIX}_{n}" name for a newly-drawn zone
function nextZoneName(keepouts, prefix) {
  const used = new Set(
    Object.keys(keepouts ?? {})
      .filter((z) => z.toUpperCase().startsWith(prefix))
      .map((z) => Number(z.slice(prefix.length + 1)))
      .filter((n) => Number.isFinite(n)),
  )
  let n = 1
  while (used.has(n)) n++
  return `${prefix}_${n}`
}

// Snap `p` to the horizontal or vertical line through `start` (whichever is
// closer), so a pipe-rack centerline is axis-aligned while drawing.
function snapAxisAligned(start, p) {
  const dx = p[0] - start[0]
  const dy = p[1] - start[1]
  return Math.abs(dx) >= Math.abs(dy)
    ? [p[0], start[1]]
    : [start[0], p[1]]
}

// Cross-tie hatch segments for a rack polygon, running ACROSS its width
// (perpendicular to the centerline) at `spacing` intervals along its length.
// Recovers the centerline/width from the polygon corners produced by centerlineRect.
function rackHatchSegments(poly, spacing) {
  const [v0, v1, v2, v3] = poly
  const start = [(v0[0] + v3[0]) / 2, (v0[1] + v3[1]) / 2]
  const end = [(v1[0] + v2[0]) / 2, (v1[1] + v2[1]) / 2]
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const len = Math.hypot(dx, dy)
  if (len < 1e-6) return []
  const ux = dx / len
  const uy = dy / len
  // half-width = distance from centerline to a side vertex
  const halfW = Math.hypot(v0[0] - start[0], v0[1] - start[1])
  const segs = []
  for (let d = spacing; d < len; d += spacing) {
    const px = start[0] + ux * d
    const py = start[1] + uy * d
    segs.push({
      x1: px - uy * halfW, y1: py + ux * halfW,
      x2: px + uy * halfW, y2: py - ux * halfW,
    })
  }
  return segs
}

// Build a zone rectangle from a centerline (start->end) and a width — used
// for both roads and pipe racks (same two-click draw interaction, see
// DRAW_PREFIX): it runs along the centerline and is `width` wide, split
// equally to either side. Returns [[x,y]...] in world coords.
function centerlineRect(start, end, width) {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const len = Math.hypot(dx, dy) || 1
  const ox = (-dy / len) * (width / 2)
  const oy = (dx / len) * (width / 2)
  return [
    [start[0] + ox, start[1] + oy],
    [end[0] + ox, end[1] + oy],
    [end[0] - ox, end[1] - oy],
    [start[0] - ox, start[1] - oy],
  ]
}

function zoneBBox(poly) {
  const xs = poly.map((p) => p[0])
  const ys = poly.map((p) => p[1])
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

function rectsOverlap(a, b, eps = 0.05) {
  return a.minX <= b.maxX + eps && a.maxX >= b.minX - eps
    && a.minY <= b.maxY + eps && a.maxY >= b.minY - eps
}

// Union-find clustering of road zones by rectangle overlap/touch, so a chain
// of roads that connect end-to-end merges into one shape even where not
// every pair directly overlaps (A touches B, B touches C -> one cluster).
function clusterRoadZones(roadEntries) {
  const n = roadEntries.length
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (rectsOverlap(roadEntries[i].bbox, roadEntries[j].bbox)) {
        const ri = find(i); const rj = find(j)
        if (ri !== rj) parent[ri] = rj
      }
    }
  }
  const groups = new Map()
  roadEntries.forEach((r, i) => {
    const root = find(i)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(r)
  })
  return [...groups.values()]
}

// Two perpendicular roads joined by the two-click tool only reach each
// other's centreline, so neither fills the corner square — the union comes
// out stair-stepped (a notch on the outside of the bend) instead of a clean
// right-angle. For every overlapping vertical/horizontal pair, add a "ghost"
// rect covering the full corner (the vertical road's x-range × the horizontal
// road's y-range) so the merged outline is one L that rounds to a single
// inner + outer curve. A T/cross pair's ghost lands inside the through road,
// so it changes nothing there.
function withCornerFills(rects) {
  const out = [...rects]
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]; const b = rects[j]
      const aVert = a.maxX - a.minX <= a.maxY - a.minY
      const bVert = b.maxX - b.minX <= b.maxY - b.minY
      if (aVert === bVert) continue // parallel-ish: no corner to complete
      if (!(a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY)) continue
      const v = aVert ? a : b; const h = aVert ? b : a
      out.push({ minX: v.minX, maxX: v.maxX, minY: h.minY, maxY: h.maxY })
    }
  }
  return out
}

// Union a cluster of axis-aligned rectangles into one rectilinear outline via
// a grid trace: build the coordinate grid, mark filled cells, then collect
// each filled cell's edges that border the outside (neighbor cell empty or
// off-grid) and link them tip-to-tail into a closed loop. Assumes a
// simply-connected union (no donut holes) — true for how roads actually get
// drawn here (a chain of overlapping segments, never a closed ring).
function unionRoadOutline(rects) {
  const xs = [...new Set(rects.flatMap((r) => [r.minX, r.maxX]))].sort((a, b) => a - b)
  const ys = [...new Set(rects.flatMap((r) => [r.minY, r.maxY]))].sort((a, b) => a - b)
  const nx = xs.length - 1
  const ny = ys.length - 1
  const filled = Array.from({ length: ny }, () => new Array(nx).fill(false))
  for (let iy = 0; iy < ny; iy++) {
    const cy = (ys[iy] + ys[iy + 1]) / 2
    for (let ix = 0; ix < nx; ix++) {
      const cx = (xs[ix] + xs[ix + 1]) / 2
      filled[iy][ix] = rects.some((r) => cx > r.minX && cx < r.maxX && cy > r.minY && cy < r.maxY)
    }
  }
  const edges = []
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      if (!filled[iy][ix]) continue
      const x0 = xs[ix]; const x1 = xs[ix + 1]; const y0 = ys[iy]; const y1 = ys[iy + 1]
      if (ix === 0 || !filled[iy][ix - 1]) edges.push([[x0, y0], [x0, y1]])
      if (ix === nx - 1 || !filled[iy][ix + 1]) edges.push([[x1, y1], [x1, y0]])
      if (iy === 0 || !filled[iy - 1][ix]) edges.push([[x1, y0], [x0, y0]])
      if (iy === ny - 1 || !filled[iy + 1][ix]) edges.push([[x0, y1], [x1, y1]])
    }
  }
  if (!edges.length) return []
  const key = ([x, y]) => `${x.toFixed(4)},${y.toFixed(4)}`
  const byStart = new Map(edges.map((e, i) => [key(e[0]), i]))
  const used = new Array(edges.length).fill(false)
  const loop = []
  let cur = 0
  for (let step = 0; step < edges.length; step++) {
    used[cur] = true
    loop.push(edges[cur][0])
    const nextIdx = byStart.get(key(edges[cur][1]))
    if (nextIdx === undefined || used[nextIdx]) break
    cur = nextIdx
  }
  const n = loop.length
  return loop.filter((p, i) => {
    const prev = loop[(i - 1 + n) % n]; const next = loop[(i + 1) % n]
    const sameX = prev[0] === p[0] && p[0] === next[0]
    const sameY = prev[1] === p[1] && p[1] === next[1]
    return !(sameX || sameY)
  })
}

function vsub(a, b) { return [a[0] - b[0], a[1] - b[1]] }
function vlen(a) { return Math.hypot(a[0], a[1]) }
function vscale(a, s) { return [a[0] * s, a[1] * s] }

// SVG path `d` for a polygon with the flagged corners filleted: a straight
// line in along one edge, a quadratic bezier through the true corner point,
// then straight back out along the next edge. `radii[i]` is the MAXIMUM
// radius for corner i (0 = stays sharp), so a road with no junction (all
// zeros) renders identically to a plain polygon just via a different
// element.
//
// A corner rounds at whatever radius its adjacent road stubs actually allow,
// clamped up to that maximum — never left sharp just because the full max
// doesn't fit, but never overshooting past the road's own straight run either.
//
// Each edge can only be claimed by the fillets at its own two endpoints, so
// a corner may use the FULL adjacent edge length when the far end of that
// edge is a sharp (unrounded) corner — only half of it when both ends round,
// so the two curves can't overlap. A road that joins another one flush at
// its centerline (the normal two-click drawing convention) always has an
// inner-notch edge exactly half the road's own width — that's often the
// difference between a corner reaching the max radius and getting clamped.
function roundedPolygonPath(poly, radii, toY) {
  const n = poly.length
  const corners = poly.map((p, i) => {
    const prevIdx = (i - 1 + n) % n
    const nextIdx = (i + 1) % n
    const prev = poly[prevIdx]
    const next = poly[nextIdx]
    const edgeIn = vlen(vsub(p, prev))
    const edgeOut = vlen(vsub(next, p))
    const inShare = radii[prevIdx] > 1e-9 ? edgeIn / 2 : edgeIn
    const outShare = radii[nextIdx] > 1e-9 ? edgeOut / 2 : edgeOut
    const r = radii[i] > 1e-9 ? Math.min(radii[i], inShare, outShare) : 0
    const toPrev = edgeIn > 1e-6 ? vscale(vsub(prev, p), 1 / edgeIn) : [0, 0]
    const toNext = edgeOut > 1e-6 ? vscale(vsub(next, p), 1 / edgeOut) : [0, 0]
    return {
      inPt: [p[0] + toPrev[0] * r, p[1] + toPrev[1] * r],
      corner: p,
      outPt: [p[0] + toNext[0] * r, p[1] + toNext[1] * r],
      rounded: r > 1e-6,
    }
  })
  let d = ''
  corners.forEach((c, i) => {
    const start = c.rounded ? c.inPt : c.corner
    d += `${i === 0 ? 'M' : 'L'} ${start[0]} ${toY(start[1])} `
    if (c.rounded) d += `Q ${c.corner[0]} ${toY(c.corner[1])} ${c.outPt[0]} ${toY(c.outPt[1])} `
  })
  return `${d}Z`
}

// Which CONVEX corners are the outer curb-swing of a real bend (must round
// wide) vs a dead-end cap that stays sharp. The outer swing of a 90° turn sits
// diagonally across the corner square from the bend's concave inner notch —
// exactly one road-width away on each axis. A dead-end cap has no notch paired
// with it, so it fails the test and stays sharp. This is why the old "is this
// a NEW union point?" test failed: the outer swing coincides with an original
// rect corner, but it's still a genuine bend corner.
// The corner square between two roads is (vertical road width) × (horizontal
// road width), so the swing/notch diagonal offsets equal those two widths —
// which differ when the roads differ. Test each axis offset against the set of
// road widths in the cluster, not one shared value, so a wide-meets-narrow
// bend still rounds.
function outerSwingFlags(outline, convex, widths, eps = 0.01) {
  const notches = outline.filter((_, i) => !convex[i])
  const isWidth = (d) => widths.some((w) => Math.abs(d - w) < eps)
  return outline.map((p, i) => convex[i] && notches.some((q) => (
    isWidth(Math.abs(p[0] - q[0])) && isWidth(Math.abs(p[1] - q[1]))
  )))
}

// Which corners of the merged outline are convex (turn OUTWARD — the outer
// curb of a bend) vs concave (the inner notch)? unionRoadOutline traces the
// loop in a consistent winding, so a convex corner's turn cross-product has
// the opposite sign to a concave one. Signed area tells us the winding.
function convexCornerFlags(outline) {
  const n = outline.length
  let area2 = 0
  for (let i = 0; i < n; i++) {
    const [ax, ay] = outline[i]
    const [bx, by] = outline[(i + 1) % n]
    area2 += ax * by - bx * ay
  }
  const ccw = area2 > 0
  return outline.map((p, i) => {
    const a = outline[(i - 1 + n) % n]
    const c = outline[(i + 1) % n]
    const cross = (p[0] - a[0]) * (c[1] - p[1]) - (p[1] - a[1]) * (c[0] - p[0])
    return ccw ? cross > 0 : cross < 0
  })
}

// Tiny column markers for a pipe rack: one at each of the 4 corners, plus one
// at each point where a cross-tie hatch line meets the rack's long edge.
function rackColumnPoints(poly, hatch) {
  const pts = [...poly]
  hatch.forEach((seg) => pts.push([seg.x1, seg.y1], [seg.x2, seg.y2]))
  return pts
}

export default function PlotCanvas({
  data, positions, onPositions, view, setView, showGrid, showRuler, gridStep, snap, tool, setTool,
  viewMode,
  rackWidth, setRackWidth, roadWidth, setRoadWidth, drawPromptNonce,
  editPromptNonce, onCursor, onSize, onAddZone, onDeleteZone, onEditZone,
  selectedZone, setSelectedZone, editMode,
}) {
  const { equipment, connections, site, keepouts, spacing, wind_clearance_m: windClearanceM } = data
  const byTag = Object.fromEntries(equipment.map((e) => [e.tag, e]))
  const toY = (y) => site.d - y // north-up: flip y for SVG
  const spacingMap = useMemo(() => buildSpacingMap(spacing), [spacing])
  // roads that overlap/touch get grouped so the whole chain renders as one
  // merged, rounded-at-the-turns shape instead of separate rectangles with
  // a visible seam at every join (see unionRoadOutline).
  const roadClusters = useMemo(() => {
    const roadEntries = Object.entries(keepouts ?? {})
      .filter(([z]) => z.toUpperCase().startsWith('ROAD'))
      .map(([zone, poly]) => ({ zone, poly, bbox: zoneBBox(poly) }))
    return clusterRoadZones(roadEntries)
  }, [keepouts])
  const roadClusterSize = useMemo(() => {
    const m = new Map()
    roadClusters.forEach((cluster) => cluster.forEach((r) => m.set(r.zone, cluster.length)))
    return m
  }, [roadClusters])

  // roads and pipe racks share the exact same two-click centerline+width
  // draw interaction (see DRAW_PREFIX) — only the width preference, zone
  // name prefix, and rendered style (hatch/label/color) differ per kind.
  const drawKind = tool.startsWith('draw-') ? tool.slice(5) : null
  const drawDef = drawKind ? DRAW_KINDS[drawKind] : null
  // roads and pipe racks remember their width in App prefs (rackWidth/
  // roadWidth); other zone kinds keep a local default width.
  const [otherWidth, setOtherWidth] = useState(8)
  const drawWidth = drawKind === 'rack' ? rackWidth
    : drawKind === 'road' ? roadWidth
    : otherWidth
  const setDrawWidth = drawKind === 'rack' ? setRackWidth
    : drawKind === 'road' ? setRoadWidth
    : setOtherWidth

  const wrapRef = useRef(null)
  const svgRef = useRef(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const dragTag = useRef(null)
  const pan = useRef(null) // {x, y} last client pos while panning
  const dragZone = useRef(null) // {zone, offX, offY} while dragging a whole zone in edit mode
  const drawStart = useRef(null) // {x, y} world point where a zone-draw drag began
  const [measure, setMeasure] = useState(null) // live closest-neighbor readout while dragging
  const [zoneDim, setZoneDim] = useState(null) // {w, h, cx, cy} live width×height while resizing a zone
  const [drawRect, setDrawRect] = useState(null) // live two-click centerline preview {x1,y1,x2,y2}
  const [dragVert, setDragVert] = useState(null) // {zone, index} | {zone, edge} while dragging a vertex/edge handle
  const [editOpen, setEditOpen] = useState(false) // zone rename/role dialog
  const [drawPromptOpen, setDrawPromptOpen] = useState(false)
  const [drawPromptVal, setDrawPromptVal] = useState(String(drawWidth))
  const [zoneDrawing, setZoneDrawing] = useState(false) // true between the first and second click

  // view is null for the first frame (until App computes the fit off the
  // reported size). Keep the DOM structure STABLE across that transition —
  // if the tree shape changes, React reconciles wrapRef onto the wrong
  // element and the ResizeObserver measures the ruler strip instead of the
  // canvas. So always render the same tree and fall back to a unit viewBox.
  const v = view ?? { x: 0, y: 0, w: 1, h: 1 }
  const ready = view && size.width
  // one shared step for both rulers/grids — x and y spans (v.w/v.h) differ
  // slightly whenever the viewBox isn't square, which would otherwise let
  // niceStep/adaptiveStep pick different auto steps per axis even though
  // the world→px scale is identical in both directions.
  const sharedStep = ready ? tickStep(Math.max(v.w, v.h), gridStep) : 1
  const xt = ready ? ticksAtStep(v.x, v.x + v.w, sharedStep) : { step: 1, out: [], minorStep: 1, minorOut: [] }
  const yt = ready ? ticksAtStep(v.y, v.y + v.h, sharedStep) : { step: 1, out: [], minorStep: 1, minorOut: [] }

  // measure canvas; App owns the viewBox fit/aspect logic off this size.
  // Measure once synchronously on mount too — the ResizeObserver's first
  // callback is async (next frame), so without this the initial fit can be
  // skipped on a fresh load if nothing else triggers a resize.
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const report = (width, height) => {
      if (!width || !height) return
      setSize({ width, height })
      onSize({ width, height })
    }
    const r = el.getBoundingClientRect()
    report(r.width, r.height)
    const ro = new ResizeObserver(([entry]) => {
      report(entry.contentRect.width, entry.contentRect.height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [onSize])

  // native non-passive wheel listener so we can preventDefault the page scroll
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const factor = e.deltaY < 0 ? 0.9 : 1.1
      setView((v) => zoomAt(v, rect, e.clientX - rect.left, e.clientY - rect.top, factor))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setView])

  // Delete/Backspace removes the selected zone — only while select tool is
  // active and something is actually selected, so this never fights with
  // typing in an input elsewhere in the ribbon.
  useEffect(() => {
    if (!selectedZone) return
    const onKeyDown = (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      onDeleteZone(selectedZone)
      setSelectedZone(null)
      setEditOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedZone, onDeleteZone, setSelectedZone])

  function reportCursor(ev) {
    const p = svgPoint(svgRef.current, ev.clientX, ev.clientY)
    onCursor({ x: p.x, y: site.d - p.y })
  }

  // The ribbon's "Draw road"/"Draw pipe rack" buttons bump drawPromptNonce,
  // which opens the width prompt (default rackWidth/roadWidth, later from
  // preferences). Opening is driven by that explicit trigger so the dialog
  // can't reopen unexpectedly and so re-clicking the (already-active)
  // button re-opens it.
  useEffect(() => {
    if (!drawKind) return
    setDrawPromptVal(String(drawWidth))
    setDrawPromptOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawPromptNonce, drawKind])

  // The ribbon's "Edit zone" button (or a double-click on the canvas) bumps
  // editPromptNonce to open the selected zone's edit dialog. Only opens if a
  // zone is actually selected.
  useEffect(() => {
    if (!selectedZone) return
    setEditOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editPromptNonce])

  function confirmDrawWidth() {
    const n = Number(drawPromptVal)
    if (Number.isFinite(n) && n > 0) setDrawWidth(n)
    setDrawPromptOpen(false)
  }

  // Esc cancels an in-progress road/rack draw (between the first and second
  // click) — but never while the width prompt dialog is open.
  useEffect(() => {
    if (!zoneDrawing || drawPromptOpen) return
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        drawStart.current = null
        setDrawRect(null)
        setZoneDrawing(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [zoneDrawing, drawPromptOpen])

  // set the drag/pan state BEFORE trying to capture the pointer: capture can
  // throw (stale/synthetic pointer id) and must not prevent the state from
  // being set. preventDefault stops the browser's native text-selection drag.
  function capture(ev) {
    ev.preventDefault()
    try { ev.currentTarget.setPointerCapture(ev.pointerId) } catch { /* not fatal */ }
  }

  function onPointerDownBg(ev) {
    if (tool === 'pan' || ev.button === 1) {
      pan.current = { x: ev.clientX, y: ev.clientY }
      capture(ev)
      return
    }
    if (DRAW_PREFIX[tool]) {
      // two-click mode, shared by roads and pipe racks: first click sets
      // the centerline start; second click sets the end and commits the
      // zone. No pointer capture (unlike a drag tool) so the second
      // discrete click arrives normally.
      const p = svgPoint(svgRef.current, ev.clientX, ev.clientY)
      const w = { x: p.x, y: site.d - p.y }
      if (!drawStart.current) {
        drawStart.current = w
        setDrawRect({ x1: w.x, y1: w.y, x2: w.x, y2: w.y })
        setZoneDrawing(true)
      } else {
        const start = [drawStart.current.x, drawStart.current.y]
        const end = snapAxisAligned(start, [w.x, w.y])
        const poly = centerlineRect(start, end, drawWidth)
        const name = nextZoneName(keepouts, DRAW_PREFIX[tool])
        onAddZone(name, poly)
        drawStart.current = null
        setDrawRect(null)
        setZoneDrawing(false)
        setTool('select') // one shot: back to Select after placing a zone
      }
      return
    }
    if (tool === 'select' || tool === 'edit') setSelectedZone(null)
  }

  function onPointerDownEquip(tag, ev) {
    // Equipment is selectable/movable only in Select mode.
    if (tool !== 'select' || byTag[tag].pinned) return
    ev.stopPropagation()
    dragTag.current = tag
    capture(ev)
  }

  function onPointerDownZone(zone, ev) {
    // Zones are interactive only in Edit mode (select + move the whole
    // polygon). In Select mode a click on a zone does nothing — only
    // equipment is selectable there.
    if (tool !== 'edit') return
    ev.stopPropagation()
    setSelectedZone(zone)
    const poly = keepouts[zone] ?? []
    const first = poly[0] ?? [0, 0]
    const p = svgPoint(svgRef.current, ev.clientX, ev.clientY)
    // grab offset = first vertex - pointer (world), so the first vertex stays
    // a fixed distance behind the cursor as it moves (no jump on first move).
    const wy = site.d - p.y
    dragZone.current = { zone, ox: first[0] - p.x, oy: first[1] - wy }
    capture(ev)
  }

  function onPointerDownVert(zone, index, ev) {
    // Reshape a zone by dragging a vertex — Edit mode only.
    if (tool !== 'edit') return
    ev.stopPropagation()
    setSelectedZone(zone)
    setDragVert({ zone, index })
    capture(ev)
  }

  function onPointerDownEdge(zone, edge, ev) {
    // Expand/shrink a zone by dragging the midpoint of an edge — both
    // endpoints of that edge slide by the same delta (the opposite edge
    // stays fixed). The slide is constrained to the edge's perpendicular
    // (orthogonal) direction, so a side only moves in/out, never sideways.
    // Edit mode only.
    if (tool !== 'edit') return
    ev.stopPropagation()
    setSelectedZone(zone)
    const poly = keepouts[zone] ?? []
    const a = poly[edge] ?? [0, 0]
    const b = poly[(edge + 1) % poly.length] ?? [0, 0]
    const p = svgPoint(svgRef.current, ev.clientX, ev.clientY)
    // perpendicular axis: 'x' if the edge runs vertically (move left/right),
    // 'y' if it runs horizontally (move up/down).
    const perp = Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]) ? 'y' : 'x'
    setDragVert({
      zone, edge,
      ax: a[0], ay: a[1], bx: b[0], by: b[1],
      px: p.x, py: site.d - p.y,
      perp,
    })
    capture(ev)
  }

  function onPointerMove(ev) {
    reportCursor(ev)
    if (pan.current) {
      const rect = wrapRef.current.getBoundingClientRect()
      const dx = ev.clientX - pan.current.x
      const dy = ev.clientY - pan.current.y
      pan.current = { x: ev.clientX, y: ev.clientY }
      setView((v) => panBy(v, rect, dx, dy))
      return
    }
    if (dragVert) {
      const p = svgPoint(svgRef.current, ev.clientX, ev.clientY)
      let x = p.x
      let y = site.d - p.y
      if (snap) {
        x = Math.round(x / xt.minorStep) * xt.minorStep
        y = Math.round(y / yt.minorStep) * yt.minorStep
      }
      // soft-snap a dragged corner to the site border when close.
      x = softBorder(x, 0, site.w)
      y = softBorder(y, 0, site.d)
      const cur = keepouts[dragVert.zone] ?? []
      let poly
      if (dragVert.edge !== undefined) {
        // edge midpoint handle: translate both endpoints of edge `edge`
        // (vertices `edge` and `edge+1`) by the same delta from the grab
        // point, so the side slides in/out — expanding or shrinking the
        // polygon along that edge. Only the perpendicular component of the
        // drag is applied, so the side moves orthogonally only.
        let dx = x - dragVert.px
        let dy = y - dragVert.py
        if (dragVert.perp === 'x') dy = 0
        else dx = 0
        const j = (dragVert.edge + 1) % cur.length
        poly = cur.map((pt, i) => {
          if (i === dragVert.edge) return [dragVert.ax + dx, dragVert.ay + dy]
          if (i === j) return [dragVert.bx + dx, dragVert.by + dy]
          return pt
        })
      } else {
        // single vertex handle: move just that corner.
        poly = cur.map((pt, i) => (i === dragVert.index ? [x, y] : pt))
      }
      onEditZone(dragVert.zone, poly)
      const xs = poly.map((pt) => pt[0])
      const ys = poly.map((pt) => pt[1])
      setZoneDim({
        w: Math.max(...xs) - Math.min(...xs),
        h: Math.max(...ys) - Math.min(...ys),
        cx: (Math.max(...xs) + Math.min(...xs)) / 2,
        cy: (Math.max(...ys) + Math.min(...ys)) / 2,
      })
      return
    }
    if (dragZone.current) {
      const p = svgPoint(svgRef.current, ev.clientX, ev.clientY)
      let x = p.x + dragZone.current.ox
      let y = (site.d - p.y) + dragZone.current.oy
      if (snap) {
        x = Math.round(x / xt.minorStep) * xt.minorStep
        y = Math.round(y / yt.minorStep) * yt.minorStep
      }
      // soft-snap the dragged zone to the site border when its first vertex
      // gets close — drops the whole polygon flush against an edge.
      x = softBorder(x, 0, site.w)
      y = softBorder(y, 0, site.d)
      const { zone, ox, oy } = dragZone.current
      const poly = keepouts[zone] ?? []
      const first = poly[0] ?? [0, 0]
      const dxw = x - first[0]
      const dyw = y - first[1]
      onEditZone(zone, poly.map(([vx, vy]) => [vx + dxw, vy + dyw]))
      // keep the grab offset relative to the (now moved) first vertex
      dragZone.current = { zone, ox, oy }
      return
    }
    if (drawStart.current) {
      // keep the start fixed; the cursor drives the centerline end (snapped
      // to the nearer axis) so the ghost width preview follows the pointer —
      // same for roads and pipe racks.
      const p = svgPoint(svgRef.current, ev.clientX, ev.clientY)
      const wy = site.d - p.y
      const [ex, ey] = snapAxisAligned([drawStart.current.x, drawStart.current.y], [p.x, wy])
      setDrawRect({ x1: drawStart.current.x, y1: drawStart.current.y, x2: ex, y2: ey })
      return
    }
    const tag = dragTag.current
    if (!tag) return
    const p = svgPoint(svgRef.current, ev.clientX, ev.clientY)
    let x = p.x
    let y = site.d - p.y
    if (snap) {
      x = Math.round(x / xt.minorStep) * xt.minorStep
      y = Math.round(y / yt.minorStep) * yt.minorStep
    }
    const nextPositions = { ...positions, [tag]: { x, y } }
    onPositions(nextPositions)
    const pair = closestPair(tag, nextPositions, equipment, spacingMap)
    setMeasure(pair && { ...pair, tag })
  }

  function onPointerUp() {
    pan.current = null
    dragTag.current = null
    dragZone.current = null
    setDragVert(null)
    setMeasure(null)
    setZoneDim(null)
    // A road/rack draw is committed by the second click (onPointerDownBg),
    // not by releasing the pointer — nothing else to do here.
  }

  function onDoubleClickZone(zone, ev) {
    // Open the rename/role dialog — Edit mode only.
    if (tool !== 'edit') return
    ev.stopPropagation()
    setSelectedZone(zone)
    setEditOpen(true)
  }

  const pxX = (wx) => ((wx - v.x) / v.w) * size.width
  const pxY = (sy) => ((sy - v.y) / v.h) * size.height
  const fmt = (n) => (Number.isInteger(n) ? n : n.toFixed(1))
  const fmtM = (n) => n.toFixed(1)

  return (
    <div className="canvas-grid" data-ruler={showRuler ? 'on' : 'off'}>
      {/* rulers are always mounted (toggled via CSS) so the DOM structure —
          and therefore wrapRef's target — stays stable. */}
      <div className="ruler-corner" />
      <svg className="ruler ruler-x" width={size.width} height={RULER}>
        {xt.minorOut.map((wx) => (
          <line key={`m${wx}`} className="tick-minor" x1={pxX(wx)} y1={RULER - 3} x2={pxX(wx)} y2={RULER} />
        ))}
        {xt.out.map((wx) => (
          <g key={wx}>
            <line x1={pxX(wx)} y1={RULER - 6} x2={pxX(wx)} y2={RULER} />
            <text x={pxX(wx) + 2} y={RULER - 9}>{fmt(wx)}</text>
          </g>
        ))}
      </svg>
      <svg className="ruler ruler-y" width={RULER} height={size.height}>
        {yt.minorOut.map((sy) => (
          <line key={`m${sy}`} className="tick-minor" x1={RULER - 3} y1={pxY(sy)} x2={RULER} y2={pxY(sy)} />
        ))}
        {yt.out.map((sy) => (
          <g key={sy}>
            <line x1={RULER - 6} y1={pxY(sy)} x2={RULER} y2={pxY(sy)} />
            <text x={3} y={pxY(sy) - 3}>{fmt(site.d - sy)}</text>
          </g>
        ))}
      </svg>

      <div ref={wrapRef} className="canvas-wrap">
        <svg
          ref={svgRef}
          className="plot"
          data-tool={tool}
          data-edit={editMode ? 'on' : 'off'}
          data-view={viewMode}
          width="100%"
          height="100%"
          viewBox={`${v.x} ${v.y} ${v.w} ${v.h}`}
          preserveAspectRatio="none"
          onPointerDown={onPointerDownBg}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => onCursor(null)}
        >
          <clipPath id="site-clip" clipPathUnits="userSpaceOnUse">
            <rect x={0} y={0} width={site.w} height={site.d} />
          </clipPath>

          <rect x={0} y={0} width={site.w} height={site.d} className="site" />

          {showGrid && (
            <g className="grid-minor" clipPath="url(#site-clip)">
              {xt.minorOut.map((wx) => (
                <line key={`gxm${wx}`} x1={wx} y1={v.y} x2={wx} y2={v.y + v.h} />
              ))}
              {yt.minorOut.map((sy) => (
                <line key={`gym${sy}`} x1={v.x} y1={sy} x2={v.x + v.w} y2={sy} />
              ))}
            </g>
          )}
          {showGrid && (
            <g className="grid" clipPath="url(#site-clip)">
              {xt.out.map((wx) => (
                <line key={`gx${wx}`} x1={wx} y1={v.y} x2={wx} y2={v.y + v.h} />
              ))}
              {yt.out.map((sy) => (
                <line key={`gy${sy}`} x1={v.x} y1={sy} x2={v.x + v.w} y2={sy} />
              ))}
            </g>
          )}

          {Object.entries(keepouts ?? {}).map(([zone, poly]) => {
            const upper = zone.toUpperCase()
            const kind = upper.startsWith('RACK') ? 'rack'
              : upper.startsWith('ROAD') ? 'road'
              : upper.startsWith('MAINT') ? 'maint' : 'keepout'
            const [cx, cy] = centroid(poly)
            const hatch = kind === 'rack' ? rackHatchSegments(poly, RACK_HATCH_SPACING) : []
            const selected = selectedZone === zone
            // a road that's part of a multi-segment merged cluster (see
            // roadClusters) drops its own stroke — the merged outline drawn
            // after this loop supplies the (rounded) boundary line instead,
            // so no seam shows at the join. Real DXF export never merges
            // (each zone is its own separate LINE outline), so skip this in
            // DXF view and keep every road's true individual boundary.
            const quiet = kind === 'road' && viewMode !== 'dxf' && (roadClusterSize.get(zone) ?? 1) > 1
            return (
              <g key={zone}>
                <polygon
                  points={poly.map(([x, y]) => `${x},${toY(y)}`).join(' ')}
                  className={`zone ${kind} ${quiet ? 'merged-quiet' : ''} ${selected ? 'selected' : ''}`}
                  onPointerDown={(ev) => onPointerDownZone(zone, ev)}
                  onDoubleClick={(ev) => onDoubleClickZone(zone, ev)}
                />
                {viewMode !== 'dxf' && hatch.map((l, i) => (
                  <line key={i} x1={l.x1} y1={toY(l.y1)} x2={l.x2} y2={toY(l.y2)} className="rack-hatch" />
                ))}
                {viewMode !== 'dxf' && kind === 'rack' && rackColumnPoints(poly, hatch).map(([x, y], i) => (
                  <rect
                    key={`col${i}`}
                    x={x - RACK_COLUMN_SIZE / 2} y={toY(y) - RACK_COLUMN_SIZE / 2}
                    width={RACK_COLUMN_SIZE} height={RACK_COLUMN_SIZE}
                    className="rack-column"
                  />
                ))}
                {viewMode === 'dxf' ? (
                  // real DXF export labels every zone with its own name, not a
                  // generic "Pipe Rack"/"Road" — see backend write_dxf/_zone_layer.
                  <text x={cx} y={toY(cy) + 0.6} className="zone-label">{zone}</text>
                ) : (
                  <>
                    {kind === 'rack' && <text x={cx} y={toY(cy) + 0.6} className="rack-label">Pipe Rack</text>}
                    {kind === 'road' && <text x={cx} y={toY(cy) + 0.6} className="zone-label">Road</text>}
                  </>
                )}
                {/* vertex handles (square corners) + edge midpoint handles
                    (round) for the selected zone in Edit mode — drag a corner
                    to reshape, drag an edge midpoint to expand/shrink that
                    side. */}
                {selected && tool === 'edit' && poly.map(([x, y], i) => (
                  <rect
                    key={`v${i}`}
                    x={x - 0.8} y={toY(y) - 0.8} width={1.6} height={1.6}
                    className="zone-vert"
                    onPointerDown={(ev) => onPointerDownVert(zone, i, ev)}
                  />
                ))}
                {selected && tool === 'edit' && poly.map(([x, y], i) => {
                  const next = poly[(i + 1) % poly.length]
                  const mx = (x + next[0]) / 2
                  const my = (y + next[1]) / 2
                  // pick the resize cursor by the edge's dominant axis: an
                  // edge running along x resizes vertically (ns-resize), one
                  // running along y resizes horizontally (ew-resize).
                  const vertical = Math.abs(next[1] - y) > Math.abs(next[0] - x)
                  return (
                    <circle
                      key={`e${i}`} r={1.0}
                      cx={mx} cy={toY(my)}
                      className={`zone-edge ${vertical ? 'ew' : 'ns'}`}
                      onPointerDown={(ev) => onPointerDownEdge(zone, i, ev)}
                    />
                  )
                })}
              </g>
            )
          })}

          {/* one rounded outline per merged road cluster, drawn on top of the
              (now stroke-less) individual segments so the join reads as a
              single continuous road with a curb-radius turn, not a seam.
              pointer-events: none via CSS — clicks still hit the individual
              zone polygons underneath for select/edit. */}
          {viewMode !== 'dxf' && roadClusters.filter((c) => c.length > 1).map((cluster, ci) => {
            const rects = cluster.map((r) => r.bbox)
            const outline = unionRoadOutline(withCornerFills(rects))
            if (outline.length < 3) return null
            const convex = convexCornerFlags(outline)
            // outer curb radius = inner + road width (narrowest segment in
            // the cluster). A concave notch rounds tight (inner); the outer
            // swing of a bend rounds wide (outer); dead-end caps stay sharp.
            const widths = cluster.map((r) => Math.min(r.bbox.maxX - r.bbox.minX, r.bbox.maxY - r.bbox.minY))
            const outerRadius = ROAD_INNER_RADIUS_M + Math.min(...widths)
            const swing = outerSwingFlags(outline, convex, widths)
            const radii = outline.map((_, i) => (
              convex[i] ? (swing[i] ? outerRadius : 0) : ROAD_INNER_RADIUS_M
            ))
            return (
              <path
                key={`road-merge-${ci}`}
                d={roundedPolygonPath(outline, radii, toY)}
                className="zone-merge-outline"
              />
            )
          })}

          {/* pipe routing lines aren't part of the DXF export (write_dxf has
              no CONN layer) — hide them in DXF view for an accurate preview. */}
          {viewMode !== 'dxf' && connections.map((c, i) => {
            const a = positions[c.a]
            const b = positions[c.b]
            if (!a || !b) return null
            return <line key={i} x1={a.x} y1={toY(a.y)} x2={b.x} y2={toY(b.y)} className="conn" />
          })}

          {equipment.map((e) => {
            const p = positions[e.tag] ?? { x: e.x, y: e.y }
            const [x1, y1, x2, y2] = footprint(e, p)
            const pull = sideRect(x1, y1, x2, y2, e.pull_side, e.pull_len)
            const wind = e.cls === 'fired_heater' && site.wind_dir
              ? sideRect(x1, y1, x2, y2, site.wind_dir, windClearanceM)
              : null
            return (
              <g key={`${e.tag}-clearance`}>
                {pull && (
                  <rect
                    x={pull[0]} y={toY(pull[3])} width={pull[2] - pull[0]} height={pull[3] - pull[1]}
                    className="pull-zone"
                  />
                )}
                {wind && (
                  <rect
                    x={wind[0]} y={toY(wind[3])} width={wind[2] - wind[0]} height={wind[3] - wind[1]}
                    className="wind-zone"
                  />
                )}
              </g>
            )
          })}

          {equipment.map((e) => {
            const p = positions[e.tag] ?? { x: e.x, y: e.y }
            const violating = measure && measure.tag === e.tag && measure.gap < measure.need
            return (
              <g key={e.tag}>
                <rect
                  x={p.x - e.w / 2}
                  y={toY(p.y) - e.d / 2}
                  width={e.w}
                  height={e.d}
                  fill={viewMode === 'normal' ? (CLASS_COLOR[e.cls] ?? '#888') : 'none'}
                  className={`equip ${e.pinned ? 'pinned' : ''} ${violating ? 'violating' : ''}`}
                  onPointerDown={(ev) => onPointerDownEquip(e.tag, ev)}
                />
                <text x={p.x} y={toY(p.y) - e.d / 2 - 0.6} className="tag">{e.tag}</text>
              </g>
            )
          })}

          {measure && (() => {
            const [[ax, ay], [bx, by]] = measure.points
            const mx = (ax + bx) / 2
            const my = (ay + by) / 2
            const bad = measure.gap < measure.need
            return (
              <g className={`measure ${bad ? 'violating' : ''}`}>
                <line x1={ax} y1={toY(ay)} x2={bx} y2={toY(by)} className="measure-line" />
                <text x={mx} y={toY(my) - 1.4} className="measure-label">
                  {fmtM(measure.gap)}m (need {fmtM(measure.need)}m)
                </text>
              </g>
            )
          })()}

          {zoneDim && (() => {
            // Engineering-drawing dimensions: extension/guide lines from the
            // zone corners, dimension lines outside the zone with arrowheads,
            // value text breaking each dimension line. Width is dimensioned
            // along the top (and bottom), height along the left (and right).
            const { cx, cy, w, h } = zoneDim
            const x1 = cx - w / 2, x2 = cx + w / 2
            const y1 = cy - h / 2, y2 = cy + h / 2
            const dimTop = toY(y2) - DIM_OFFSET
            const dimBot = toY(y1) + DIM_OFFSET
            const dimLeft = x1 - DIM_OFFSET
            const dimRight = x2 + DIM_OFFSET
            const wTxt = `${fmtM(w)} m`
            const hTxt = `${fmtM(h)} m`
            const extYTop = [toY(y2) - EXT_GAP, dimTop - EXT_OVER]
            const extYBot = [toY(y1) + EXT_GAP, dimBot + EXT_OVER]
            const extXLeft = [x1 - EXT_GAP, dimLeft - EXT_OVER]
            const extXRight = [x2 + EXT_GAP, dimRight + EXT_OVER]
            return (
              <g className="zone-dim">
                {/* width: top dimension */}
                <line x1={x1} y1={extYTop[0]} x2={x1} y2={extYTop[1]} className="dim-ext" />
                <line x1={x2} y1={extYTop[0]} x2={x2} y2={extYTop[1]} className="dim-ext" />
                <line x1={x1} y1={dimTop} x2={cx - 2} y2={dimTop} className="dim-line" />
                <line x1={cx + 2} y1={dimTop} x2={x2} y2={dimTop} className="dim-line" />
                <polygon points={`${x1},${dimTop} ${x1 + ARROW},${dimTop - ARROW / 2} ${x1 + ARROW},${dimTop + ARROW / 2}`} className="dim-arrow" />
                <polygon points={`${x2},${dimTop} ${x2 - ARROW},${dimTop - ARROW / 2} ${x2 - ARROW},${dimTop + ARROW / 2}`} className="dim-arrow" />
                <text x={cx} y={dimTop + 0.5} className="dim-label">{wTxt}</text>
                {/* height: right dimension */}
                <line x1={extXRight[0]} y1={toY(y2)} x2={extXRight[1]} y2={toY(y2)} className="dim-ext" />
                <line x1={extXRight[0]} y1={toY(y1)} x2={extXRight[1]} y2={toY(y1)} className="dim-ext" />
                <line x1={dimRight} y1={toY(y2)} x2={dimRight} y2={toY(cy) - 2} className="dim-line" />
                <line x1={dimRight} y1={toY(cy) + 2} x2={dimRight} y2={toY(y1)} className="dim-line" />
                <polygon points={`${dimRight},${toY(y2)} ${dimRight - ARROW / 2},${toY(y2) - ARROW} ${dimRight + ARROW / 2},${toY(y2) - ARROW}`} className="dim-arrow" />
                <polygon points={`${dimRight},${toY(y1)} ${dimRight - ARROW / 2},${toY(y1) + ARROW} ${dimRight + ARROW / 2},${toY(y1) + ARROW}`} className="dim-arrow" />
                <text x={dimRight + 1.4} y={toY(cy)} className="dim-label" textAnchor="start">{hTxt}</text>
                {/* bottom + left extension lines (guide only, no value) */}
                <line x1={x1} y1={extYBot[0]} x2={x1} y2={extYBot[1]} className="dim-ext" />
                <line x1={x2} y1={extYBot[0]} x2={x2} y2={extYBot[1]} className="dim-ext" />
                <line x1={extXLeft[0]} y1={toY(y2)} x2={extXLeft[1]} y2={toY(y2)} className="dim-ext" />
                <line x1={extXLeft[0]} y1={toY(y1)} x2={extXLeft[1]} y2={toY(y1)} className="dim-ext" />
              </g>
            )
          })()}

          {drawRect && drawKind && drawStart.current && (() => {
            const a = [drawRect.x1, drawRect.y1]
            const b = [drawRect.x2, drawRect.y2]
            // ghost the zone exactly like a committed one (fill + label,
            // hatch too if it's a rack), just at reduced opacity, so the
            // user sees the final shape while placing the second point.
            const poly = centerlineRect(a, b, drawWidth)
            const [cx, cy] = centroid(poly)
            const hatch = drawKind === 'rack' ? rackHatchSegments(poly, RACK_HATCH_SPACING) : []
            return (
              <g className="zone-ghost">
                <polygon
                  points={poly.map(([x, y]) => `${x},${toY(y)}`).join(' ')}
                  className={`zone ${drawKind}`}
                />
                {hatch.map((l, i) => (
                  <line key={i} x1={l.x1} y1={toY(l.y1)} x2={l.x2} y2={toY(l.y2)} className="rack-hatch" />
                ))}
                {drawKind === 'rack' && <text x={cx} y={toY(cy) + 0.6} className="rack-label">Pipe Rack</text>}
                {drawKind === 'road' && <text x={cx} y={toY(cy) + 0.6} className="zone-label">Road</text>}
              </g>
            )
          })()}
        </svg>

        <Dialog
          open={drawPromptOpen}
          onOpenChange={(o) => { if (!o) { setDrawPromptOpen(false); setTool('select') } }}
          onInteractOutside={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Draw {drawDef ? drawDef.label : 'Zone'}</DialogTitle>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <Label htmlFor="draw-width" className="text-sm">
                {drawKind === 'rack' ? 'Rack width (m)'
                  : drawKind === 'road' ? 'Road width (m)'
                  : 'Zone width (m)'}
              </Label>
              <Input
                id="draw-width" type="number" min="0.1" step="0.5"
                value={drawPromptVal} autoFocus
                onChange={(e) => setDrawPromptVal(e.target.value)}
                className="w-24"
                onKeyDown={(e) => { if (e.key === 'Enter') confirmDrawWidth() }}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setDrawPromptOpen(false); setTool('select') }}>
                Cancel
              </Button>
              <Button onClick={confirmDrawWidth}>OK</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <ZoneEditDialog
          open={editOpen}
          zone={selectedZone}
          keepouts={keepouts}
          onOpenChange={setEditOpen}
          onRename={onEditZone}
          onDelete={(name) => { onDeleteZone(name); setSelectedZone(null); setEditOpen(false) }}
        />
      </div>
    </div>
  )
}

// Edit dialog for a selected zone: rename it and/or change its role. The
// zone's NAME is what drives its role in the backend (RACK*/ROAD*/MAINT*
// prefixes decide the DXF layer + whether it's a pipe rack spine), so
// changing the role just rewrites the name prefix; renaming to a free-text
// "Other" name makes it a generic keep-out (like the sample UNDERGROUND zone).
function ZoneEditDialog({ open, zone, keepouts, onOpenChange, onRename, onDelete }) {
  const [name, setName] = useState('')
  const [role, setRole] = useState('')

  useEffect(() => {
    if (!open || !zone) return
    setName(zone)
    const upper = zone.toUpperCase()
    const r = upper.startsWith('RACK') ? 'rack'
      : upper.startsWith('ROAD') ? 'road'
      : upper.startsWith('MAINT') ? 'maint'
      : upper.startsWith('UNDERGROUND') ? 'underground'
      : 'other'
    setRole(r)
  }, [open, zone])

  if (!zone) return null
  const poly = keepouts[zone] ?? []

  function apply() {
    const next = name.trim()
    if (!next || next === zone) { onOpenChange(false); return }
    onRename(zone, poly, next)
    setSelectedZone(next)
    onOpenChange(false)
  }

  function changeRole(r) {
    setRole(r)
    if (r === 'other') { setName('KEEPOUT_1'); return }
    const prefix = DRAW_KINDS[r].prefix
    const n = (zone.match(/(\d+)$/) ? zone.match(/(\d+)$/)[1] : '1')
    setName(`${prefix}_${n}`)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit zone</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label className="text-sm">Type / role</Label>
            <Select value={role} onValueChange={changeRole}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="road">Road</SelectItem>
                <SelectItem value="rack">Pipe Rack</SelectItem>
                <SelectItem value="maint">Maintenance</SelectItem>
                <SelectItem value="underground">Underground</SelectItem>
                <SelectItem value="other">Other (keep-out)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="zone-name" className="text-sm">Name</Label>
            <Input
              id="zone-name" value={name} autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') apply() }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {poly.length} vert{poly.length === 1 ? '' : 's'}. Drag a vertex on the
            canvas to reshape; the name prefix decides the role/layer.
          </p>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="destructive" onClick={() => onDelete(zone)}>Delete</Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={apply}>Apply</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export { CLASS_COLOR }

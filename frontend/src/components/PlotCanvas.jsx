import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { MAX_W, MIN_W, panBy, tickStep, ticksAtStep, zoomAt } from '@/lib/view'
import { buildSpacingMap, closestPair, footprint, sideRect, snapToBorder, snapToGrid, snapToObject } from '@/lib/geom'
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
const SOFT_SNAP_M = 1.0 // soft-snap to the site border when a dragged point is within this many meters
// Object-snap threshold in world meters — candidates (equipment centers,
// zone vertices) closer than this snap. Screen-pixel-independent: at a
// typical fit view (~80m site over ~800px) 1.5m ≈ 15px, which reads as a
// "magnetic" feel without grabbing things you didn't aim at. If a future
// unit renders so densely that 1.5m covers several candidates, the
// nearest-wins rule still does the right thing; promote to zoom-adaptive
// only if a real unit proves the fixed value feels wrong.
const OBJECT_SNAP_THRESH_M = 1.5
// If the last regularly-spaced beam interval lands closer than this to the
// rack's far end, skip that beam and draw one exactly at the end instead —
// avoids an awkward, oddly-short final bay.
const RACK_BEAM_END_MIN_GAP_M = 3
// Maximum INNER road-turn fillet radius, in meters (the tight notch on the
// inside of a bend). Fixed for now rather than derived — ponytail: promote
// to a per-project/user setting if it matters, plain constant is enough
// today. The OUTER curb radius of a 90-degree turn is this plus the road's
// own width (a car swings wide, so the outside arc is one lane bigger than
// the inside). Either is capped by whatever its adjacent road stubs actually
// allow (see roundedPolygonPath).
const ROAD_INNER_RADIUS_M = 8
// A zone-draw press+release with less movement than this (world meters)
// counts as a tap, not a drag, and inserts a sensible default shape instead
// of whatever near-zero-size shape the exact pointer positions would give.
const DRAW_TAP_THRESHOLD_M = 0.5
const DEFAULT_RECT_ZONE_SIZE_M = 10 // tap-to-insert size for maint/underground/keep-out (10m square, centered on the click)

// engineering-drawing dimension offsets (all in world meters)
const DIM_OFFSET = 3.0  // dimension line offset from the zone edge
const EXT_GAP = 0.5     // gap from zone corner to extension-line start
const EXT_OVER = 1.0    // extension-line overshoot past the dimension line
const ARROW = 1.2       // arrowhead open-angle size

// Compose the granular snap helpers into one drag-frame decision. Priority
// is object > grid > border — an object near a grid line wins because the
// user placed it there on purpose. Returns {x, y, snap} where `snap` is the
// winning snap point {x, y, kind} (for the indicator) or null (no snap
// applied / raw point kept). `mods` carries ev.altKey (suppress ALL snap
// for this frame) and ev.shiftKey (force ALL snap on for this frame).
// `cands` is the object-snap candidate list (equipment centers + zone
// vertices), precomputed by the caller via snapCandidates (below).
function applySnap(x, y, snap, mods, cands, stepX, stepY, site) {
  const on = mods.shiftKey || (!mods.altKey && (snap.grid || snap.objects || snap.borders))
  if (!on) return { x, y, snap: null }
  const flags = mods.shiftKey
    ? { grid: true, objects: true, borders: true }
    : mods.altKey
      ? { grid: false, objects: false, borders: false }
      : snap
  // object first (user intent), then grid, then border
  if (flags.objects && cands.length) {
    const s = snapToObject(x, y, cands, OBJECT_SNAP_THRESH_M)
    if (s) return { x: s.x, y: s.y, snap: s }
  }
  if (flags.grid) {
    const s = snapToGrid(x, y, stepX, stepY)
    if (s) return { x: s.x, y: s.y, snap: s }
  }
  if (flags.borders) {
    const s = snapToBorder(x, y, site.w, site.d, SOFT_SNAP_M)
    if (s) return { x: s.x, y: s.y, snap: s }
  }
  return { x, y, snap: null }
}

// tool -> the zone-name prefix it draws (see backend plotplan._rack_zones /
// _zone_layer — a zone's name prefix is the only thing that decides its
// role/layer; "RACK"/"ROAD"/"MAINT" mirror that same convention, while
// "UNDERGROUND"/"KEEPOUT" stay generic keep-out zones). `shape` picks the
// draw interaction, both a press-drag-release gesture with a tap shortcut:
// 'centerline' (drag a start/end line, given a width) for roads/racks where
// direction and width both matter — a plain tap drops a full-site-width
// horizontal line at that point; 'rect' (drag two opposite corners) for
// area-only zones with no meaningful direction — a tap drops a fixed-size
// square centered on the click (see DEFAULT_RECT_ZONE_SIZE_M).
const DRAW_KINDS = {
  road: { prefix: 'ROAD', label: 'Road', shape: 'centerline' },
  rack: { prefix: 'RACK', label: 'Pipe Rack', shape: 'centerline' },
  maint: { prefix: 'MAINT', label: 'Maintenance', shape: 'rect' },
  underground: { prefix: 'UNDERGROUND', label: 'Underground', shape: 'rect' },
  keepout: { prefix: 'KEEPOUT', label: 'Keep-out', shape: 'rect' },
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

// Cross-tie hatch segments for a rack rectangle, running ACROSS its width
// (perpendicular to its length) at `spacing` intervals. Anchored at the
// rectangle's own LEFT edge (wider-than-tall) or TOP edge (max Y — this app
// is north-up with a toY screen flip — taller-than-wide), derived from its
// bounding box rather than draw order, so a merged rack's spacing lines up
// the same regardless of which original zone/corner it grew from. For a
// rack in a merged cluster, pass `anchorD` = the near edge of its
// leftmost/topmost crossing square (in local d-coordinates) so beams radiate
// OUTWARD from the merge area in both directions instead of from the
// rack's own near edge — matches how a real rack's steel bays frame the
// crossing and spread out from it. If the last regular interval would land
// within RACK_BEAM_END_MIN_GAP_M of the far end, that beam snaps exactly to
// the end instead of leaving an awkwardly short final bay. `excludeDRanges`
// (local d-coordinates along the length axis, 0 = anchor) drops any beam
// that would fall inside another rack's footprint where this one crosses
// it — see rackCrossDRange.
function rackHatchSegments(poly, spacing, excludeDRanges = [], anchorD = 0) {
  if (!(spacing > 0)) return [] // guard against a bad (<=0/NaN) spacing value hanging the loop below
  const { minX, maxX, minY, maxY } = zoneBBox(poly)
  const w = maxX - minX
  const h = maxY - minY
  const horizontal = w >= h
  const len = horizontal ? w : h
  const halfW = (horizontal ? h : w) / 2
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const originX = horizontal ? minX : cx
  const originY = horizontal ? cy : maxY
  const ux = horizontal ? 1 : 0
  const uy = horizontal ? 0 : -1
  if (len < 1e-6) return []
  // beams at anchorD + k*spacing for every integer k whose beam falls inside
  // [0, len] — radiates outward from the anchor in both directions.
  const positions = []
  if (anchorD >= 0 && anchorD <= len) positions.push(anchorD)
  for (let k = 1; ; k++) {
    let d = anchorD + k * spacing
    if (d > len) break
    positions.push(d)
    d = anchorD - k * spacing
    if (d >= 0) positions.push(d)
  }
  positions.sort((a, b) => a - b)
  // snap a too-close-to-either-end final beam to that end — applies on both
  // the far end (last beam) and the near end (first beam), so an anchor that
  // happens to land near an edge still produces a clean edge beam.
  if (positions.length && positions[0] < RACK_BEAM_END_MIN_GAP_M) {
    positions[0] = 0
  }
  if (positions.length && len - positions[positions.length - 1] < RACK_BEAM_END_MIN_GAP_M) {
    positions[positions.length - 1] = len
  }
  // drop any regular beam that would run straight through the crossing
  // square, then frame that square instead — a beam exactly at each edge
  // (lo/hi) where it meets the rack it crosses, on all 4 sides once both
  // racks contribute their own two edges — so the crossing still reads as
  // supported structure, not just a gap.
  const kept = positions.filter((d) => !excludeDRanges.some(([lo, hi]) => d > lo && d < hi))
  excludeDRanges.forEach(([lo, hi]) => {
    ;[lo, hi].forEach((d) => {
      if (d >= 0 && d <= len && !kept.some((k) => Math.abs(k - d) < 1e-6)) kept.push(d)
    })
  })
  return kept.map((d) => {
    const px = originX + ux * d
    const py = originY + uy * d
    return {
      x1: px - uy * halfW, y1: py + ux * halfW,
      x2: px + uy * halfW, y2: py - ux * halfW,
    }
  })
}

// Convert another rack's footprint into an exclusion range along THIS
// rack's own length axis (same local d-coordinates rackHatchSegments uses),
// so its hatch can skip the square where the two racks actually cross —
// each rack keeps its own beams along its own length, just none land on
// top of whichever rack it crosses.
function rackCrossDRange(rackBBox, otherBBox) {
  const horizontal = rackBBox.maxX - rackBBox.minX >= rackBBox.maxY - rackBBox.minY
  if (horizontal) return [otherBBox.minX - rackBBox.minX, otherBBox.maxX - rackBBox.minX]
  // vertical: d increases as world Y decreases from the rack's top (maxY)
  return [rackBBox.maxY - otherBBox.maxY, rackBBox.maxY - otherBBox.minY]
}

// Build a zone rectangle from a centerline (start->end) and a width — used
// for roads and pipe racks (DRAW_KINDS shape: 'centerline'): it runs along
// the centerline and is `width` wide, split equally to either side. Returns
// [[x,y]...] in world coords.
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

// Build a zone rectangle directly from two opposite corners — used for
// maintenance/underground/keep-out zones (DRAW_KINDS shape: 'rect'), which
// have no meaningful direction the way a road/rack centerline does.
function rectFromCorners(a, b) {
  const minX = Math.min(a[0], b[0])
  const maxX = Math.max(a[0], b[0])
  const minY = Math.min(a[1], b[1])
  const maxY = Math.max(a[1], b[1])
  return [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]]
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

// Generic union-find clustering of zone entries {zone, poly, bbox} by a
// pairwise shouldMerge(bboxA, bboxB) predicate, so a chain transitively
// merges into one cluster even where not every pair directly satisfies the
// predicate (A merges with B, B merges with C -> one cluster of all three).
function clusterZones(entries, shouldMerge) {
  const n = entries.length
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (shouldMerge(entries[i].bbox, entries[j].bbox)) {
        const ri = find(i); const rj = find(j)
        if (ri !== rj) parent[ri] = rj
      }
    }
  }
  const groups = new Map()
  entries.forEach((e, i) => {
    const root = find(i)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(e)
  })
  return [...groups.values()]
}

// Road zones cluster on any overlap/touch, regardless of orientation — a
// chain of roads extending or turning should all read as one continuous road.
function clusterRoadZones(roadEntries) {
  return clusterZones(roadEntries, rectsOverlap)
}

// Unlike roads, pipe racks only merge where they actually CROSS (one
// horizontal, one vertical) — two racks extending the same line stay
// separate, distinct segments rather than silently fusing into one.
function isPerpendicular(a, b) {
  const aVert = a.maxX - a.minX <= a.maxY - a.minY
  const bVert = b.maxX - b.minX <= b.maxY - b.minY
  return aVert !== bVert
}

function clusterRackZones(rackEntries) {
  return clusterZones(rackEntries, (a, b) => rectsOverlap(a, b) && isPerpendicular(a, b))
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

export default function PlotCanvas({
  data, positions, onPositions, view, setView, showGrid, showRuler, gridStep, snap, tool, setTool,
  viewMode,
  rackWidth, setRackWidth, rackBeamSpacing, setRackBeamSpacing, roadWidth, setRoadWidth, drawPromptNonce,
  editPromptNonce, onCursor, onSize, onAddZone, onDeleteZone, onEditZone, onRenameZone,
  selectedZone, setSelectedZone, editMode,
  selectedEquip, setSelectedEquip, selectedEquips, setSelectedEquips, editEquipPromptNonce, onEditEquipment,
  realtimeMode, relaxLayout, flushRelax, onInteractionStart,
}) {
  const { equipment, connections, site, keepouts, spacing, wind_clearance_m: windClearanceM } = data
  const byTag = Object.fromEntries(equipment.map((e) => [e.tag, e]))
  const toY = (y) => site.d - y // north-up: flip y for SVG
  const spacingMap = useMemo(() => buildSpacingMap(spacing), [spacing])
  // Object-snap candidate points: every equipment center + every zone
  // vertex. Memoized on data/positions so a drag frame doesn't rebuild it
  // every pointermove (positions change every frame, but the candidate SET
  // for object-snap is the *other* items' positions + zone geometry, which
  // only changes when a different edit lands — fine to recompute then).
  const snapCands = useMemo(() => {
    const out = []
    for (const e of equipment) {
      const p = positions[e.tag] ?? { x: e.x, y: e.y }
      out.push([p.x, p.y])
    }
    for (const poly of Object.values(keepouts ?? {})) {
      for (const v of poly ?? []) out.push([v[0], v[1]])
    }
    return out
  }, [equipment, keepouts, positions])
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
  // pipe racks only cluster where they actually CROSS (see clusterRackZones)
  // — two racks extending the same line stay separate, distinct segments.
  const rackClusters = useMemo(() => {
    const rackEntries = Object.entries(keepouts ?? {})
      .filter(([z]) => z.toUpperCase().startsWith('RACK'))
      .map(([zone, poly]) => ({ zone, poly, bbox: zoneBBox(poly) }))
    return clusterRackZones(rackEntries)
  }, [keepouts])
  const rackClusterSize = useMemo(() => {
    const m = new Map()
    rackClusters.forEach((cluster) => cluster.forEach((r) => m.set(r.zone, cluster.length)))
    return m
  }, [rackClusters])

  // roads and pipe racks share the same two-click centerline+width draw
  // interaction (see DRAW_PREFIX); maintenance/underground/keep-out draw as
  // a plain two-corner rectangle instead (DRAW_KINDS shape: 'rect') and have
  // no width setting at all. Only rack/road ever read/write drawWidth.
  const drawKind = tool.startsWith('draw-') ? tool.slice(5) : null
  const drawDef = drawKind ? DRAW_KINDS[drawKind] : null
  const isRectDraw = drawDef?.shape === 'rect'
  const drawWidth = drawKind === 'rack' ? rackWidth : roadWidth
  const setDrawWidth = drawKind === 'rack' ? setRackWidth : setRoadWidth

  const wrapRef = useRef(null)
  const svgRef = useRef(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const dragTag = useRef(null) // single dragged equipment tag
  const dragGroup = useRef(null) // {tags:[...], offs:{tag:{dx,dy}}} multi-select dragged group
  // ponytail: commit the undo snapshot lazily — on the first pointermove
  // that actually moves something, not on pointer-down. A plain
  // select-click (down→up, no move) then commits nothing, so it leaves no
  // phantom undo step. Reset to false at every drag-start.
  const dragCommitted = useRef(false)
  const pan = useRef(null) // {x, y} last client pos while panning
  const dragZone = useRef(null) // {zone, offX, offY} while dragging a whole zone in edit mode
  const drawStart = useRef(null) // {x, y} world point where a zone-draw drag began
  const marqueeStart = useRef(null) // screen px {x,y} where a marquee selection drag began
  const [marqueeRect, setMarqueeRect] = useState(null) // live marquee preview (screen px)
  const [measure, setMeasure] = useState(null) // live closest-neighbor readout while dragging
  const [snapPoint, setSnapPoint] = useState(null) // live snap indicator {x, y, kind} while dragging, null when no snap applied
  const [zoneDim, setZoneDim] = useState(null) // {w, h, cx, cy} live width×height while resizing a zone
  const [drawRect, setDrawRect] = useState(null) // live press-drag-release preview {x1,y1,x2,y2}
  const [zoomRect, setZoomRect] = useState(null) // live drag-to-zoom rubber-band preview (screen px)
  const zoomStart = useRef(null) // screen px {x,y} where a drag-to-zoom began
  const [dragVert, setDragVert] = useState(null) // {zone, index} | {zone, edge} while dragging a vertex/edge handle
  const [editOpen, setEditOpen] = useState(false) // zone rename/role dialog
  const [editEquipOpen, setEditEquipOpen] = useState(false) // equipment properties dialog
  const [drawPromptOpen, setDrawPromptOpen] = useState(false)
  const [drawPromptVal, setDrawPromptVal] = useState(String(drawWidth))
  const [drawPromptSpacingVal, setDrawPromptSpacingVal] = useState(String(rackBeamSpacing)) // rack-only "Beam spacing (m)" field
  const [zoneDrawing, setZoneDrawing] = useState(false) // true while a zone-draw press-drag-release is in progress

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

  // native non-passive wheel listener so we can preventDefault the page
  // scroll. ponytail: coalesce a burst of wheel events (a mac trackpad
  // pinch or Ctrl+wheel fires 60+ small-deltaY events per second) into ONE
  // zoom per animation frame, with the factor scaled by the accumulated
  // deltaY — so a tiny trackpad delta gives a tiny zoom step instead of
  // the old fixed 0.9/1.1 step compounding 60x in a single gesture. The
  // exp() mapping is the standard map-viewer zoom curve (d3-zoom/leaflet):
  // perceptually uniform, deltaY sign sets direction, magnitude sets speed.
  // Cap the exponent so a violent flick can't jump more than ~25% per frame.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ZOOM_SENSITIVITY = 0.0015 // deltaY units -> exponent; tune if still too fast
    const ZOOM_MAX_EXP = 0.25 // cap per-frame zoom at e^0.25 ≈ 1.28x
    let acc = 0
    let px = 0
    let py = 0
    let rafId = 0
    const flush = () => {
      rafId = 0
      if (Math.abs(acc) < 1e-6) { acc = 0; return }
      const exp = Math.sign(acc) * Math.min(Math.abs(acc) * ZOOM_SENSITIVITY, ZOOM_MAX_EXP)
      const factor = Math.exp(exp)
      const rect = el.getBoundingClientRect()
      setView((v) => zoomAt(v, rect, px - rect.left, py - rect.top, factor))
      acc = 0
    }
    const onWheel = (e) => {
      e.preventDefault()
      acc += e.deltaY
      px = e.clientX
      py = e.clientY
      if (!rafId) rafId = requestAnimationFrame(flush)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      if (rafId) cancelAnimationFrame(rafId)
    }
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
  // button re-opens it. Rect-shape kinds have no width to prompt for — the
  // canvas is ready for the first corner click immediately.
  useEffect(() => {
    if (!drawKind || isRectDraw) return
    setDrawPromptVal(String(drawWidth))
    if (drawKind === 'rack') setDrawPromptSpacingVal(String(rackBeamSpacing))
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

  // Same pattern for the ribbon's Object > Edit button.
  useEffect(() => {
    if (!selectedEquip) return
    setEditEquipOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editEquipPromptNonce])

  function confirmDrawWidth() {
    const n = Number(drawPromptVal)
    if (Number.isFinite(n) && n > 0) setDrawWidth(n)
    if (drawKind === 'rack') {
      const s = Number(drawPromptSpacingVal)
      if (Number.isFinite(s) && s > 0) setRackBeamSpacing(s)
    }
    setDrawPromptOpen(false)
  }

  // Esc cancels an in-progress zone draw (mid press-drag-release) — but
  // never while the width prompt dialog is open.
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
    if (tool === 'zoom') {
      // drag-to-zoom: press records the start screen point, dragging
      // previews a rubber-band rectangle, release fits the viewBox to the
      // dragged world bbox (see onPointerUp). A plain tap (no real drag)
      // zooms IN 2x centered on the click instead.
      const rect = wrapRef.current.getBoundingClientRect()
      zoomStart.current = { x: ev.clientX - rect.left, y: ev.clientY - rect.top }
      setZoomRect({ x1: zoomStart.current.x, y1: zoomStart.current.y, x2: zoomStart.current.x, y2: zoomStart.current.y })
      capture(ev)
      return
    }
    if (DRAW_PREFIX[tool]) {
      // press-drag-release mode: press sets the start point, dragging
      // previews a custom shape, release commits it (see onPointerUp) — a
      // plain tap with no real movement commits a default shape instead.
      const p = svgPoint(svgRef.current, ev.clientX, ev.clientY)
      const w = { x: p.x, y: site.d - p.y }
      drawStart.current = w
      setDrawRect({ x1: w.x, y1: w.y, x2: w.x, y2: w.y })
      setZoneDrawing(true)
      capture(ev)
      return
    }
    if (tool === 'select' || tool === 'edit') setSelectedZone(null)
    if (tool === 'select') {
      // Start a marquee selection drag on empty canvas — the rect is tracked
      // in screen px (see onPointerMove/onPointerUp); on a plain click with
      // no real drag it just clears the selection (matches the old behavior).
      const rect = wrapRef.current.getBoundingClientRect()
      marqueeStart.current = { x: ev.clientX - rect.left, y: ev.clientY - rect.top }
      setMarqueeRect({ x1: marqueeStart.current.x, y1: marqueeStart.current.y, x2: marqueeStart.current.x, y2: marqueeStart.current.y })
      // don't clear yet — if a modifier-drag adds to the selection, clearing
      // first would lose the existing selection mid-drag. Cleared on a plain
      // click (no drag) in onPointerUp instead.
      capture(ev)
    }
  }

  function onPointerDownEquip(tag, ev) {
    // Equipment is selectable only in Select mode; pinned items can still be
    // selected (for rotating) even though they can't be dragged.
    if (tool !== 'select') return
    ev.stopPropagation()
    const shift = ev.shiftKey
    const ctrl = ev.ctrlKey || ev.metaKey
    // Multi-select modifiers:
    //  - plain click on an item already in the selection → keep the
    //    current selection and drag the whole group (don't drop to single
    //    until pointer-up if no drag happens, matching file managers).
    //  - plain click on a non-selected item → single-select that one.
    //  - ctrl+click → toggle membership in the selection (add or remove).
    //  - shift+click → add to the selection (don't toggle off).
    const already = selectedEquips.includes(tag)
    if (ctrl) {
      setSelectedEquips((s) => already ? s.filter((t) => t !== tag) : [...s, tag])
    } else if (shift) {
      if (!already) setSelectedEquips((s) => [...s, tag])
    } else if (!already) {
      setSelectedEquip(tag)
    }
    // drag the whole selection if the clicked item is part of it (and not
    // pinned); otherwise drag just this item after it's been selected.
    const group = (ctrl || shift || already) ? selectedEquips : [tag]
    const movable = group.filter((t) => t !== tag && !byTag[t]?.pinned)
    if (movable.length && !byTag[tag].pinned) {
      // record per-tag grab offsets so the whole group follows the cursor
      // without any item jumping on the first move: offset = pointer - tagPos,
      // applied on move as tagPos = pointer - offset.
      const p = svgPoint(svgRef.current, ev.clientX, ev.clientY)
      const px = p.x, py = site.d - p.y
      const offs = {}
      for (const t of movable) {
        const tp = positions[t] ?? { x: byTag[t].x, y: byTag[t].y }
        offs[t] = { dx: px - tp.x, dy: py - tp.y }
      }
      dragGroup.current = { tags: movable, offs }
    }
    if (byTag[tag].pinned) return
    dragTag.current = tag
    dragCommitted.current = false // commit deferred to first real move
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
    dragCommitted.current = false // commit deferred to first real move
    capture(ev)
  }

  function onPointerDownVert(zone, index, ev) {
    // Reshape a zone by dragging a vertex — Edit mode only.
    if (tool !== 'edit') return
    ev.stopPropagation()
    setSelectedZone(zone)
    setDragVert({ zone, index })
    dragCommitted.current = false // commit deferred to first real move
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
    dragCommitted.current = false // commit deferred to first real move
    capture(ev)
  }

  function onPointerMove(ev) {
    reportCursor(ev)
    // Lazy undo commit: a drag-start sets dragCommitted=false; the first
    // move frame that actually moves a target fires the snapshot here,
    // so a pure select-click (down→up, no move) leaves no phantom undo
    // step. Only the equip/zone/vertex/edge drags use this — pan/marquee/
    // zoom/draw don't mutate data/positions and never called
    // onInteractionStart to begin with.
    if (!dragCommitted.current && (dragTag.current || dragZone.current || dragVert)) {
      onInteractionStart?.()
      dragCommitted.current = true
    }
    if (pan.current) {
      const rect = wrapRef.current.getBoundingClientRect()
      const dx = ev.clientX - pan.current.x
      const dy = ev.clientY - pan.current.y
      pan.current = { x: ev.clientX, y: ev.clientY }
      setView((v) => panBy(v, rect, dx, dy))
      return
    }
    if (marqueeStart.current) {
      const rect = wrapRef.current.getBoundingClientRect()
      const x = ev.clientX - rect.left
      const y = ev.clientY - rect.top
      setMarqueeRect({ x1: marqueeStart.current.x, y1: marqueeStart.current.y, x2: x, y2: y })
      return
    }
    if (dragVert) {
      const p = svgPoint(svgRef.current, ev.clientX, ev.clientY)
      const r = applySnap(p.x, site.d - p.y, snap, { altKey: ev.altKey, shiftKey: ev.shiftKey },
                         snapCands, xt.minorStep, yt.minorStep, site)
      let x = r.x
      let y = r.y
      setSnapPoint(r.snap)
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
      const r = applySnap(p.x + dragZone.current.ox, (site.d - p.y) + dragZone.current.oy,
                          snap, { altKey: ev.altKey, shiftKey: ev.shiftKey },
                          snapCands, xt.minorStep, yt.minorStep, site)
      let x = r.x
      let y = r.y
      setSnapPoint(r.snap)
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
    if (zoomStart.current) {
      const rect = wrapRef.current.getBoundingClientRect()
      const x = ev.clientX - rect.left
      const y = ev.clientY - rect.top
      setZoomRect({ x1: zoomStart.current.x, y1: zoomStart.current.y, x2: x, y2: y })
      return
    }
    if (drawStart.current) {
      // keep the start fixed; the cursor drives the other point so the ghost
      // preview follows the pointer — a free corner for rect shapes, snapped
      // to the nearer axis for a road/rack centerline.
      const p = svgPoint(svgRef.current, ev.clientX, ev.clientY)
      const wy = site.d - p.y
      const [ex, ey] = isRectDraw
        ? [p.x, wy]
        : snapAxisAligned([drawStart.current.x, drawStart.current.y], [p.x, wy])
      setDrawRect({ x1: drawStart.current.x, y1: drawStart.current.y, x2: ex, y2: ey })
      // rect zones get the same engineering-dimension guide shown while
      // resizing an existing zone — road/rack don't (see zoneDim render).
      if (isRectDraw) {
        setZoneDim({
          w: Math.abs(ex - drawStart.current.x),
          h: Math.abs(ey - drawStart.current.y),
          cx: (drawStart.current.x + ex) / 2,
          cy: (drawStart.current.y + ey) / 2,
        })
      }
      return
    }
    const tag = dragTag.current
    if (!tag) return
    const p = svgPoint(svgRef.current, ev.clientX, ev.clientY)
    const mods = { altKey: ev.altKey, shiftKey: ev.shiftKey }
    const r = applySnap(p.x, site.d - p.y, snap, mods, snapCands, xt.minorStep, yt.minorStep, site)
    const x = r.x
    const y = r.y
    setSnapPoint(r.snap)
    // Move the primary dragged tag, plus every tag in the multi-drag group
    // by the SAME world delta (each kept at its own grab offset so the group
    // translates rigidly — no relative drift between selected items). The
    // snap is applied to the primary point only; group members keep their
    // relative offsets, so object-snapping the primary onto a neighbor
    // translates the whole group by the same snapped delta.
    const dg = dragGroup.current
    const ddx = x - p.x
    const ddy = y - (site.d - p.y)
    let nextPositions
    if (dg?.offs) {
      nextPositions = { ...positions, [tag]: { x, y } }
      for (const t of dg.tags) {
        const o = dg.offs[t]
        if (!o) continue
        nextPositions[t] = { x: p.x - o.dx + ddx, y: (site.d - p.y) - o.dy + ddy }
      }
    } else {
      nextPositions = { ...positions, [tag]: { x, y } }
    }
    onPositions(nextPositions)
    // Mode 2 (PLAN.md items 16-17): throttled POST /api/relax alongside the
    // instant /score feedback above — relax's reflowed positions (everyone
    // else moved out of the way, not just the dragged tag) land a beat
    // later and supersede this frame's local-only update.
    if (realtimeMode) relaxLayout(tag, x, y)
    const pair = closestPair(tag, nextPositions, equipment, spacingMap)
    setMeasure(pair && { ...pair, tag })
  }

  function onPointerUp(ev) {
    // "commit on drop": flush any pending throttled /relax call now, before
    // clearing dragTag, so the final reflow matches the exact drop position
    // instead of waiting out the rest of the throttle window.
    if (realtimeMode && dragTag.current) flushRelax()

    // Marquee selection: a select-mode pointer-up on empty canvas either
    // commits a marquee (drag > a few px) or — for a plain click with no
    // modifier — clears the selection (the old empty-space-click behavior).
    // shift/ctrl modifiers union the marquee hits with the existing
    // selection instead of replacing it.
    if (marqueeStart.current) {
      const rect = wrapRef.current.getBoundingClientRect()
      const sx = marqueeStart.current.x
      const sy = marqueeStart.current.y
      const ex = ev.clientX - rect.left
      const ey = ev.clientY - rect.top
      const dx = Math.abs(ex - sx)
      const dy = Math.abs(ey - sy)
      const mod = ev.shiftKey || ev.ctrlKey || ev.metaKey
      if (dx < 3 && dy < 3) {
        if (!mod) setSelectedEquip(null)
      } else {
        // convert screen rect -> world bbox (y flipped for SVG)
        const x1w = v.x + (Math.min(sx, ex) / rect.width) * v.w
        const x2w = v.x + (Math.max(sx, ex) / rect.width) * v.w
        const y1w = v.y + (Math.min(sy, ey) / rect.height) * v.h
        const y2w = v.y + (Math.max(sy, ey) / rect.height) * v.h
        const hits = equipment.filter((e) => {
          const p = positions[e.tag] ?? { x: e.x, y: e.y }
          const [fx1, fy1, fx2, fy2] = footprint(e, p)
          // footprint uses world y-up; marquee bbox is in the same
          // world-up space (v.y is the SVG viewBox y, which is world y
          // after the toY flip only matters for rendering — v.y/v.h are
          // already in the flipped SVG coordinate system, so invert).
          // Convert footprint y from world-up to SVG-y for the test:
          const sfy1 = site.d - fy2
          const sfy2 = site.d - fy1
          return fx1 < x2w && fx2 > x1w && sfy1 < y2w && sfy2 > y1w
        }).map((e) => e.tag)
        if (mod) setSelectedEquips((s) => [...new Set([...s, ...hits])])
        else setSelectedEquips(hits)
      }
      marqueeStart.current = null
      setMarqueeRect(null)
    }

    pan.current = null
    dragTag.current = null
    dragGroup.current = null
    dragZone.current = null
    setDragVert(null)
    setMeasure(null)
    setZoneDim(null)
    setSnapPoint(null)

    if (zoomStart.current) {
      const rect = wrapRef.current.getBoundingClientRect()
      const sx = zoomStart.current.x
      const sy = zoomStart.current.y
      const ex = ev.clientX - rect.left
      const ey = ev.clientY - rect.top
      const dx = Math.abs(ex - sx)
      const dy = Math.abs(ey - sy)
      // ponytail: a tap (no real drag) zooms IN 2x centered on the click,
      // matching every map viewer's click-to-zoom-in convention; a drag
      // fits the viewBox to the dragged world bbox, aspect-corrected to
      // the canvas (height tracks width via the canvas aspect so the
      // selected area isn't stretched — preserveAspectRatio="none" would
      // otherwise distort it).
      if (dx < 3 && dy < 3) {
        setView((v) => zoomAt(v, rect, sx, sy, 0.5))
      } else {
        const x1 = Math.min(sx, ex), x2 = Math.max(sx, ex)
        const y1 = Math.min(sy, ey), y2 = Math.max(sy, ey)
        const w = ((x2 - x1) / rect.width) * view.w
        const h = ((y2 - y1) / rect.height) * view.h
        if (w > 0 && h > 0) {
          const aspect = rect.height / rect.width
          // grow the smaller axis so the viewBox aspect matches the canvas
          // (no distortion) while keeping the dragged rect's CENTER fixed.
          let fw = w, fh = h
          if (fw / fh > 1 / aspect) fh = fw * aspect
          else fw = fh / aspect
          const cxw = view.x + ((x1 + x2) / 2 / rect.width) * view.w
          const cyw = view.y + ((y1 + y2) / 2 / rect.height) * view.h
          const clampedW = Math.min(Math.max(fw, MIN_W), MAX_W)
          const clampedH = clampedW * aspect
          setView({ x: cxw - clampedW / 2, y: cyw - clampedH / 2, w: clampedW, h: clampedH })
        }
      }
      zoomStart.current = null
      setZoomRect(null)
    }

    if (drawStart.current) {
      const start = drawStart.current
      const p = svgPoint(svgRef.current, ev.clientX, ev.clientY)
      const end = { x: p.x, y: site.d - p.y }
      const isTap = Math.hypot(end.x - start.x, end.y - start.y) < DRAW_TAP_THRESHOLD_M
      let poly
      if (isRectDraw) {
        const half = DEFAULT_RECT_ZONE_SIZE_M / 2
        poly = isTap
          ? rectFromCorners([start.x - half, start.y - half], [start.x + half, start.y + half])
          : rectFromCorners([start.x, start.y], [end.x, end.y])
      } else if (isTap) {
        // quick-add: a centerline spanning the full site width, horizontal,
        // at the click's y.
        poly = centerlineRect([0, start.y], [site.w, start.y], drawWidth)
      } else {
        poly = centerlineRect([start.x, start.y], snapAxisAligned([start.x, start.y], [end.x, end.y]), drawWidth)
      }
      const name = nextZoneName(keepouts, DRAW_PREFIX[tool])
      onAddZone(name, poly)
      drawStart.current = null
      setDrawRect(null)
      setZoneDrawing(false)
      setTool('select') // one shot: back to Select after placing a zone
    }
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
          role="application"
          aria-label="Site layout canvas — drag equipment to reposition, switch tools via the ribbon"
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
            const selected = selectedZone === zone
            // A road/rack that's part of a multi-member merged cluster (see
            // roadClusters/rackClusters) drops its own stroke (and, for
            // racks, its hatch/columns/label too) — the merged shape drawn
            // after this loop supplies the boundary (and for racks, the
            // single unified hatch pattern) instead, so no seam or duplicate
            // beam shows at the join. Real DXF export never merges (each
            // zone is its own separate LINE outline), so skip this in DXF
            // view and keep every zone's true individual boundary/hatch.
            const clusterSize = kind === 'road' ? (roadClusterSize.get(zone) ?? 1)
              : kind === 'rack' ? (rackClusterSize.get(zone) ?? 1)
              : 1
            const quiet = (kind === 'road' || kind === 'rack') && viewMode !== 'dxf' && clusterSize > 1
            const hatch = kind === 'rack' && !quiet ? rackHatchSegments(poly, rackBeamSpacing) : []
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
                {viewMode === 'dxf' ? (
                  // real DXF export labels every zone with its own name, not a
                  // generic "Pipe Rack"/"Road" — see backend write_dxf/_zone_layer.
                  <text x={cx} y={toY(cy) + 0.6} className="zone-label">{zone}</text>
                ) : (
                  <>
                    {kind === 'rack' && !quiet && <text x={cx} y={toY(cy) + 0.6} className="rack-label">Pipe Rack</text>}
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

          {/* Pipe racks only merge where they actually cross (see
              clusterRackZones) — into the true L/T/+ union of the actual
              footprints (reusing withCornerFills/unionRoadOutline from the
              road merge, minus any rounding — racks are structural corridors,
              not vehicle paths, so sharp corners are fine), never a bounding
              rectangle that could balloon past what either rack actually
              covers. Each original rack still draws its OWN beam pattern
              along its own length (anchored left/top, see rackHatchSegments)
              — only the square where it actually crosses another rack in the
              cluster is excluded (see rackCrossDRange), so no beam lands on
              top of the rack it crosses. */}
          {viewMode !== 'dxf' && rackClusters.filter((c) => c.length > 1).map((cluster, ci) => {
            const rects = cluster.map((r) => r.bbox)
            const outline = unionRoadOutline(withCornerFills(rects))
            if (outline.length < 3) return null
            const [cx, cy] = centroid(outline)
            const hatch = cluster.flatMap((r) => {
              const crossings = cluster
                .filter((other) => other !== r && rectsOverlap(r.bbox, other.bbox))
              const excludeDRanges = crossings.map((other) => rackCrossDRange(r.bbox, other.bbox))
              // anchor at the near edge of the leftmost (horizontal rack) or
              // topmost (vertical rack) crossing square — beams radiate
              // outward from the merge area, and if a rack has 2 crossings,
              // from the one closer to the rack's own anchor end.
              const anchorD = crossings.length
                ? Math.min(...excludeDRanges.map(([lo]) => lo))
                : 0
              return rackHatchSegments(r.poly, rackBeamSpacing, excludeDRanges, anchorD)
            })
            return (
              <g key={`rack-merge-${ci}`}>
                <polygon
                  points={outline.map(([x, y]) => `${x},${toY(y)}`).join(' ')}
                  className="rack-merge-fill"
                />
                {hatch.map((l, i) => (
                  <line key={i} x1={l.x1} y1={toY(l.y1)} x2={l.x2} y2={toY(l.y2)} className="rack-hatch" />
                ))}
                <text x={cx} y={toY(cy) + 0.6} className="rack-label">Pipe Rack</text>
              </g>
            )
          })}

          {/* pipe routing lines aren't part of the DXF export (write_dxf has
              no CONN layer) — hide them in DXF view for an accurate preview.
              Drawn nozzle-to-nozzle (matching piping_cost()'s formula) when
              the endpoint defines a nozzle offset, else center-to-center. */}
          {viewMode !== 'dxf' && connections.map((c, i) => {
            const ea = byTag[c.a]
            const eb = byTag[c.b]
            const a = positions[c.a]
            const b = positions[c.b]
            if (!a || !b || !ea || !eb) return null
            const ax = a.x + (ea.nozzle_dx || 0)
            const ay = a.y + (ea.nozzle_dy || 0)
            const bx = b.x + (eb.nozzle_dx || 0)
            const by = b.y + (eb.nozzle_dy || 0)
            return <line key={i} x1={ax} y1={toY(ay)} x2={bx} y2={toY(by)} className="conn" />
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
                  className={`equip ${e.pinned ? 'pinned' : ''} ${violating ? 'violating' : ''} ${selectedEquips.includes(e.tag) ? 'selected' : ''}`}
                  onPointerDown={(ev) => onPointerDownEquip(e.tag, ev)}
                >
                  <title>{e.tag} — {e.cls} {e.w}×{e.d} m{e.pinned ? ' (pinned)' : ''}</title>
                </rect>
                <text
                  x={p.x} y={toY(p.y) - e.d / 2 - 0.6}
                  className={`tag ${selectedEquips.includes(e.tag) ? 'selected' : ''}`}
                >
                  {e.tag}
                </text>
                {(e.nozzle_dx || e.nozzle_dy) && (
                  <circle
                    cx={p.x + (e.nozzle_dx || 0)} cy={toY(p.y + (e.nozzle_dy || 0))}
                    r={0.5} className="nozzle"
                  />
                )}
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
                  {fmtM(measure.gap)}{'\u00a0'}m (need {fmtM(measure.need)}{'\u00a0'}m)
                </text>
              </g>
            )
          })()}

          {/* Snap indicator: a crosshair at the live snap point, colored by
              what was snapped to (grid gray / border blue / object amber). Only
              shown while a drag is actively snapping — hidden in DXF view like
              the measurement guides (not part of the export). */}
          {viewMode !== 'dxf' && snapPoint && (
            <g className={`snap-indicator snap-${snapPoint.kind}`} pointerEvents="none">
              <line x1={snapPoint.x - 2} y1={toY(snapPoint.y)} x2={snapPoint.x + 2} y2={toY(snapPoint.y)} />
              <line x1={snapPoint.x} y1={toY(snapPoint.y) - 2} x2={snapPoint.x} y2={toY(snapPoint.y) + 2} />
              <circle cx={snapPoint.x} cy={toY(snapPoint.y)} r={0.4} />
            </g>
          )}

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
            const wTxt = `${fmtM(w)}\u00a0m`
            const hTxt = `${fmtM(h)}\u00a0m`
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
            const poly = isRectDraw ? rectFromCorners(a, b) : centerlineRect(a, b, drawWidth)
            const [cx, cy] = centroid(poly)
            const hatch = drawKind === 'rack' ? rackHatchSegments(poly, rackBeamSpacing) : []
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

        {zoomRect && (
          <div
            className="zoom-rect"
            style={{
              left: Math.min(zoomRect.x1, zoomRect.x2),
              top: Math.min(zoomRect.y1, zoomRect.y2),
              width: Math.abs(zoomRect.x2 - zoomRect.x1),
              height: Math.abs(zoomRect.y2 - zoomRect.y1),
            }}
          />
        )}

        {marqueeRect && (
          <div
            className="marquee-rect"
            style={{
              left: Math.min(marqueeRect.x1, marqueeRect.x2),
              top: Math.min(marqueeRect.y1, marqueeRect.y2),
              width: Math.abs(marqueeRect.x2 - marqueeRect.x1),
              height: Math.abs(marqueeRect.y2 - marqueeRect.y1),
            }}
          />
        )}

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
            {drawKind === 'rack' && (
              <div className="flex items-center gap-2">
                <Label htmlFor="draw-spacing" className="text-sm">Beam spacing (m)</Label>
                <Input
                  id="draw-spacing" type="number" min="0.5" step="0.5"
                  value={drawPromptSpacingVal}
                  onChange={(e) => setDrawPromptSpacingVal(e.target.value)}
                  className="w-24"
                  onKeyDown={(e) => { if (e.key === 'Enter') confirmDrawWidth() }}
                />
              </div>
            )}
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
          onRename={onRenameZone ?? onEditZone}
          onDelete={(name) => { onDeleteZone(name); setSelectedZone(null); setEditOpen(false) }}
        />

        <EquipEditDialog
          open={editEquipOpen}
          equip={selectedEquip ? byTag[selectedEquip] : null}
          onOpenChange={setEditEquipOpen}
          onSave={onEditEquipment}
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

// Edit dialog for a selected equipment: class, footprint size, pinned, and
// tube-pull clearance. Deliberately does NOT include the tag/ID — see
// editEquipment's own comment in App.jsx for why a rename is out of scope
// here — or position (x/y), same reasoning as the zone dialog above: that's
// what dragging on the canvas is for.
function EquipEditDialog({ open, equip, onOpenChange, onSave }) {
  const [cls, setCls] = useState('')
  const [w, setW] = useState('')
  const [d, setD] = useState('')
  const [pinned, setPinned] = useState(false)
  const [pullSide, setPullSide] = useState('')
  const [pullLen, setPullLen] = useState('')
  const [nozzleDx, setNozzleDx] = useState('')
  const [nozzleDy, setNozzleDy] = useState('')

  useEffect(() => {
    if (!open || !equip) return
    setCls(equip.cls)
    setW(String(equip.w))
    setD(String(equip.d))
    setPinned(!!equip.pinned)
    setPullSide(equip.pull_side || '')
    setPullLen(String(equip.pull_len || 0))
    setNozzleDx(String(equip.nozzle_dx || 0))
    setNozzleDy(String(equip.nozzle_dy || 0))
  }, [open, equip])

  if (!equip) return null

  function apply() {
    const wNum = Number(w), dNum = Number(d), pullLenNum = Number(pullLen)
    const ndx = Number(nozzleDx), ndy = Number(nozzleDy)
    onSave(equip.tag, {
      cls,
      w: Number.isFinite(wNum) && wNum > 0 ? wNum : equip.w,
      d: Number.isFinite(dNum) && dNum > 0 ? dNum : equip.d,
      pinned,
      pull_side: pullSide,
      pull_len: pullSide && Number.isFinite(pullLenNum) && pullLenNum > 0 ? pullLenNum : 0,
      nozzle_dx: Number.isFinite(ndx) ? ndx : 0,
      nozzle_dy: Number.isFinite(ndy) ? ndy : 0,
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {equip.tag}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label className="text-sm">Class</Label>
            <Select value={cls} onValueChange={setCls}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.keys(CLASS_COLOR).map((c) => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="equip-w" className="text-sm">Width (m)</Label>
              <Input
                id="equip-w" type="number" min="0.1" step="0.1" value={w}
                onChange={(e) => setW(e.target.value)} className="w-24"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="equip-d" className="text-sm">Depth (m)</Label>
              <Input
                id="equip-d" type="number" min="0.1" step="0.1" value={d}
                onChange={(e) => setD(e.target.value)} className="w-24"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
            Pinned (fixed position, solver won't move it)
          </label>
          <div className="flex items-center gap-2">
            <div className="flex flex-col gap-1">
              <Label className="text-sm">Pull side</Label>
              <Select value={pullSide || 'none'} onValueChange={(v) => setPullSide(v === 'none' ? '' : v)}>
                <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="x+">x+</SelectItem>
                  <SelectItem value="x-">x-</SelectItem>
                  <SelectItem value="y+">y+</SelectItem>
                  <SelectItem value="y-">y-</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="equip-pull-len" className="text-sm">Pull length (m)</Label>
              <Input
                id="equip-pull-len" type="number" min="0" step="0.5" value={pullLen}
                onChange={(e) => setPullLen(e.target.value)} disabled={!pullSide} className="w-24"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="equip-nozzle-dx" className="text-sm">Nozzle dx (m)</Label>
              <Input
                id="equip-nozzle-dx" type="number" step="0.1" value={nozzleDx}
                onChange={(e) => setNozzleDx(e.target.value)} className="w-24"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="equip-nozzle-dy" className="text-sm">Nozzle dy (m)</Label>
              <Input
                id="equip-nozzle-dy" type="number" step="0.1" value={nozzleDy}
                onChange={(e) => setNozzleDy(e.target.value)} className="w-24"
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={apply}>Apply</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export { CLASS_COLOR }

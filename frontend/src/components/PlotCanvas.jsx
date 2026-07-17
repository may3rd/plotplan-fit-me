import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { panBy, tickStep, ticksAtStep, zoomAt } from '@/lib/view'
import { buildSpacingMap, closestPair, footprint, sideRect } from '@/lib/geom'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'

const CLASS_COLOR = {
  fired_heater: '#e05a47',
  column: '#4a7fd6',
  vessel: '#3fa66b',
  exchanger: '#c98a2b',
  pump_hc: '#8a5fd6',
}

const RULER = 26 // px thickness of each ruler strip
const RACK_HATCH_SPACING = 4 // meters between pipe-rack cross-tie lines

// tool -> the zone-name prefix it draws (see backend plotplan._rack_zones /
// _zone_layer — a zone's name prefix is the only thing that decides its
// role, "RACK"/"ROAD" here mirror that same convention).
const DRAW_PREFIX = { 'draw-road': 'ROAD', 'draw-rack': 'RACK' }

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

export default function PlotCanvas({
  data, positions, onPositions, view, setView, showGrid, showRuler, gridStep, snap, tool, setTool,
  rackWidth, setRackWidth, roadWidth, setRoadWidth, drawPromptNonce,
  onCursor, onSize, onAddZone, onDeleteZone,
}) {
  const { equipment, connections, site, keepouts, spacing, wind_clearance_m: windClearanceM } = data
  const byTag = Object.fromEntries(equipment.map((e) => [e.tag, e]))
  const toY = (y) => site.d - y // north-up: flip y for SVG
  const spacingMap = useMemo(() => buildSpacingMap(spacing), [spacing])

  // roads and pipe racks share the exact same two-click centerline+width
  // draw interaction (see DRAW_PREFIX) — only the width preference, zone
  // name prefix, and rendered style (hatch/label/color) differ per kind.
  const drawKind = tool === 'draw-rack' ? 'rack' : tool === 'draw-road' ? 'road' : null
  const drawWidth = drawKind === 'rack' ? rackWidth : roadWidth
  const setDrawWidth = drawKind === 'rack' ? setRackWidth : setRoadWidth

  const wrapRef = useRef(null)
  const svgRef = useRef(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const dragTag = useRef(null)
  const pan = useRef(null) // {x, y} last client pos while panning
  const drawStart = useRef(null) // {x, y} world point where a zone-draw drag began
  const [measure, setMeasure] = useState(null) // live closest-neighbor readout while dragging
  const [drawRect, setDrawRect] = useState(null) // live two-click centerline preview {x1,y1,x2,y2}
  const [selectedZone, setSelectedZone] = useState(null)
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
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedZone, onDeleteZone])

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
    if (tool === 'select') setSelectedZone(null)
  }

  function onPointerDownEquip(tag, ev) {
    if (tool !== 'select' || byTag[tag].pinned) return
    ev.stopPropagation()
    dragTag.current = tag
    capture(ev)
  }

  function onPointerDownZone(zone, ev) {
    if (tool !== 'select') return
    ev.stopPropagation()
    setSelectedZone(zone)
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
    setMeasure(null)
    // A road/rack draw is committed by the second click (onPointerDownBg),
    // not by releasing the pointer — nothing else to do here.
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
          width="100%"
          height="100%"
          viewBox={`${v.x} ${v.y} ${v.w} ${v.h}`}
          preserveAspectRatio="none"
          onPointerDown={onPointerDownBg}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => onCursor(null)}
        >
          {showGrid && (
            <g className="grid-minor">
              {xt.minorOut.map((wx) => (
                <line key={`gxm${wx}`} x1={wx} y1={v.y} x2={wx} y2={v.y + v.h} />
              ))}
              {yt.minorOut.map((sy) => (
                <line key={`gym${sy}`} x1={v.x} y1={sy} x2={v.x + v.w} y2={sy} />
              ))}
            </g>
          )}
          {showGrid && (
            <g className="grid">
              {xt.out.map((wx) => (
                <line key={`gx${wx}`} x1={wx} y1={v.y} x2={wx} y2={v.y + v.h} />
              ))}
              {yt.out.map((sy) => (
                <line key={`gy${sy}`} x1={v.x} y1={sy} x2={v.x + v.w} y2={sy} />
              ))}
            </g>
          )}

          <rect x={0} y={0} width={site.w} height={site.d} className="site" />

          {Object.entries(keepouts ?? {}).map(([zone, poly]) => {
            const upper = zone.toUpperCase()
            const kind = upper.startsWith('RACK') ? 'rack'
              : upper.startsWith('ROAD') ? 'road'
              : upper.startsWith('MAINT') ? 'maint' : 'keepout'
            const [cx, cy] = centroid(poly)
            const hatch = kind === 'rack' ? rackHatchSegments(poly, RACK_HATCH_SPACING) : []
            return (
              <g key={zone}>
                <polygon
                  points={poly.map(([x, y]) => `${x},${toY(y)}`).join(' ')}
                  className={`zone ${kind} ${selectedZone === zone ? 'selected' : ''}`}
                  onPointerDown={(ev) => onPointerDownZone(zone, ev)}
                />
                {hatch.map((l, i) => (
                  <line key={i} x1={l.x1} y1={toY(l.y1)} x2={l.x2} y2={toY(l.y2)} className="rack-hatch" />
                ))}
                {kind === 'rack' && <text x={cx} y={toY(cy) + 0.6} className="rack-label">Pipe Rack</text>}
                {kind === 'road' && <text x={cx} y={toY(cy) + 0.6} className="zone-label">Road</text>}
              </g>
            )
          })}

          {connections.map((c, i) => {
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
                  fill={CLASS_COLOR[e.cls] ?? '#888'}
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
              <DialogTitle>{drawKind === 'rack' ? 'Draw Pipe Rack' : 'Draw Road'}</DialogTitle>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <Label htmlFor="draw-width" className="text-sm">
                {drawKind === 'rack' ? 'Rack width (m)' : 'Road width (m)'}
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
      </div>
    </div>
  )
}

export { CLASS_COLOR }

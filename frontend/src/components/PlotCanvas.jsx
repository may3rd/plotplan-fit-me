import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { panBy, ticks, zoomAt } from '@/lib/view'
import { buildSpacingMap, closestPair, footprint, sideRect } from '@/lib/geom'

const CLASS_COLOR = {
  fired_heater: '#e05a47',
  column: '#4a7fd6',
  vessel: '#3fa66b',
  exchanger: '#c98a2b',
  pump_hc: '#8a5fd6',
}

const RULER = 26 // px thickness of each ruler strip
const RACK_HATCH_SPACING = 4 // meters between pipe-rack cross-tie lines

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

export default function PlotCanvas({
  data, positions, onPositions, view, setView, showGrid, showRuler, gridStep, snap, tool, onCursor, onSize,
}) {
  const { equipment, connections, site, keepouts, spacing, wind_clearance_m: windClearanceM } = data
  const byTag = Object.fromEntries(equipment.map((e) => [e.tag, e]))
  const toY = (y) => site.d - y // north-up: flip y for SVG
  const spacingMap = useMemo(() => buildSpacingMap(spacing), [spacing])

  const wrapRef = useRef(null)
  const svgRef = useRef(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const dragTag = useRef(null)
  const pan = useRef(null) // {x, y} last client pos while panning
  const [measure, setMeasure] = useState(null) // live closest-neighbor readout while dragging

  // view is null for the first frame (until App computes the fit off the
  // reported size). Keep the DOM structure STABLE across that transition —
  // if the tree shape changes, React reconciles wrapRef onto the wrong
  // element and the ResizeObserver measures the ruler strip instead of the
  // canvas. So always render the same tree and fall back to a unit viewBox.
  const v = view ?? { x: 0, y: 0, w: 1, h: 1 }
  const ready = view && size.width
  const xt = ready ? ticks(v.x, v.x + v.w, v.w, gridStep) : { step: 1, out: [], minorStep: 1, minorOut: [] }
  const yt = ready ? ticks(v.y, v.y + v.h, v.h, gridStep) : { step: 1, out: [], minorStep: 1, minorOut: [] }

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

  function reportCursor(ev) {
    const p = svgPoint(svgRef.current, ev.clientX, ev.clientY)
    onCursor({ x: p.x, y: site.d - p.y })
  }

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
    }
  }

  function onPointerDownEquip(tag, ev) {
    if (tool !== 'select' || byTag[tag].pinned) return
    ev.stopPropagation()
    dragTag.current = tag
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

          {site.racks.map(([ry, rhalf], i) => {
            const y0 = toY(ry + rhalf)
            const h = rhalf * 2
            const hatchX = []
            for (let x = RACK_HATCH_SPACING; x < site.w; x += RACK_HATCH_SPACING) hatchX.push(x)
            return (
              <g key={i}>
                <rect x={0} y={y0} width={site.w} height={h} className="rack" />
                {hatchX.map((x) => (
                  <line key={x} x1={x} y1={y0} x2={x} y2={y0 + h} className="rack-hatch" />
                ))}
                <text x={site.w / 2} y={y0 + h / 2 + 0.6} className="rack-label">Pipe Rack</text>
              </g>
            )
          })}

          {Object.entries(keepouts ?? {}).map(([zone, poly]) => {
            const kind = zone.toUpperCase().startsWith('ROAD') ? 'road'
              : zone.toUpperCase().startsWith('MAINT') ? 'maint' : 'keepout'
            const [cx, cy] = centroid(poly)
            return (
              <g key={zone}>
                <polygon
                  points={poly.map(([x, y]) => `${x},${toY(y)}`).join(' ')}
                  className={`zone ${kind}`}
                />
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
        </svg>
      </div>
    </div>
  )
}

export { CLASS_COLOR }

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { niceStep, panBy, zoomAt } from '@/lib/view'

const CLASS_COLOR = {
  fired_heater: '#e05a47',
  column: '#4a7fd6',
  vessel: '#3fa66b',
  exchanger: '#c98a2b',
  pump_hc: '#8a5fd6',
}

const RULER = 26 // px thickness of each ruler strip

function svgPoint(svg, clientX, clientY) {
  const pt = svg.createSVGPoint()
  pt.x = clientX
  pt.y = clientY
  return pt.matrixTransform(svg.getScreenCTM().inverse())
}

// tick positions (world units) that fall inside [lo, hi], stepped nicely
function ticks(lo, hi, span) {
  const step = niceStep(span / 10)
  const out = []
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) out.push(Math.round(t / step) * step)
  return { step, out }
}

export default function PlotCanvas({
  data, positions, onPositions, view, setView, showGrid, showRuler, tool, onCursor, onSize,
}) {
  const { equipment, connections, site, keepouts } = data
  const byTag = Object.fromEntries(equipment.map((e) => [e.tag, e]))
  const toY = (y) => site.d - y // north-up: flip y for SVG

  const wrapRef = useRef(null)
  const svgRef = useRef(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const dragTag = useRef(null)
  const pan = useRef(null) // {x, y} last client pos while panning

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
    onPositions({ ...positions, [tag]: { x: p.x, y: site.d - p.y } })
  }

  function onPointerUp() {
    pan.current = null
    dragTag.current = null
  }

  // view is null for the first frame (until App computes the fit off the
  // reported size). Keep the DOM structure STABLE across that transition —
  // if the tree shape changes, React reconciles wrapRef onto the wrong
  // element and the ResizeObserver measures the ruler strip instead of the
  // canvas. So always render the same tree and fall back to a unit viewBox.
  const v = view ?? { x: 0, y: 0, w: 1, h: 1 }
  const ready = view && size.width
  const xt = ready ? ticks(v.x, v.x + v.w, v.w) : { step: 1, out: [] }
  const yt = ready ? ticks(v.y, v.y + v.h, v.h) : { step: 1, out: [] }
  const pxX = (wx) => ((wx - v.x) / v.w) * size.width
  const pxY = (sy) => ((sy - v.y) / v.h) * size.height
  const fmt = (n) => (Number.isInteger(n) ? n : n.toFixed(1))

  return (
    <div className="canvas-grid" data-ruler={showRuler ? 'on' : 'off'}>
      {/* rulers are always mounted (toggled via CSS) so the DOM structure —
          and therefore wrapRef's target — stays stable. */}
      <div className="ruler-corner" />
      <svg className="ruler ruler-x" width={size.width} height={RULER}>
        {xt.out.map((wx) => (
          <g key={wx}>
            <line x1={pxX(wx)} y1={RULER - 6} x2={pxX(wx)} y2={RULER} />
            <text x={pxX(wx) + 2} y={RULER - 9}>{fmt(wx)}</text>
          </g>
        ))}
      </svg>
      <svg className="ruler ruler-y" width={RULER} height={size.height}>
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

          {site.racks.map(([ry, rhalf], i) => (
            <rect key={i} x={0} y={toY(ry + rhalf)} width={site.w} height={rhalf * 2} className="rack" />
          ))}

          {Object.entries(keepouts ?? {}).map(([zone, poly]) => (
            <polygon
              key={zone}
              points={poly.map(([x, y]) => `${x},${toY(y)}`).join(' ')}
              className={`zone ${zone.toUpperCase().startsWith('ROAD') ? 'road' : zone.toUpperCase().startsWith('MAINT') ? 'maint' : 'keepout'}`}
            />
          ))}

          {connections.map((c, i) => {
            const a = positions[c.a]
            const b = positions[c.b]
            if (!a || !b) return null
            return <line key={i} x1={a.x} y1={toY(a.y)} x2={b.x} y2={toY(b.y)} className="conn" />
          })}

          {equipment.map((e) => {
            const p = positions[e.tag] ?? { x: e.x, y: e.y }
            return (
              <g key={e.tag}>
                <rect
                  x={p.x - e.w / 2}
                  y={toY(p.y) - e.d / 2}
                  width={e.w}
                  height={e.d}
                  fill={CLASS_COLOR[e.cls] ?? '#888'}
                  className={`equip ${e.pinned ? 'pinned' : ''}`}
                  onPointerDown={(ev) => onPointerDownEquip(e.tag, ev)}
                />
                <text x={p.x} y={toY(p.y) - e.d / 2 - 0.6} className="tag">{e.tag}</text>
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}

export { CLASS_COLOR }

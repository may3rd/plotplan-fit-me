import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'

const CLASS_COLOR = {
  fired_heater: '#e05a47',
  column: '#4a7fd6',
  vessel: '#3fa66b',
  exchanger: '#c98a2b',
  pump_hc: '#8a5fd6',
}

function svgPoint(svg, clientX, clientY) {
  const pt = svg.createSVGPoint()
  pt.x = clientX
  pt.y = clientY
  return pt.matrixTransform(svg.getScreenCTM().inverse())
}

function App() {
  const [units, setUnits] = useState([])
  const [unitName, setUnitName] = useState(null)
  const [data, setData] = useState(null) // {equipment, connections, site, keepouts}
  const [positions, setPositions] = useState({}) // tag -> {x, y}
  const [score, setScore] = useState(null) // {feasible, cost}
  const [seedsInput, setSeedsInput] = useState('0:8')
  const [solving, setSolving] = useState(false)
  const svgRef = useRef(null)
  const dragTag = useRef(null)
  const reqId = useRef(0)

  useEffect(() => {
    fetch('/api/units').then((r) => r.json()).then((names) => {
      setUnits(names)
      if (names.length) setUnitName(names[0])
    })
  }, [])

  useEffect(() => {
    if (!unitName) return
    fetch(`/api/units/${unitName}`).then((r) => r.json()).then((d) => {
      setData(d)
      const pos = {}
      for (const e of d.equipment) pos[e.tag] = { x: e.x, y: e.y }
      setPositions(pos)
      setScore(null)
    })
  }, [unitName])

  const scoreLayout = useCallback((pos) => {
    if (!unitName) return
    const id = ++reqId.current
    const equipment = Object.entries(pos).map(([tag, p]) => ({ tag, x: p.x, y: p.y }))
    fetch(`/api/units/${unitName}/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ equipment }),
    })
      .then((r) => r.json())
      .then((s) => {
        if (id === reqId.current) setScore(s)
      })
  }, [unitName])

  useEffect(() => {
    if (data && Object.keys(positions).length) scoreLayout(positions)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  if (!data) return <div className="panel">Loading…</div>

  const { equipment, connections, site, keepouts } = data
  const toY = (y) => site.d - y // north-up: flip y for SVG
  const byTag = Object.fromEntries(equipment.map((e) => [e.tag, e]))

  function onPointerDown(tag, ev) {
    const eq = byTag[tag]
    if (eq.pinned) return
    ev.currentTarget.setPointerCapture(ev.pointerId)
    dragTag.current = tag
  }

  function onPointerMove(ev) {
    const tag = dragTag.current
    if (!tag) return
    const p = svgPoint(svgRef.current, ev.clientX, ev.clientY)
    const next = { ...positions, [tag]: { x: p.x, y: site.d - p.y } }
    setPositions(next)
    scoreLayout(next)
  }

  function onPointerUp() {
    dragTag.current = null
  }

  async function solve() {
    setSolving(true)
    try {
      const seeds = seedsInput.includes(':')
        ? (() => {
            const [a, b] = seedsInput.split(':').map(Number)
            return Array.from({ length: b - a }, (_, i) => a + i)
          })()
        : [Number(seedsInput)]
      const r = await fetch(`/api/units/${unitName}/solve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seeds }),
      })
      const result = await r.json()
      const pos = {}
      for (const e of result.equipment) pos[e.tag] = { x: e.x, y: e.y }
      setPositions(pos)
      setScore({ feasible: true, cost: result.cost })
    } finally {
      setSolving(false)
    }
  }

  return (
    <div className="app">
      <header className="toolbar">
        <label>
          Unit:{' '}
          <select value={unitName ?? ''} onChange={(e) => setUnitName(e.target.value)}>
            {units.map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
        </label>
        <label>
          Seeds:{' '}
          <input value={seedsInput} onChange={(e) => setSeedsInput(e.target.value)} size={8} />
        </label>
        <button onClick={solve} disabled={solving}>{solving ? 'Solving…' : 'Solve'}</button>
        <span className={`score ${score?.feasible === false ? 'infeasible' : ''}`}>
          {score == null
            ? ''
            : score.feasible
              ? `score: ${score.cost.toFixed(0)}`
              : 'infeasible layout'}
        </span>
      </header>

      <svg
        ref={svgRef}
        className="plot"
        viewBox={`0 0 ${site.w} ${site.d}`}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <rect x={0} y={0} width={site.w} height={site.d} className="site" />

        {site.racks.map(([ry, rhalf], i) => (
          <rect
            key={i}
            x={0}
            y={toY(ry + rhalf)}
            width={site.w}
            height={rhalf * 2}
            className="rack"
          />
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
          return (
            <line key={i} x1={a.x} y1={toY(a.y)} x2={b.x} y2={toY(b.y)} className="conn" />
          )
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
                onPointerDown={(ev) => onPointerDown(e.tag, ev)}
              />
              <text x={p.x} y={toY(p.y) - e.d / 2 - 0.6} className="tag">{e.tag}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

export default App

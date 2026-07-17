import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import PlotCanvas from '@/components/PlotCanvas'
import Ribbon from '@/components/Ribbon'
import StatusBar from '@/components/StatusBar'
import { fitView, zoomAt, zoomPercent } from '@/lib/view'
import './App.css'

function App() {
  const [units, setUnits] = useState([])
  const [unitName, setUnitName] = useState(null)
  const [data, setData] = useState(null) // {equipment, connections, site, keepouts}
  const [positions, setPositions] = useState({}) // tag -> {x, y}
  const [score, setScore] = useState(null) // {feasible, cost}
  const [seedsInput, setSeedsInput] = useState('0:8')
  const [solving, setSolving] = useState(false)

  // view / canvas state
  const [view, setView] = useState(null) // SVG viewBox {x,y,w,h}, null until fitted
  const [csize, setCsize] = useState(null) // canvas px size {width,height}
  const [cursor, setCursor] = useState(null) // world {x,y} under pointer
  const [showGrid, setShowGrid] = useState(true)
  const [showRuler, setShowRuler] = useState(true)
  const [tool, setTool] = useState('select')
  const fitW = useRef(1) // view.w at 100% (fit), for the zoom readout
  const fittedFor = useRef(null)

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

  // fit once per loaded unit; on later resizes just re-fit aspect via a full
  // fitView (cheap, and re-fitting on resize is the least-surprising default).
  useEffect(() => {
    if (!data || !csize?.width) return
    if (fittedFor.current !== data) {
      const fv = fitView(data.site, csize)
      setView(fv)
      fitW.current = fv.w
      fittedFor.current = data
    }
  }, [data, csize])

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
      .then((s) => { if (id === reqId.current) setScore(s) })
  }, [unitName])

  useEffect(() => {
    if (data && Object.keys(positions).length) scoreLayout(positions)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  const onPositions = useCallback((next) => {
    setPositions(next)
    scoreLayout(next)
  }, [scoreLayout])

  const zoomCenter = useCallback((factor) => {
    if (!csize?.width) return
    setView((v) => zoomAt(v, csize, csize.width / 2, csize.height / 2, factor))
  }, [csize])

  const fit = useCallback(() => {
    if (!data || !csize?.width) return
    const fv = fitView(data.site, csize)
    setView(fv)
    fitW.current = fv.w
  }, [data, csize])

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

  if (!data) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" /> Loading…
      </div>
    )
  }

  return (
    <div className="app-shell">
      <Ribbon
        units={units} unitName={unitName} setUnitName={setUnitName}
        seedsInput={seedsInput} setSeedsInput={setSeedsInput}
        solve={solve} solving={solving} score={score}
        showGrid={showGrid} setShowGrid={setShowGrid}
        showRuler={showRuler} setShowRuler={setShowRuler}
        tool={tool} setTool={setTool}
        zoomIn={() => zoomCenter(0.8)} zoomOut={() => zoomCenter(1.25)} fit={fit}
      />

      <main className="canvas-area">
        <PlotCanvas
          data={data} positions={positions} onPositions={onPositions}
          view={view} setView={setView}
          showGrid={showGrid} showRuler={showRuler} tool={tool}
          onCursor={setCursor} onSize={setCsize}
        />
      </main>

      <StatusBar
        unitName={unitName} score={score} cursor={cursor}
        zoomPct={view ? zoomPercent(view, fitW.current) : 100}
        tool={tool}
      />
    </div>
  )
}

export default App

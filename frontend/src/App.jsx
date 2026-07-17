import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import PlotCanvas from '@/components/PlotCanvas'
import Ribbon from '@/components/Ribbon'
import StatusBar from '@/components/StatusBar'
import { buildCaseData, BLANK_PROJECT, parseProjectFile, projectFileContents } from '@/lib/project'
import { downloadRaster } from '@/lib/raster'
import { fitView, zoomAt, zoomPercent } from '@/lib/view'
import './App.css'

function App() {
  const [units, setUnits] = useState([])
  const [unitName, setUnitName] = useState(null)
  const [data, setData] = useState(null) // {name, equipment, connections, site, keepouts, spacing, wind_clearance_m}
  const [positions, setPositions] = useState({}) // tag -> {x, y}
  const [fileName, setFileName] = useState(null) // last-used Save/Open filename, or null (unsaved)
  const [score, setScore] = useState(null) // {feasible, cost}
  const [seedsInput, setSeedsInput] = useState('0:8')
  const [solving, setSolving] = useState(false)
  const [results, setResults] = useState(null) // [{seed, cost}, ...] from the last solve

  // view / canvas state
  const [view, setView] = useState(null) // SVG viewBox {x,y,w,h}, null until fitted
  const [csize, setCsize] = useState(null) // canvas px size {width,height}
  const [cursor, setCursor] = useState(null) // world {x,y} under pointer
  const [showGrid, setShowGrid] = useState(true)
  const [showRuler, setShowRuler] = useState(true)
  const [gridStep, setGridStep] = useState(null) // meters/tick override; null = auto
  const [snap, setSnap] = useState(false)
  const [viewMode, setViewMode] = useState('normal') // 'normal' | 'wireframe' | 'dxf'
  const [tool, setTool] = useState('select') // 'select' | 'pan' | 'edit'
  const editMode = tool === 'edit' // when 'edit', zones (road/rack/underground/other) are draggable on the canvas
  const [rackWidth, setRackWidth] = useState(8) // meters, pipe-rack width (preferences, later)
  const [roadWidth, setRoadWidth] = useState(6) // meters, road width (preferences, later)
  const [drawPromptNonce, setDrawPromptNonce] = useState(0) // bump to (re)open the road/rack width prompt
  const bumpDrawPrompt = useCallback(() => setDrawPromptNonce((n) => n + 1), [])
  const [editPromptNonce, setEditPromptNonce] = useState(0) // bump to open the selected zone's edit dialog
  const bumpEditPrompt = useCallback(() => setEditPromptNonce((n) => n + 1), [])
  const [selectedZone, setSelectedZone] = useState(null) // currently selected keep-out/road/rack zone
  const fitW = useRef(1) // view.w at 100% (fit), for the zoom readout
  const fittedFor = useRef(null)

  const reqId = useRef(0)

  // shared by the unit-picker load, File > New, and File > Open — swaps in
  // a whole new project (data + positions rebuilt from its equipment) and
  // clears anything that belonged to the previous one.
  const applyProject = useCallback((d) => {
    setData(d)
    const pos = {}
    for (const e of d.equipment) pos[e.tag] = { x: e.x, y: e.y }
    setPositions(pos)
    setScore(null)
    setResults(null)
  }, [])

  useEffect(() => {
    fetch('/api/units').then((r) => r.json()).then((names) => {
      setUnits(names)
      if (names.length) setUnitName(names[0])
    })
  }, [])

  useEffect(() => {
    if (!unitName) return
    fetch(`/api/units/${unitName}`).then((r) => r.json()).then((d) => {
      applyProject(d)
      setFileName(null) // loading a case study from the dropdown isn't "opening a file"
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (!data) return
    const id = ++reqId.current
    fetch('/api/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: buildCaseData(data, pos) }),
    })
      .then((r) => r.json())
      .then((s) => { if (id === reqId.current) setScore(s) })
  }, [data])

  useEffect(() => {
    if (data && Object.keys(positions).length) scoreLayout(positions)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  const onPositions = useCallback((next) => {
    setPositions(next)
    scoreLayout(next)
  }, [scoreLayout])

  // add/remove a keepouts zone (road/rack drawn on canvas, or any other) —
  // changing `data` here re-triggers the scoreLayout effect below, since a
  // zone can flip feasibility just like moving equipment can.
  const addZone = useCallback((name, poly) => {
    setData((d) => ({ ...d, keepouts: { ...d.keepouts, [name]: poly } }))
  }, [])

  const deleteZone = useCallback((name) => {
    setData((d) => {
      const keepouts = { ...d.keepouts }
      delete keepouts[name]
      return { ...d, keepouts }
    })
  }, [])

  // edit a keepouts zone: update its polygon (drag a vertex) and/or rename it
  // (which changes its role/layer per the backend's zone-name convention).
  const editZone = useCallback((name, poly, nextName) => {
    setData((d) => {
      const keepouts = { ...d.keepouts }
      if (nextName && nextName !== name) {
        delete keepouts[name]
        keepouts[nextName] = poly
      } else {
        keepouts[name] = poly
      }
      return { ...d, keepouts }
    })
  }, [])

  // Ribbon's Delete button: remove the selected zone and clear the selection.
  const deleteSelectedZone = useCallback((name) => {
    deleteZone(name)
    setSelectedZone(null)
  }, [deleteZone])

  const zoomCenter = useCallback((factor) => {
    if (!csize?.width) return
    setView((v) => zoomAt(v, csize, csize.width / 2, csize.height / 2, factor))
  }, [csize])

  const setZoomPercent = useCallback((pct) => {
    if (!csize?.width || !view) return
    const targetW = fitW.current / (pct / 100)
    zoomCenter(targetW / view.w)
  }, [csize, view, zoomCenter])

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
      const r = await fetch('/api/solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: buildCaseData(data, positions), seeds }),
      })
      const result = await r.json()
      const pos = {}
      for (const e of result.equipment) pos[e.tag] = { x: e.x, y: e.y }
      setPositions(pos)
      setScore({ feasible: true, cost: result.cost })
      setResults(result.results)
    } finally {
      setSolving(false)
    }
  }

  async function downloadResponse(url, fallbackName) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: buildCaseData(data, positions) }),
    })
    const blob = await r.blob()
    const match = /filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') ?? '')
    const filename = match ? match[1] : fallbackName
    const dlUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = dlUrl
    a.download = filename
    a.click()
    URL.revokeObjectURL(dlUrl)
  }

  const projectName = () => data.name || 'layout'
  const exportDxf = () => downloadResponse('/api/export/dxf', `${projectName()}.dxf`)
  const exportTakeoff = () => downloadResponse('/api/export/takeoff', `${projectName()}_takeoff.csv`)

  // svg.plot is unique in the whole app — simpler than threading a ref down
  // through PlotCanvas just for this.
  const exportRaster = (kind) => {
    const svgEl = document.querySelector('svg.plot')
    if (svgEl) downloadRaster(svgEl, kind, `${projectName()}.${kind}`)
  }

  function downloadText(text, filename) {
    const blob = new Blob([text], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  function newProject() {
    applyProject({ ...BLANK_PROJECT, equipment: [], connections: [], keepouts: {}, spacing: [] })
    setUnitName(null)
    setFileName(null)
  }

  function openProject(file) {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = parseProjectFile(reader.result)
        applyProject(parsed)
        setUnitName(null)
        setFileName(file.name)
      } catch (err) {
        window.alert(`Couldn't open "${file.name}": ${err.message}`)
      }
    }
    reader.readAsText(file)
  }

  function saveProject() {
    if (fileName) downloadText(projectFileContents(data, positions), fileName)
    else saveProjectAs()
  }

  function saveProjectAs() {
    const suggested = fileName ?? `${data.name || 'layout'}.json`
    const name = window.prompt('Save project as:', suggested)
    if (!name) return
    const finalName = name.endsWith('.json') ? name : `${name}.json`
    downloadText(projectFileContents(data, positions), finalName)
    setFileName(finalName)
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
        solve={solve} solving={solving} results={results}
        showGrid={showGrid} setShowGrid={setShowGrid}
        showRuler={showRuler} setShowRuler={setShowRuler}
        gridStep={gridStep} setGridStep={setGridStep}
        snap={snap} setSnap={setSnap}
        viewMode={viewMode} setViewMode={setViewMode}
        tool={tool} setTool={setTool} bumpDrawPrompt={bumpDrawPrompt} fit={fit}
        bumpEditPrompt={bumpEditPrompt} selectedZone={selectedZone} deleteZone={deleteSelectedZone}
        zoomPct={view ? zoomPercent(view, fitW.current) : 100} setZoomPercent={setZoomPercent}
        newProject={newProject} openProject={openProject}
        saveProject={saveProject} saveProjectAs={saveProjectAs}
        exportDxf={exportDxf} exportTakeoff={exportTakeoff} exportRaster={exportRaster}
      />

      <main className="canvas-area">
        <PlotCanvas
          data={data} positions={positions} onPositions={onPositions}
          view={view} setView={setView}
          showGrid={showGrid} showRuler={showRuler} gridStep={gridStep} snap={snap} tool={tool} setTool={setTool}
          viewMode={viewMode}
          editMode={editMode}
          rackWidth={rackWidth} setRackWidth={setRackWidth}
          roadWidth={roadWidth} setRoadWidth={setRoadWidth}
          drawPromptNonce={drawPromptNonce}
          editPromptNonce={editPromptNonce}
          onCursor={setCursor} onSize={setCsize}
          onAddZone={addZone} onDeleteZone={deleteZone} onEditZone={editZone}
          selectedZone={selectedZone} setSelectedZone={setSelectedZone}
        />
      </main>

      <StatusBar
        projectLabel={fileName ?? data.name ?? 'untitled'} score={score} cursor={cursor}
        zoomPct={view ? zoomPercent(view, fitW.current) : 100} setZoomPercent={setZoomPercent}
        tool={tool}
      />
    </div>
  )
}

export default App

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import PlotCanvas from '@/components/PlotCanvas'
import Ribbon from '@/components/Ribbon'
import StatusBar from '@/components/StatusBar'
import { buildCaseData, BLANK_PROJECT, parseProjectFile, projectFileContents } from '@/lib/project'
import { downloadRaster } from '@/lib/raster'
import { fitView, reaspect, zoomAt, zoomPercent } from '@/lib/view'
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
  const [solveProgress, setSolveProgress] = useState(null) // {fraction, seed, seed_index, seed_count} | null
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
  const [theme, setTheme] = useState(() => localStorage.getItem('plotplan-theme') || 'system')
  const editMode = tool === 'edit' // when 'edit', zones (road/rack/underground/other) are draggable on the canvas
  const [rackWidth, setRackWidth] = useState(7.5) // meters, pipe-rack width (preferences, later)
  const [rackBeamSpacing, setRackBeamSpacing] = useState(6) // meters, pipe-rack cross-tie beam spacing (preferences, later)
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

  // Tools > Customize UI theme picker: 'dark'/'light' force the .dark class
  // (the shadcn/ui dark palette already defined in index.css/App.css, just
  // never wired up before); 'system' follows prefers-color-scheme live.
  useEffect(() => {
    localStorage.setItem('plotplan-theme', theme)
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && mq.matches))
    }
    apply()
    if (theme === 'system') {
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
  }, [theme])

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

  // fit once per loaded unit; on later resizes re-fit the viewBox aspect to
  // the new canvas aspect so the world→screen mapping stays undistorted
  // (preserveAspectRatio="none" would otherwise stretch the plot when the
  // window narrows/widens). Keeps the same center and width (i.e. the user's
  // zoom level), only height tracks the new aspect — see reaspect().
  useEffect(() => {
    if (!data || !csize?.width) return
    if (fittedFor.current !== data) {
      const fv = fitView(data.site, csize)
      setView(fv)
      fitW.current = fv.w
      fittedFor.current = data
    } else if (view) {
      setView(reaspect(view, csize))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // --- Mode 2: real-time layouting (PLAN.md items 16-17, POST /api/relax) ---
  // Toggled from the Home ribbon. While on, dragging an item also throttle-
  // calls /relax, which pins the dragged item at the cursor and reflows
  // every other item around it (server-side warm-start SA, with push-repair
  // legalizing a packed-row drop) — /score's per-frame call still runs too,
  // for the instant local feedback /relax's ~100ms round trip can't match;
  // /relax's response (feasible flag + reflowed positions) simply supersedes
  // it a beat later.
  const [realtimeMode, setRealtimeMode] = useState(false)
  // Whether the LAST /relax attempt actually reflowed the layout (vs. push-
  // repair/SA finding no legal fix and reporting infeasible) — surfaced in
  // the status bar so a blocked reflow reads as "can't fit this", not as
  // "real-time mode isn't doing anything". Starts true so the ribbon
  // doesn't flash a warning before the first drag.
  const [relaxOk, setRelaxOk] = useState(true)
  const relaxReqId = useRef(0)
  const relaxThrottle = useRef({ lastSentAt: 0, timer: null, latest: null })

  const fireRelax = useCallback(() => {
    const args = relaxThrottle.current.latest
    relaxThrottle.current.timer = null
    relaxThrottle.current.lastSentAt = Date.now()
    if (!args || !data) return
    const { tag, x, y } = args
    const id = ++relaxReqId.current
    fetch('/api/relax', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: buildCaseData(data, positions), tag, x, y }),
    })
      .then((r) => r.json())
      .then((res) => {
        if (id !== relaxReqId.current) return
        setRelaxOk(res.feasible)
        if (!res.feasible) return
        const pos = {}
        for (const e of res.equipment) pos[e.tag] = { x: e.x, y: e.y }
        setPositions(pos)
        setScore({ feasible: true, cost: res.cost })
      })
      .catch(() => {}) // ponytail: a dropped relax frame just means the next drag frame (or the on-drop flush) tries again
  }, [data, positions])

  // ~100ms throttle: fires immediately if it's been >=100ms since the last
  // call, otherwise schedules one trailing call for whenever that window
  // ends — always using the LATEST cursor position, so a fast continuous
  // drag gets a steady trickle of reflows instead of one queued call per
  // pointermove event.
  const relaxLayout = useCallback((tag, x, y) => {
    relaxThrottle.current.latest = { tag, x, y }
    const elapsed = Date.now() - relaxThrottle.current.lastSentAt
    if (elapsed >= 100) fireRelax()
    else if (!relaxThrottle.current.timer) relaxThrottle.current.timer = setTimeout(fireRelax, 100 - elapsed)
  }, [fireRelax])

  // "commit on drop": fire whatever's pending right away instead of waiting
  // out the rest of the throttle window, so the final reflow matches the
  // exact position the item was dropped at with no residual lag.
  const flushRelax = useCallback(() => {
    if (relaxThrottle.current.timer) {
      clearTimeout(relaxThrottle.current.timer)
      fireRelax()
    }
  }, [fireRelax])

  // Reset the "blocked" indicator whenever the toggle switches on, so a
  // stale failure from the last time it was enabled doesn't show before
  // the user has even tried a new drag.
  const toggleRealtimeMode = useCallback((on) => {
    setRealtimeMode(on)
    if (on) setRelaxOk(true)
  }, [])

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
    setSolveProgress({ fraction: 0, seed: null, seed_index: 0, seed_count: 1 })
    try {
      const seeds = seedsInput.includes(':')
        ? (() => {
            const [a, b] = seedsInput.split(':').map(Number)
            return Array.from({ length: b - a }, (_, i) => a + i)
          })()
        : [Number(seedsInput)]
      const r = await fetch('/api/solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify({ data: buildCaseData(data, positions), seeds }),
      })
      if (!r.ok || !r.body) throw new Error(`solve failed: ${r.status}`)
      // ponytail: /api/solve is now an SSE stream (POST, so no EventSource —
      // parse text/event-stream chunks by hand from the ReadableStream).
      // One `progress` event per seed-start + ~100 per SA solve, then a
      // final `done` (or `error`) event. Buffer-splitting on "\n\n" is the
      // whole SSE frame boundary; the `event:`/`data:` lines are the spec.
      const reader = r.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let result = null
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          const evt = { event: 'message', data: '' }
          for (const line of frame.split('\n')) {
            const colon = line.indexOf(':')
            if (colon < 0) continue
            const k = line.slice(0, colon).trim()
            const v = line.slice(colon + 1).replace(/^ /, '')
            if (k === 'event') evt.event = v
            else if (k === 'data') evt.data = v
          }
          const payload = evt.data ? JSON.parse(evt.data) : {}
          if (evt.event === 'progress') {
            setSolveProgress(payload)
          } else if (evt.event === 'done') {
            result = payload
          } else if (evt.event === 'error') {
            throw new Error(payload.message || 'solve error')
          }
        }
      }
      if (!result) throw new Error('solve stream ended without a result')
      const pos = {}
      for (const e of result.equipment) pos[e.tag] = { x: e.x, y: e.y }
      setPositions(pos)
      setScore({ feasible: true, cost: result.cost })
      setResults(result.results)
    } finally {
      setSolving(false)
      setSolveProgress(null)
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
        theme={theme} setTheme={setTheme}
        rackWidth={rackWidth} setRackWidth={setRackWidth}
        rackBeamSpacing={rackBeamSpacing} setRackBeamSpacing={setRackBeamSpacing}
        roadWidth={roadWidth} setRoadWidth={setRoadWidth}
        realtimeMode={realtimeMode} setRealtimeMode={toggleRealtimeMode}
      />

      <main className="canvas-area">
        {solving && solveProgress && (
          <div className="solve-progress" aria-busy="true" role="progressbar"
               aria-valuenow={Math.round(solveProgress.fraction * 100)}
               aria-valuemin={0} aria-valuemax={100}>
            <div className="solve-progress-bar"
                 style={{ width: `${solveProgress.fraction * 100}%` }} />
            <span className="solve-progress-label">
              {Math.round(solveProgress.fraction * 100)}%
            </span>
          </div>
        )}
        <PlotCanvas
          data={data} positions={positions} onPositions={onPositions}
          view={view} setView={setView}
          showGrid={showGrid} showRuler={showRuler} gridStep={gridStep} snap={snap} tool={tool} setTool={setTool}
          viewMode={viewMode}
          editMode={editMode}
          realtimeMode={realtimeMode} relaxLayout={relaxLayout} flushRelax={flushRelax}
          rackWidth={rackWidth} setRackWidth={setRackWidth}
          rackBeamSpacing={rackBeamSpacing} setRackBeamSpacing={setRackBeamSpacing}
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
        tool={tool} realtimeMode={realtimeMode} relaxOk={relaxOk}
      />
    </div>
  )
}

export default App

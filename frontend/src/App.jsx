import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import PlotCanvas from '@/components/PlotCanvas'
import Ribbon from '@/components/Ribbon'
import StatusBar from '@/components/StatusBar'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { rotatePolyCW, rotateSide, rotatePointCW } from '@/lib/geom'
import { buildCaseData, BLANK_PROJECT, parseProjectFile, projectFileContents } from '@/lib/project'
import { downloadRaster } from '@/lib/raster'
import { fitView, reaspect, zoomAt, zoomPercent } from '@/lib/view'
import './App.css'

// ponytail: one shared notice dialog for every place that used to call
// window.alert — open-file error, Help, About. Caller sets
// `{title, body}` state and this renders; closing clears it. body may be a
// string (whitespace-pre-line preserves the \n-joined lines) or JSX.
function NoticeDialog({ notice, onClose }) {
  return (
    <Dialog open={!!notice} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent>
        {notice && (
          <>
            <DialogHeader><DialogTitle>{notice.title}</DialogTitle></DialogHeader>
            <div className="text-sm text-muted-foreground whitespace-pre-line">
              {notice.body}
            </div>
            <DialogFooter>
              <Button onClick={onClose}>OK</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ponytail: replaces window.prompt for Save As — a controlled dialog with a
// text input + OK/Cancel; the only prompt left in the app. Validates
// non-empty, appends .json if missing.
function SaveAsDialog({ open, initial, onCancel, onConfirm }) {
  const [name, setName] = useState(initial ?? '')
  useEffect(() => { if (open) setName(initial ?? '') }, [open, initial])
  function apply() {
    const n = name.trim()
    if (!n) return
    onConfirm(n.endsWith('.json') ? n : `${n}.json`)
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel() }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Save project as</DialogTitle></DialogHeader>
        <div className="flex items-center gap-2">
          <Label htmlFor="saveas-name" className="text-sm">File name</Label>
          <Input
            id="saveas-name" value={name} autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') apply() }}
            className="flex-1"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button onClick={apply}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function App() {
  const [units, setUnits] = useState([])
  const [unitName, setUnitName] = useState(null)
  const [data, setData] = useState(null) // {name, equipment, connections, site, keepouts, spacing, wind_clearance_m}
  const [positions, setPositions] = useState({}) // tag -> {x, y}
  const [fileName, setFileName] = useState(null) // last-used Save/Open filename, or null (unsaved)
  const [score, setScore] = useState(null) // {feasible, cost}
  const [caseCount, setCaseCount] = useState(8) // how many randomly-seeded cases Solve tries
  const [solving, setSolving] = useState(false)
  const [solveProgress, setSolveProgress] = useState(null) // {fraction, seed, seed_index, seed_count} | null
  const [cases, setCases] = useState(null) // [{seed, cost, equipment}, ...] from the last solve, best cost first
  const [notice, setNotice] = useState(null) // {title, body} | null — drives NoticeDialog (replaces window.alert)
  const [saveAsOpen, setSaveAsOpen] = useState(false) // Save-As prompt dialog (replaces window.prompt)
  const [loadError, setLoadError] = useState(null) // {message} | null — unit-list fetch failed
  const dirtyRef = useRef(false) // true once the user edits positions/data past the last save/load

  // view / canvas state
  const [view, setView] = useState(null) // SVG viewBox {x,y,w,h}, null until fitted
  const [csize, setCsize] = useState(null) // canvas px size {width,height}
  const [cursor, setCursor] = useState(null) // world {x,y} under pointer
  const [showGrid, setShowGrid] = useState(true)
  const [showRuler, setShowRuler] = useState(true)
  const [gridStep, setGridStep] = useState(null) // meters/tick override; null = auto
  // Granular snap toggles — each gates one snap behavior in PlotCanvas:
  //   grid    — snap dragged points to the nearest grid tick
  //   objects — snap to equipment centers / zone vertices within a threshold
  //   borders — soft-snap to the site border (was always-on before; now a
  //             real toggle so you can drop a piece flush against an edge
  //             without the grid getting in the way)
  // Alt during a drag suppresses all three; Shift forces all three on for one
  // drag (handled in PlotCanvas, reads ev.altKey/shiftKey — no state needed).
  const [snap, setSnap] = useState({ grid: true, objects: true, borders: true })
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
  const [editEquipPromptNonce, setEditEquipPromptNonce] = useState(0) // bump to open the selected equipment's edit dialog
  const bumpEditEquipPrompt = useCallback(() => setEditEquipPromptNonce((n) => n + 1), [])
  const [selectedZone, setSelectedZone] = useState(null) // currently selected keep-out/road/rack zone
  const [selectedEquips, setSelectedEquips] = useState([]) // selected equipment tags (multi-select: shift/ctrl+click, marquee)
  // ponytail: primary selection = the last-added tag, kept as a derived
  // value so existing single-selection call sites (Object tab, edit dialog,
  // status bar) read one tag without each reinventing "last of the array".
  const selectedEquip = selectedEquips.length ? selectedEquips[selectedEquips.length - 1] : null
  const setSelectedEquip = useCallback((tag) => setSelectedEquips(tag ? [tag] : []), [])

  // ponytail: one helper for "this mutation dirties the doc" — every
  // user-driven setData/setPositions path that isn't a fresh load calls this.
  // A ref (not state) because beforeunload only needs the latest value at
  // unload time, and we don't want a re-render on every drag frame.
  const markDirty = useCallback(() => { dirtyRef.current = true }, [])
  const markClean = useCallback(() => { dirtyRef.current = false }, [])

  // ---- undo / redo ---------------------------------------------------------
  // ponytail: undo/redo over the (data, positions) pair. Two stacks of
  // snapshots; current state is NOT in either stack. commit() snapshots
  // the CURRENT state onto `past` before a mutation changes it, so undo
  // can restore it. A continuous drag commits once at pointer-down
  // (PlotCanvas calls onInteractionStart); live drag frames don't commit.
  // History is cleared by load/new (resetHistory) so a freshly-opened
  // project starts with an empty undo past, not "undo back to a blank
  // project from 20 edits ago." Cap past at 100 to bound memory; the most
  // common operation count that matters is the last few, not hundreds.
  // Both stacks are refs (mutated, not via state updaters) so undo/redo
  // can do their setData/setPositions side effects OUTSIDE any React
  // updater — StrictMode double-invokes updaters in dev, which would
  // otherwise apply a step twice. A separate canUndo/canRedo state just
  // forces the ribbon's disabled buttons to re-render after a step.
  const HISTORY_CAP = 100
  const pastRef = useRef([]) // [{data, positions}] older than current
  const futureRef = useRef([]) // [{data, positions}] newer than current
  const [histVer, setHistVer] = useState(0) // bump to re-render ribbon buttons
  const bumpHist = useCallback(() => setHistVer((n) => n + 1), [])

  const snapshot = useCallback(() => {
    if (!data) return null
    return { data, positions: { ...positions } }
  }, [data, positions])

  const commit = useCallback(() => {
    const snap = snapshot()
    if (!snap) return
    pastRef.current = [...pastRef.current.slice(-HISTORY_CAP + 1), snap]
    futureRef.current = [] // any new commit clears the redo branch
    bumpHist()
  }, [snapshot, bumpHist])

  const undo = useCallback(() => {
    cancelRelax()
    if (!pastRef.current.length) return
    const prev = pastRef.current[pastRef.current.length - 1]
    const cur = snapshot()
    pastRef.current = pastRef.current.slice(0, -1)
    if (cur) futureRef.current = [cur, ...futureRef.current].slice(0, HISTORY_CAP)
    setData(prev.data)
    setPositions(prev.positions)
    setScore(null)
    setSelectedZone(null)
    setSelectedEquips([])
    markDirty()
    bumpHist()
  }, [snapshot, markDirty, bumpHist])

  const redo = useCallback(() => {
    cancelRelax()
    if (!futureRef.current.length) return
    const [next, ...rest] = futureRef.current
    const cur = snapshot()
    if (cur) pastRef.current = [...pastRef.current.slice(-HISTORY_CAP + 1), cur]
    futureRef.current = rest
    setData(next.data)
    setPositions(next.positions)
    setScore(null)
    setSelectedZone(null)
    setSelectedEquips([])
    markDirty()
    bumpHist()
  }, [snapshot, markDirty, bumpHist])

  const resetHistory = useCallback(() => {
    pastRef.current = []
    futureRef.current = []
    bumpHist()
  }, [bumpHist])

  const canUndo = pastRef.current.length > 0
  const canRedo = futureRef.current.length > 0
  // histVer is read here only to make this line depend on it so it
  // recomputes after bumpHist; the values come from the refs.
  void histVer

  // ponytail: ⌘Z / Ctrl+Z undo, ⇧⌘Z / Ctrl+Y redo. Active only when not
  // typing in an input/dialog and not while a solve is running. Bound on
  // window (single source of truth, matches the existing Delete/Esc
  // handlers in PlotCanvas) — same pattern, no new keymap system.
  useEffect(() => {
    const onKeyDown = (e) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod || e.key !== 'z' && e.key !== 'Z' && e.key !== 'y' && e.key !== 'Y') return
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return
      e.preventDefault()
      const isRedo = e.key === 'y' || e.key === 'Y' || e.shiftKey
      if (isRedo) redo()
      else undo()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undo, redo])

  // beforeunload guard: warn before closing/reloading the tab with unsaved
  // edits. Browsers ignore the custom message and show their own string, so
  // the text is generic — the presence of a returnValue is what triggers it.
  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (!dirtyRef.current) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  // switching tool mode (Select / Pan / Edit, or a draw-* tool) makes
  // whatever was selected under the OLD mode stale — e.g. an equipment
  // selection only makes sense in Select mode, a zone selection in Edit
  // mode — so drop both on every mode change rather than leaving a
  // highlight/status-bar readout for an object the current tool can't
  // even act on.
  useEffect(() => {
    setSelectedZone(null)
    setSelectedEquips([])
  }, [tool])

  const fitW = useRef(1) // view.w at 100% (fit), for the zoom readout
  // true = the next fit effect run should re-fit the viewport. Explicit
  // flag instead of "did `data` identity change" — `data` gets a new
  // object identity on every relax/rotate/edit response too, and none of
  // those should ever snap the viewport back to full-site fit.
  const wantFitRef = useRef(true)
  const solveAbortRef = useRef(null) // AbortController for the in-flight /api/solve request, if any

  const reqId = useRef(0)

  // --- Mode 2: real-time layouting (PLAN.md items 16-17, POST /api/relax) ---
  // Declared up here (not next to fireRelax) so onPositions can gate the
  // per-frame /score call on realtimeMode, and cancelRelax can be defined
  // before undo/redo/applyProject call it.
  const [realtimeMode, setRealtimeMode] = useState(false)
  // Whether the LAST /relax attempt actually reflowed the layout (vs. push-
  // repair/SA finding no legal fix and reporting infeasible) — surfaced in
  // the status bar so a blocked reflow reads as "can't fit this", not as
  // "real-time mode isn't doing anything". Starts true so the ribbon
  // doesn't flash a warning before the first drag.
  const [relaxOk, setRelaxOk] = useState(true)
  const relaxReqId = useRef(0)
  const relaxThrottle = useRef({ lastSentAt: 0, timer: null, latest: null })
  // ponytail: mirror `data`/`positions` into refs so fireRelax can read their
  // CURRENT values at fire time without re-creating its closure every drag
  // frame. A useCallback that depends on [data, positions] captures stale
  // values by the time the throttled trailing timer fires (#4c), and the
  // response-apply step would push the dragged item back to a stale cursor
  // position (#4b) — both fixed by reading refs here instead of state.
  const dataRef = useRef(null)
  const positionsRef = useRef({})
  // latest dragged-item cursor position, separate from the throttle's
  // `latest` (which also carries the tag) so the response-apply step can
  // pin the dragged item at the CURRENT cursor, not the position the
  // request was sent at — fixes the mid-drag backward flicker (#4b).
  const relaxCursorRef = useRef(null)

  // Cancel any in-flight /relax: bump the id so a late response fails the
  // id-guard in fireRelax, and clear any pending throttled send. A hoisted
  // function declaration (not a const arrow) so undo/redo/applyProject can
  // reference it before its line in the source — it only reads refs, so no
  // useCallback/stable-identity concern.
  function cancelRelax() {
    relaxReqId.current += 1
    if (relaxThrottle.current.timer) {
      clearTimeout(relaxThrottle.current.timer)
      relaxThrottle.current.timer = null
    }
  }

  // Keep dataRef/positionsRef mirroring state so fireRelax's stable closure
  // reads current values at fire time (see the refs' declaration comment).
  // One effect, no deps — runs after every render, cheap.
  useEffect(() => {
    dataRef.current = data
    positionsRef.current = positions
  })

  // shared by the unit-picker load, File > New, and File > Open — swaps in
  // a whole new project (data + positions rebuilt from its equipment) and
  // clears anything that belonged to the previous one.
  const applyProject = useCallback((d) => {
    cancelRelax()
    wantFitRef.current = true // a fresh project should fit the viewport
    setData(d)
    const pos = {}
    for (const e of d.equipment) pos[e.tag] = { x: e.x, y: e.y }
    setPositions(pos)
    setScore(null)
    setCases(null)
    setSelectedEquips([])
    markClean()
    resetHistory()
  }, [markClean, resetHistory])

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
    fetch('/api/units')
      .then((r) => r.json())
      .then((names) => {
        setUnits(names)
        if (names.length) setUnitName(names[0])
      })
      .catch((err) => setLoadError({ message: err.message || String(err) }))
  }, [])

  useEffect(() => {
    if (!unitName) return
    fetch(`/api/units/${unitName}`).then((r) => r.json()).then((d) => {
      applyProject(d)
      setFileName(null) // loading a case study from the dropdown isn't "opening a file"
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitName])

  // Fit the viewport ONLY on an explicit request (fresh project load via
  // applyProject setting wantFitRef, or the manual Fit-width button) — never
  // because `data` got a new object identity, which also happens on every
  // relax/rotate/edit response and would snap a zoomed-in drag back to
  // full-site fit ~10x/sec. The early-return for !csize?.width comes before
  // the flag check so a pre-canvas load still fits once the canvas measures.
  useEffect(() => {
    if (!csize?.width) return
    if (!wantFitRef.current) return
    if (!data) return
    const fv = fitView(data.site, csize)
    setView(fv)
    fitW.current = fv.w
    wantFitRef.current = false
  }, [data, csize])

  // On canvas resize only (not data change), re-fit the viewBox aspect to
  // the new canvas aspect so the world→screen mapping stays undistorted
  // (preserveAspectRatio="none" would otherwise stretch the plot when the
  // window narrows/widens). Keeps the same center and width (i.e. the user's
  // zoom level), only height tracks the new aspect — see reaspect().
  useEffect(() => {
    setView((v) => (v ? reaspect(v, csize) : v))
  }, [csize])

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
    // In real-time mode the relax response is the authoritative source of
    // {feasible, cost}; a competing per-frame /score would only head-of-line-
    // block relax on the same origin and could overwrite the fresher relax
    // verdict with a stale one. Skip it.
    if (!realtimeMode) scoreLayout(next)
    markDirty()
  }, [scoreLayout, markDirty, realtimeMode])

  // Merge solver-driven shape changes (w/d/pull_side — the SA rotate move
  // and CP-SAT's ROT var can both flip an item's orientation while
  // searching for the best layout) back into data.equipment. x/y stay in
  // `positions`, not here — same "shape" (data.equipment) vs. "where"
  // (positions) split the rest of the app already uses. Response equipment
  // lists (POST /api/solve's `done` event, POST /api/relax) are full
  // Equipment dataclasses (asdict()), so every tag here always has w/d/
  // pull_side present.
  const applyRotations = useCallback((resEquipment) => {
    setData((d) => {
      const byTag = Object.fromEntries(resEquipment.map((e) => [e.tag, e]))
      let changed = false
      const equipment = d.equipment.map((e) => {
        const r = byTag[e.tag]
        if (!r) return e
        if (r.w === e.w && r.d === e.d && r.pull_side === e.pull_side
            && (r.nozzle_dx ?? 0) === (e.nozzle_dx ?? 0)
            && (r.nozzle_dy ?? 0) === (e.nozzle_dy ?? 0)) return e
        changed = true
        return { ...e, w: r.w, d: r.d, pull_side: r.pull_side,
                 nozzle_dx: r.nozzle_dx ?? 0, nozzle_dy: r.nozzle_dy ?? 0 }
      })
      // Identity-stable: a relax response that didn't actually rotate
      // anything returns the same `data` reference, so React bails the
      // update — no redundant [data]-effect /score and no churn. (With the
      // fit effect split off this no longer affects the viewport, but it
      // still removes the redundant score path for the common drag.)
      if (!changed) return d
      return { ...d, equipment }
    })
  }, [])

  // --- Mode 2: real-time layouting (POST /api/relax) ---------------------
  // realtimeMode/relaxOk/relaxReqId/relaxThrottle are declared up near the
  // other refs (before onPositions) — see above. Toggled from the Home
  // ribbon. While on, dragging an item also throttle-calls /relax, which
  // pins the dragged item at the cursor and reflows every other item
  // around it (server-side warm-start SA, with push-repair legalizing a
  // packed-row drop); the relax response (feasible flag + reflowed
  // positions) is the authoritative source of {feasible, cost} in real-time
  // mode, so drag frames skip the competing per-frame /score call.
  // fireRelax is stable (no [data, positions] deps) — it reads those via
  // refs at fire time so the throttled trailing timer can't fire with a
  // stale closure (#4c), and applies the dragged item's CURRENT cursor
  // position from relaxCursorRef instead of the request-time one (#4b).
  const fireRelax = useCallback(() => {
    const args = relaxThrottle.current.latest
    relaxThrottle.current.timer = null
    relaxThrottle.current.lastSentAt = Date.now()
    const d = dataRef.current
    if (!args || !d) return
    const { tag, x, y } = args
    const id = ++relaxReqId.current
    fetch('/api/relax', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: buildCaseData(d, positionsRef.current), tag, x, y }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`relax ${r.status}`)
        return r.json()
      })
      .then((res) => {
        if (id !== relaxReqId.current) return
        setRelaxOk(res.feasible)
        if (!res.feasible) return
        const pos = {}
        for (const e of res.equipment) pos[e.tag] = { x: e.x, y: e.y }
        // #4b: pin the dragged item at the CURRENT cursor, not the position
        // this (possibly stale) request was sent at — otherwise the item
        // flickers backward until the next local pointermove corrects it.
        const cur = relaxCursorRef.current
        if (cur && cur.tag === tag) pos[tag] = { x: cur.x, y: cur.y }
        setPositions(pos)
        applyRotations(res.equipment)
        setScore({ feasible: true, cost: res.cost })
      })
      .catch((err) => {
        // ponytail: distinguish a network drop (transient — the next drag
        // frame or on-drop flush retries) from a real backend error (a 500
        // from a genuine bug shouldn't be invisible). Network drops stay
        // silent; everything else surfaces to the console so a bug shows.
        if (err?.message === 'relax 404' || err?.name === 'TypeError') return
        console.error('relax failed:', err)
      })
  }, [applyRotations])

  // ~100ms throttle: fires immediately if it's been >=100ms since the last
  // call, otherwise schedules one trailing call for whenever that window
  // ends — always using the LATEST cursor position, so a fast continuous
  // drag gets a steady trickle of reflows instead of one queued call per
  // pointermove event. Also records the latest cursor in relaxCursorRef
  // so the response-apply step can pin the dragged item where it is now.
  const relaxLayout = useCallback((tag, x, y) => {
    relaxThrottle.current.latest = { tag, x, y }
    relaxCursorRef.current = { tag, x, y }
    const elapsed = Date.now() - relaxThrottle.current.lastSentAt
    if (elapsed >= 100) fireRelax()
    else if (!relaxThrottle.current.timer) relaxThrottle.current.timer = setTimeout(fireRelax, 100 - elapsed)
  }, [fireRelax])

  // "commit on drop": fire whatever's pending right away instead of waiting
  // out the rest of the throttle window, so the final reflow matches the
  // exact position the item was dropped at with no residual lag. Doesn't
  // clear relaxCursorRef — a pending fireRelax's response still needs the
  // cursor to pin the dropped item at its real drop position; the next drag's
  // relaxLayout overwrites the ref before any later relax fires anyway.
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
    commit()
    setData((d) => ({ ...d, keepouts: { ...d.keepouts, [name]: poly } }))
    markDirty()
  }, [commit, markDirty])

  const deleteZone = useCallback((name) => {
    commit()
    setData((d) => {
      const keepouts = { ...d.keepouts }
      delete keepouts[name]
      return { ...d, keepouts }
    })
    markDirty()
  }, [commit, markDirty])

  // edit a keepouts zone: update its polygon (drag a vertex) and/or rename it
  // (which changes its role/layer per the backend's zone-name convention).
  // No commit() here — the polygon-drag path commits once at pointer-down
  // via onInteractionStart (see PlotCanvas), and the rename path commits
  // explicitly in ZoneEditDialog's apply (passed as onRenameZoneCommit).
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
    markDirty()
  }, [markDirty])

  // rename-only entry point used by the Zone edit dialog's Apply button —
  // a discrete, non-drag edit, so it commits a snapshot first.
  const renameZone = useCallback((name, poly, nextName) => {
    commit()
    editZone(name, poly, nextName)
  }, [commit, editZone])

  // Ribbon's Delete button: remove the selected zone and clear the selection.
  const deleteSelectedZone = useCallback((name) => {
    deleteZone(name)
    setSelectedZone(null)
  }, [deleteZone])

  // Ribbon's Rotate buttons: rotate the selected equipment's footprint (and
  // its pull_side, if any) 90/180/270 clockwise. Only w/d/pull_side change —
  // x/y (in `positions`, not `data`) are untouched since rotating about an
  // item's own center doesn't move it. Changing `data` here re-triggers the
  // scoreLayout effect below, same as addZone/editZone.
  const rotateEquipment = useCallback((tags, deg) => {
    const set = new Set(Array.isArray(tags) ? tags : [tags])
    if (!set.size) return
    commit()
    setData((d) => ({
      ...d,
      equipment: d.equipment.map((e) => {
        if (!set.has(e.tag)) return e
        const swapped = deg % 180 !== 0
        const [ndx, ndy] = rotatePointCW(e.nozzle_dx || 0, e.nozzle_dy || 0, deg)
        return {
          ...e,
          w: swapped ? e.d : e.w,
          d: swapped ? e.w : e.d,
          pull_side: rotateSide(e.pull_side, deg),
          nozzle_dx: ndx,
          nozzle_dy: ndy,
        }
      }),
    }))
    markDirty()
  }, [commit, markDirty])

  // Ribbon's Object > Edit dialog: patch the selected equipment's own
  // fields (class/size/pinned/pull clearance). Deliberately does NOT
  // include `tag` — a rename would also have to rewrite `positions`'
  // key, `selectedEquip`, and every `connections` entry referencing the
  // old tag; keeping tag read-only in the dialog sidesteps that whole
  // class of bug for a field that's really just an identifier, not a
  // "property" of the equipment the way class/size/pinned are.
  const editEquipment = useCallback((tag, patch) => {
    commit()
    setData((d) => ({
      ...d,
      equipment: d.equipment.map((e) => (e.tag === tag ? { ...e, ...patch } : e)),
    }))
    markDirty()
  }, [commit, markDirty])

  // Ribbon's Object > Remove button: drop the selected equipment (one tag
  // from the ribbon's single-primary path, OR every tag in the multi-select
  // when called with an array), its position(s), and any connection
  // referencing it (a dangling connection would otherwise crash the next
  // Score/Solve call server-side, since piping_cost() looks up both ends by
  // tag with no missing-tag guard). Accepts a single tag or an array of
  // tags so the Object tab can remove the whole multi-select at once.
  const removeEquipment = useCallback((tags) => {
    const set = new Set(Array.isArray(tags) ? tags : [tags])
    if (!set.size) return
    commit()
    setData((d) => ({
      ...d,
      equipment: d.equipment.filter((e) => !set.has(e.tag)),
      connections: (d.connections ?? []).filter((c) => !set.has(c.a) && !set.has(c.b)),
    }))
    setPositions((p) => {
      const next = { ...p }
      for (const t of set) delete next[t]
      return next
    })
    setSelectedEquips([])
    markDirty()
  }, [commit, markDirty])

  // Ribbon's Zone > Rotate: rotate the selected zone's polygon 90/270° CW
  // about its centroid. Purely a polygon edit — a zone's role/layer comes
  // from its NAME prefix (RACK*/ROAD*/MAINT*), not its orientation, so
  // unlike the equipment rotate there's no pull_side to cycle. Roads/racks
  // are centerline+width rectangles, so a 90° rotate just swaps which axis
  // the centerline runs along; for a generic keep-out the whole shape turns.
  const rotateZone = useCallback((name, deg) => {
    commit()
    setData((d) => {
      const poly = d.keepouts?.[name]
      if (!poly) return d
      return { ...d, keepouts: { ...d.keepouts, [name]: rotatePolyCW(poly, deg) } }
    })
    markDirty()
  }, [commit, markDirty])

  // ponytail: the canvas calls this at the START of a continuous drag
  // (equipment move, zone move, vertex/edge resize) so the undo history
  // captures the layout as it was BEFORE the drag began — one snapshot
  // for the whole drag, not one per pointermove frame (which would fill
  // the stack with 100 near-identical micro-states from a single gesture).
  const onInteractionStart = useCallback(() => {
    commit()
  }, [commit])

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
    const controller = new AbortController()
    solveAbortRef.current = controller
    setSolving(true)
    setSolveProgress({ fraction: 0, seed: null, seed_index: 0, seed_count: 1 })
    try {
      // ponytail: a seed is just an integer that seeds Python's
      // random.Random() — any distinct integers work, so "N random cases"
      // is simply N fresh random integers, no different from the old
      // hand-typed 0:N sequential range as far as the solver's concerned.
      const n = Math.max(1, Math.round(Number(caseCount) || 1))
      const seeds = Array.from({ length: n }, () => Math.floor(Math.random() * 1e9))
      const r = await fetch('/api/solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify({ data: buildCaseData(data, positions), seeds }),
        signal: controller.signal,
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
      commit()
      const pos = {}
      for (const e of result.equipment) pos[e.tag] = { x: e.x, y: e.y }
      setPositions(pos)
      applyRotations(result.equipment)
      setScore({ feasible: true, cost: result.cost })
      setCases(result.cases)
      markDirty()
    } catch (err) {
      // ponytail: an aborted fetch (stopSolve's doing) is an intentional
      // cancel, not a failure — the backend's should_stop already returns
      // its best-so-far layout when stopped, but the client's own reader
      // gets torn down by the abort before that final `done` event can
      // arrive, so there's nothing to apply here; just leave the layout as
      // it was before Solve was clicked.
      if (err.name !== 'AbortError') throw err
    } finally {
      setSolving(false)
      setSolveProgress(null)
      solveAbortRef.current = null
    }
  }

  function stopSolve() {
    solveAbortRef.current?.abort()
  }

  // Ribbon's Results dialog: browse any of the last Solve's cases, not
  // just the winner — clicking a row applies that case's layout the exact
  // same way solve()'s own `done` handler applies the best one (positions,
  // rotations, score), so switching between cases is just as cheap/
  // reversible as a normal drag or re-solve.
  function applyCase(c) {
    commit()
    const pos = {}
    for (const e of c.equipment) pos[e.tag] = { x: e.x, y: e.y }
    setPositions(pos)
    applyRotations(c.equipment)
    setScore({ feasible: true, cost: c.cost })
    markDirty()
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
        setNotice({
          title: `Couldn't open "${file.name}"`,
          body: err.message || String(err),
        })
      }
    }
    reader.readAsText(file)
  }

  function saveProject() {
    if (fileName) {
      downloadText(projectFileContents(data, positions), fileName)
      markClean()
    } else {
      setSaveAsOpen(true)
    }
  }

  function saveProjectAs() {
    setSaveAsOpen(true)
  }

  function confirmSaveAs(finalName) {
    downloadText(projectFileContents(data, positions), finalName)
    setFileName(finalName)
    setSaveAsOpen(false)
    markClean()
  }

  if (loadError) {
    return (
      <div
        className="flex h-screen flex-col items-center justify-center gap-3 text-muted-foreground"
        aria-live="polite"
      >
        <p>Couldn't reach the backend.</p>
        <p className="text-xs">{loadError.message}</p>
        <Button variant="outline" size="sm" onClick={() => {
          setLoadError(null)
          window.location.reload()
        }}>
          Retry
        </Button>
      </div>
    )
  }

  if (!data) {
    return (
      <div
        className="flex h-screen items-center justify-center text-muted-foreground"
        aria-live="polite"
      >
        <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" /> Loading…
      </div>
    )
  }

  return (
    <div className="app-shell">
      <a href="#canvas-main" className="skip-link">Skip to canvas</a>
      <h1 className="sr-only">Plotplan Fit Me — refinery plot planner</h1>

      <header>
        <Ribbon
          units={units} unitName={unitName} setUnitName={setUnitName}
          caseCount={caseCount} setCaseCount={setCaseCount}
          solve={solve} stopSolve={stopSolve} solving={solving} cases={cases} applyCase={applyCase}
          showGrid={showGrid} setShowGrid={setShowGrid}
          showRuler={showRuler} setShowRuler={setShowRuler}
          gridStep={gridStep} setGridStep={setGridStep}
          snap={snap} setSnap={setSnap}
          viewMode={viewMode} setViewMode={setViewMode}
          tool={tool} setTool={setTool} bumpDrawPrompt={bumpDrawPrompt} fit={fit}
          bumpEditPrompt={bumpEditPrompt} selectedZone={selectedZone} deleteZone={deleteSelectedZone}
          selectedEquip={selectedEquip} rotateEquipment={rotateEquipment} rotateZone={rotateZone}
          bumpEditEquipPrompt={bumpEditEquipPrompt} removeEquipment={removeEquipment}
          selectedEquips={selectedEquips}
          zoomPct={view ? zoomPercent(view, fitW.current) : 100} setZoomPercent={setZoomPercent}
          newProject={newProject} openProject={openProject}
          saveProject={saveProject} saveProjectAs={saveProjectAs}
          exportDxf={exportDxf} exportTakeoff={exportTakeoff} exportRaster={exportRaster}
          theme={theme} setTheme={setTheme}
          rackWidth={rackWidth} setRackWidth={setRackWidth}
          rackBeamSpacing={rackBeamSpacing} setRackBeamSpacing={setRackBeamSpacing}
          roadWidth={roadWidth} setRoadWidth={setRoadWidth}
          realtimeMode={realtimeMode} setRealtimeMode={toggleRealtimeMode}
          setNotice={setNotice}
          undo={undo} redo={redo} canUndo={canUndo} canRedo={canRedo}
        />
      </header>

      <main className="canvas-area" id="canvas-main" aria-label="Site layout canvas">
        {solving && solveProgress && (
          <div className="solve-progress" aria-busy="true" role="progressbar"
               aria-label="Solve progress"
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
          editEquipPromptNonce={editEquipPromptNonce} onEditEquipment={editEquipment}
          onCursor={setCursor} onSize={setCsize}
          onAddZone={addZone} onDeleteZone={deleteZone} onEditZone={editZone} onRenameZone={renameZone}
          selectedZone={selectedZone} setSelectedZone={setSelectedZone}
          selectedEquip={selectedEquip} setSelectedEquip={setSelectedEquip}
          selectedEquips={selectedEquips} setSelectedEquips={setSelectedEquips}
          onInteractionStart={onInteractionStart}
        />
      </main>

      <StatusBar
        projectLabel={fileName ?? data.name ?? 'untitled'} score={score} cursor={cursor}
        zoomPct={view ? zoomPercent(view, fitW.current) : 100} setZoomPercent={setZoomPercent}
        tool={tool} realtimeMode={realtimeMode} relaxOk={relaxOk}
        data={data} positions={positions} selectedEquip={selectedEquip}
      />

      <NoticeDialog notice={notice} onClose={() => setNotice(null)} />
      <SaveAsDialog
        open={saveAsOpen}
        initial={fileName ?? `${data.name || 'layout'}.json`}
        onCancel={() => setSaveAsOpen(false)}
        onConfirm={confirmSaveAs}
      />
    </div>
  )
}

export default App

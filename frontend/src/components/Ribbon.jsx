import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeftRight, FilePlus, FileUp, Grid3x3, Hand, Info, LayoutGrid, ListOrdered, Magnet,
  MousePointer2, Palette, Pause, Pencil, Play, Redo2, RotateCw, Ruler, Save, Search,
  Settings as SettingsIcon, Trash2, Undo2, Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Menubar, MenubarContent, MenubarItem, MenubarMenu,
  MenubarSeparator, MenubarShortcut, MenubarSub, MenubarSubContent, MenubarSubTrigger, MenubarTrigger,
} from '@/components/ui/menubar'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Toggle } from '@/components/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

function Group({ label, children }) {
  return (
    <div className="ribbon-group">
      <div className="ribbon-group-body">{children}</div>
      <div className="ribbon-group-label">{label}</div>
    </div>
  )
}

const ZOOM_PRESETS = [200, 150, 100, 75, 50, 25]

// Word-style "Zoom" dialog: a preset radio list plus a free-entry percent
// field, opened from a single magnifier button — replaces the old inline
// zoom-in/zoom-out/percent controls in the ribbon.
export function ZoomDialog({ zoomPct, setZoomPercent, trigger }) {
  const [open, setOpen] = useState(false)
  const [pct, setPct] = useState(zoomPct)

  useEffect(() => {
    if (open) setPct(zoomPct)
  }, [open, zoomPct])

  function apply() {
    const n = Number(pct)
    if (Number.isFinite(n) && n > 0) setZoomPercent(n)
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? <Button variant="outline" size="icon" title="Zoom" aria-label="Zoom"><Search /></Button>}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Zoom</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {ZOOM_PRESETS.map((p) => (
            <label key={p} className="flex items-center gap-2 text-sm">
              <input
                type="radio" name="zoom-preset" checked={Number(pct) === p}
                onChange={() => setPct(p)}
              />
              {p}%
            </label>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="zoom-pct" className="text-sm">Percent:</Label>
          <Input
            id="zoom-pct" type="number" min="1" value={pct}
            onChange={(e) => setPct(e.target.value)}
            className="w-24"
          />
        </div>
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
          <Button onClick={apply}>OK</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Ranked case table from the last Solve — hidden until `cases` exist.
// Each row's "View" button applies that case's own layout to the canvas
// (App.jsx's applyCase) so the user can browse/compare every randomly-
// seeded case's arrangement, not just the winner Solve already applied.
// `cases` arrives from the backend pre-sorted best-cost-first.
function ResultsDialog({ cases, applyCase }) {
  const [open, setOpen] = useState(false)
  if (!cases?.length) return null
  const bestCost = cases[0].cost

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" title="Case results" aria-label="Case results">
          <ListOrdered className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Case results</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-background">
              <tr className="text-left text-muted-foreground">
                <th className="pb-1">Case</th>
                <th className="pb-1">Score</th>
                <th className="pb-1" />
              </tr>
            </thead>
            <tbody>
              {cases.map((c, i) => (
                <tr key={c.seed} className={c.cost === bestCost ? 'font-semibold' : ''}>
                  <td className="py-0.5">{i + 1}</td>
                  <td>{c.cost.toFixed(0)}{c.cost === bestCost ? ' (best)' : ''}</td>
                  <td className="pl-2">
                    <Button variant="outline" size="sm" onClick={() => applyCase(c)}>View</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">Close</Button></DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const THEME_OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Match system' },
]

// Theme picker — Light/Dark/System toggles the .dark class App.jsx applies
// to <html>, persisted to localStorage (see App.jsx's theme effect).
function CustomizeUiDialog({ theme, setTheme }) {
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon" title="Customize UI" aria-label="Customize UI"><Palette /></Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Customize UI</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label className="text-sm text-muted-foreground">Theme</Label>
          {THEME_OPTIONS.map((o) => (
            <label key={o.value} className="flex items-center gap-2 text-sm">
              <input
                type="radio" name="theme" checked={theme === o.value}
                onChange={() => setTheme(o.value)}
              />
              {o.label}
            </label>
          ))}
        </div>
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">Close</Button></DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// App-wide defaults for road/rack drawing — same values the draw-prompt
// dialog (Insert > Draw road/rack) seeds itself from, editable here without
// having to start drawing a zone first. Also covers the grid/ruler view
// preferences (on/off, and a fixed grid major-tick step in meters; blank
// means "auto", same as the View tab's Auto button).
function SettingsDialog({
  rackWidth, setRackWidth, rackBeamSpacing, setRackBeamSpacing, roadWidth, setRoadWidth,
  showGrid, setShowGrid, showRuler, setShowRuler, gridStep, setGridStep,
}) {
  const [open, setOpen] = useState(false)
  const [rw, setRw] = useState(rackWidth)
  const [rbs, setRbs] = useState(rackBeamSpacing)
  const [rdw, setRdw] = useState(roadWidth)
  const [g, setG] = useState(showGrid)
  const [r, setR] = useState(showRuler)
  const [gs, setGs] = useState(gridStep ?? '')

  useEffect(() => {
    if (open) {
      setRw(rackWidth); setRbs(rackBeamSpacing); setRdw(roadWidth)
      setG(showGrid); setR(showRuler); setGs(gridStep ?? '')
    }
  }, [open, rackWidth, rackBeamSpacing, roadWidth, showGrid, showRuler, gridStep])

  function apply() {
    const w = Number(rw), b = Number(rbs), d = Number(rdw)
    if (Number.isFinite(w) && w > 0) setRackWidth(w)
    if (Number.isFinite(b) && b > 0) setRackBeamSpacing(b)
    if (Number.isFinite(d) && d > 0) setRoadWidth(d)
    setShowGrid(g)
    setShowRuler(r)
    const gsn = Number(gs)
    setGridStep(gs === '' || !Number.isFinite(gsn) || gsn <= 0 ? null : gsn)
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon" title="Settings" aria-label="Settings"><SettingsIcon /></Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Label htmlFor="set-rack-w" className="w-44 text-sm">Default rack width (m)</Label>
            <Input
              id="set-rack-w" type="number" min="0.1" step="0.5" value={rw}
              onChange={(e) => setRw(e.target.value)} className="w-24"
            />
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="set-rack-b" className="w-44 text-sm">Rack beam spacing (m)</Label>
            <Input
              id="set-rack-b" type="number" min="0.1" step="0.5" value={rbs}
              onChange={(e) => setRbs(e.target.value)} className="w-24"
            />
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="set-road-w" className="w-44 text-sm">Default road width (m)</Label>
            <Input
              id="set-road-w" type="number" min="0.1" step="0.5" value={rdw}
              onChange={(e) => setRdw(e.target.value)} className="w-24"
            />
          </div>
          <div className="my-1 h-px bg-border" />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={g} onChange={(e) => setG(e.target.checked)} />
            Show grid
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={r} onChange={(e) => setR(e.target.checked)} />
            Show rulers
          </label>
          <div className="flex items-center gap-2">
            <Label htmlFor="set-grid-step" className="w-44 text-sm">Grid spacing (m, blank = auto)</Label>
            <Input
              id="set-grid-step" type="number" min="0.1" step="1" placeholder="auto…"
              value={gs}
              onChange={(e) => setGs(e.target.value)}
              className="w-24"
            />
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
          <Button onClick={apply}>OK</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function Ribbon(props) {
  const {
    units, unitName, setUnitName, caseCount, setCaseCount, solve, stopSolve, solving, cases, applyCase,
    showGrid, setShowGrid, showRuler, setShowRuler, gridStep, setGridStep, snap, setSnap,
    viewMode, setViewMode,
    tool, setTool, bumpDrawPrompt, fit, zoomPct, setZoomPercent,
    bumpEditPrompt, selectedZone, deleteZone,
    selectedEquip, rotateEquipment, rotateZone, bumpEditEquipPrompt, removeEquipment,
    newProject, openProject, saveProject, saveProjectAs, exportDxf, exportTakeoff, exportRaster,
    theme, setTheme,
    rackWidth, setRackWidth, rackBeamSpacing, setRackBeamSpacing, roadWidth, setRoadWidth,
    realtimeMode, setRealtimeMode,
    setNotice,
    undo, redo, canUndo, canRedo,
  } = props

  const openInputRef = useRef(null)
  // "Zone" and "Object" are contextual tabs (Word's Table Design/Layout
  // pattern) — each only exists in the tab list while its kind of thing is
  // selected, and selecting one jumps you straight to its tab instead of
  // leaving it to be found by hand. Deselecting falls back to Home, but
  // only if a contextual tab was actually the active one — if the user had
  // already clicked elsewhere, losing the selection shouldn't yank them
  // off whatever tab they're on. Zone and Object selection are mutually
  // exclusive in practice (equipment only selects in Select mode, zones
  // only in Edit mode, and switching tool mode clears both), so there's
  // never a conflict over which contextual tab should win.
  const [activeTab, setActiveTab] = useState('home')
  useEffect(() => {
    if (selectedZone) setActiveTab('zone')
    else if (selectedEquip) setActiveTab('object')
    else setActiveTab((t) => (t === 'zone' || t === 'object' ? 'home' : t))
  }, [selectedZone, selectedEquip])

  function handleOpenFile(e) {
    const file = e.target.files[0]
    if (file) openProject(file)
    e.target.value = '' // allow re-opening the same filename later
  }

  return (
    <div className="ribbon-shell">
      <input
        ref={openInputRef} type="file" accept=".json,application/json"
        className="hidden" onChange={handleOpenFile}
      />
      <Tabs value={activeTab} onValueChange={setActiveTab} className="ribbon-tabs gap-0">
        {/* single Word-style row: File menu, the ribbon tabs, then Help menu
            pushed to the right — no separate menu-bar strip above the tabs. */}
        <div className="ribbon-tabrow">
          <LayoutGrid className="app-icon" aria-hidden="true" />
          <Menubar className="titlebar-menubar border-0 bg-transparent p-0 shadow-none" aria-label="File menu">
            <MenubarMenu>
              <MenubarTrigger>File</MenubarTrigger>
              <MenubarContent>
                <MenubarItem onSelect={newProject}>
                  <FilePlus className="size-4" /> New <MenubarShortcut>⌘N</MenubarShortcut>
                </MenubarItem>
                <MenubarItem onSelect={() => openInputRef.current?.click()}>
                  <FileUp className="size-4" /> Open… <MenubarShortcut>⌘O</MenubarShortcut>
                </MenubarItem>
                <MenubarSeparator />
                <MenubarItem onSelect={saveProject}>
                  <Save className="size-4" /> Save <MenubarShortcut>⌘S</MenubarShortcut>
                </MenubarItem>
                <MenubarItem onSelect={saveProjectAs}>Save As…</MenubarItem>
                <MenubarSeparator />
                <MenubarSub>
                  <MenubarSubTrigger>Export</MenubarSubTrigger>
                  <MenubarSubContent>
                    <MenubarItem onSelect={exportDxf}>DXF…</MenubarItem>
                    <MenubarItem onSelect={() => exportRaster('png')}>PNG…</MenubarItem>
                    <MenubarItem onSelect={() => exportRaster('jpg')}>JPG…</MenubarItem>
                    <MenubarSeparator />
                    <MenubarItem onSelect={exportTakeoff}>Takeoff CSV…</MenubarItem>
                  </MenubarSubContent>
                </MenubarSub>
              </MenubarContent>
            </MenubarMenu>
          </Menubar>

          <TabsList variant="line" className="ribbon-tablist" aria-label="Ribbon sections">
            <TabsTrigger value="home">Home</TabsTrigger>
            <TabsTrigger value="insert">Insert</TabsTrigger>
            <TabsTrigger value="view">View</TabsTrigger>
            <TabsTrigger value="tools">Tools</TabsTrigger>
            {selectedZone && (
              <TabsTrigger value="zone" className="ribbon-tab-contextual">Zone</TabsTrigger>
            )}
            {selectedEquip && (
              <TabsTrigger value="object" className="ribbon-tab-contextual">Object</TabsTrigger>
            )}
          </TabsList>

          <Menubar className="titlebar-menubar ml-auto border-0 bg-transparent p-0 shadow-none" aria-label="Help menu">
            <MenubarMenu>
              <MenubarTrigger>Help</MenubarTrigger>
              <MenubarContent align="end">
                <MenubarItem
                  onSelect={() =>
                    setNotice?.({
                      title: 'Plotplan Fit Me Help',
                      body:
                        'Generative plot plan tool for refinery/petrochemical unit layout.\n\n'
                        + 'Pick a Case Study (or File > New), drag equipment for a live '
                        + 'score, or Solve to auto-lay-out. Insert > Draw lets you add roads '
                        + 'and pipe racks directly on the canvas.',
                    })
                  }
                >
                  Plotplan Fit Me Help
                </MenubarItem>
                <MenubarItem
                  onSelect={() => setNotice?.({
                    title: 'About Plotplan Fit Me',
                    body: 'Generative plot plan layout tool.',
                  })}
                >
                  <Info className="size-4" /> About
                </MenubarItem>
              </MenubarContent>
            </MenubarMenu>
          </Menubar>
        </div>

        <TabsContent value="home" className="ribbon-body">
          <Group label="Case Study">
            <Select value={unitName ?? ''} onValueChange={setUnitName}>
              <SelectTrigger className="w-48" aria-label="Case study"><SelectValue placeholder="Select a unit" /></SelectTrigger>
              <SelectContent>
                {units.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}
              </SelectContent>
            </Select>
          </Group>
          <Separator orientation="vertical" className="h-auto" />
          <Group label="Tools">
            <ToggleGroup type="single" variant="outline" value={tool}
              onValueChange={(v) => v && setTool(v)}
            >
              <ToggleGroupItem value="select" title="Select / Move" aria-label="Select / Move"><MousePointer2 /></ToggleGroupItem>
              <ToggleGroupItem value="pan" title="Pan" aria-label="Pan"><Hand /></ToggleGroupItem>
              <ToggleGroupItem value="edit" title="Edit — drag roads, pipe racks, and other zones to move them" aria-label="Edit — drag roads, pipe racks, and other zones to move them"><Pencil /></ToggleGroupItem>
            </ToggleGroup>
          </Group>
          <Separator orientation="vertical" className="h-auto" />
          <Group label="History">
            <Button
              variant="outline" size="icon" disabled={!canUndo} onClick={undo}
              title="Undo (Ctrl+Z)" aria-label="Undo"
            >
              <Undo2 />
            </Button>
            <Button
              variant="outline" size="icon" disabled={!canRedo} onClick={redo}
              title="Redo (Ctrl+Shift+Z)" aria-label="Redo"
            >
              <Redo2 />
            </Button>
          </Group>
          <Separator orientation="vertical" className="h-auto" />
          <Group label="Zoom">
            <ZoomDialog zoomPct={zoomPct} setZoomPercent={setZoomPercent} />
            <Button variant="outline" size="icon" onClick={fit} title="Fit width" aria-label="Fit width"><ArrowLeftRight /></Button>
          </Group>
          <Separator orientation="vertical" className="h-auto" />
          <Group label="Solve">
            <Button
              onClick={solving ? stopSolve : solve} className="solve-btn flex-col gap-1 px-4"
              title={solving ? 'Stop solving' : 'Solve'}
              aria-label={solving ? 'Stop solving' : 'Solve'}
            >
              {solving ? <Pause className="size-5" aria-hidden="true" /> : <Play className="size-5" aria-hidden="true" />}
            </Button>
            <ResultsDialog cases={cases} applyCase={applyCase} />
          </Group>
          <Separator orientation="vertical" className="h-auto" />
          <Group label="Cases">
            <div className="flex flex-col gap-1">
              <Label htmlFor="cases" className="sr-only">Cases to try</Label>
              <Input
                id="cases" type="number" min="1" step="1" value={caseCount}
                onChange={(e) => setCaseCount(e.target.value)}
                title="How many randomly-seeded cases to try"
                aria-label="How many randomly-seeded cases to try" className="w-16"
              />
            </div>
          </Group>
          <Separator orientation="vertical" className="h-auto" />
          <Group label="Real-time">
            <Toggle
              variant="outline" pressed={realtimeMode} onPressedChange={setRealtimeMode}
              title="Real-time move — reflow the layout live around a dragged item (POST /api/relax) instead of just scoring it" aria-label="Real-time move — reflow the layout live around a dragged item (POST /api/relax) instead of just scoring it"
            >
              <Zap />
            </Toggle>
          </Group>
        </TabsContent>

        <TabsContent value="insert" className="ribbon-body">
          <Group label="Draw zone">
            <Button
              variant={tool === 'draw-road' ? 'default' : 'outline'} size="icon"
              onClick={() => { setTool('draw-road'); bumpDrawPrompt() }} title="Draw road" aria-label="Draw road"
            >
              <span className="font-bold">R</span>
            </Button>
            <Button
              variant={tool === 'draw-rack' ? 'default' : 'outline'} size="icon"
              onClick={() => { setTool('draw-rack'); bumpDrawPrompt() }} title="Draw pipe rack" aria-label="Draw pipe rack"
            >
              <span className="font-bold">P</span>
            </Button>
            <Button
              variant={tool === 'draw-maint' ? 'default' : 'outline'} size="icon"
              onClick={() => { setTool('draw-maint'); bumpDrawPrompt() }} title="Draw maintenance corridor" aria-label="Draw maintenance corridor"
            >
              <span className="font-bold">M</span>
            </Button>
            <Button
              variant={tool === 'draw-underground' ? 'default' : 'outline'} size="icon"
              onClick={() => { setTool('draw-underground'); bumpDrawPrompt() }} title="Draw underground keep-out" aria-label="Draw underground keep-out"
            >
              <span className="font-bold">U</span>
            </Button>
            <Button
              variant={tool === 'draw-keepout' ? 'default' : 'outline'} size="icon"
              onClick={() => { setTool('draw-keepout'); bumpDrawPrompt() }} title="Draw keep-out zone" aria-label="Draw keep-out zone"
            >
              <span className="font-bold">K</span>
            </Button>
          </Group>
          <Separator orientation="vertical" className="h-auto" />
          <Group label="Snap">
            <Toggle variant="outline" pressed={snap} onPressedChange={setSnap} title="Snap to grid" aria-label="Snap to grid">
              <Magnet />
            </Toggle>
          </Group>
        </TabsContent>

        {/* contextual tab, Word's Table Design/Layout pattern — only exists
            (in both the tab list above and here) while a zone is selected;
            see the activeTab effect. No disabled-button guards needed
            anymore since this content literally can't render otherwise. */}
        {selectedZone && (
          <TabsContent value="zone" className="ribbon-body">
            <Group label="Selected zone">
              <Button variant="outline" size="icon" onClick={() => bumpEditPrompt()} title="Edit selected zone" aria-label="Edit selected zone">
                <Pencil />
              </Button>
              <Button
                variant="outline" size="icon"
                onClick={() => deleteZone(selectedZone)} title="Delete selected zone" aria-label="Delete selected zone"
              >
                <Trash2 />
              </Button>
            </Group>
            <Separator orientation="vertical" className="h-auto" />
            <Group label="Rotate">
              <Button
                variant="outline" size="icon"
                onClick={() => rotateZone(selectedZone, 90)} title="Rotate selected zone 90° CW" aria-label="Rotate selected zone 90° CW"
              >
                <RotateCw />
              </Button>
              <Button
                variant="outline" size="icon"
                onClick={() => rotateZone(selectedZone, 270)} title="Rotate selected zone 270° CW (90° CCW)" aria-label="Rotate selected zone 270° CW (90° CCW)"
              >
                <RotateCw className="-scale-x-100" />
              </Button>
            </Group>
          </TabsContent>
        )}

        {/* same pattern as the Zone tab above, for a selected equipment. */}
        {selectedEquip && (
          <TabsContent value="object" className="ribbon-body">
            <Group label="Selected object">
              <Button
                variant="outline" size="icon"
                onClick={() => bumpEditEquipPrompt()} title="Edit selected object" aria-label="Edit selected object"
              >
                <Pencil />
              </Button>
              <Button
                variant="outline" size="icon"
                onClick={() => removeEquipment(selectedEquip)} title="Remove selected object" aria-label="Remove selected object"
              >
                <Trash2 />
              </Button>
            </Group>
            <Separator orientation="vertical" className="h-auto" />
            <Group label="Rotate">
              <Button
                variant="outline" size="icon"
                onClick={() => rotateEquipment(selectedEquip, 90)} title="Rotate selected equipment 90° CW" aria-label="Rotate selected equipment 90° CW"
              >
                <RotateCw />
              </Button>
              <Button
                variant="outline" size="icon"
                onClick={() => rotateEquipment(selectedEquip, 270)} title="Rotate selected equipment 270° CW (90° CCW)" aria-label="Rotate selected equipment 270° CW (90° CCW)"
              >
                <RotateCw className="-scale-x-100" />
              </Button>
            </Group>
          </TabsContent>
        )}

        <TabsContent value="view" className="ribbon-body">
          <Group label="Zoom">
            <ZoomDialog zoomPct={zoomPct} setZoomPercent={setZoomPercent} />
            <Button variant="outline" size="icon" onClick={fit} title="Fit width" aria-label="Fit width"><ArrowLeftRight /></Button>
          </Group>
          <Separator orientation="vertical" className="h-auto" />
          <Group label="View mode">
            <Select value={viewMode} onValueChange={setViewMode}>
              <SelectTrigger className="w-32" aria-label="View mode"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="normal">Normal</SelectItem>
                <SelectItem value="wireframe">Wireframe</SelectItem>
                <SelectItem value="dxf">DXF</SelectItem>
              </SelectContent>
            </Select>
          </Group>
          <Separator orientation="vertical" className="h-auto" />
          <Group label="Show">
            <ToggleGroup type="multiple" variant="outline"
              value={[showGrid && 'grid', showRuler && 'ruler'].filter(Boolean)}
              onValueChange={(vals) => { setShowGrid(vals.includes('grid')); setShowRuler(vals.includes('ruler')) }}
            >
              <ToggleGroupItem value="grid" title="Grid" aria-label="Grid"><Grid3x3 /></ToggleGroupItem>
              <ToggleGroupItem value="ruler" title="Rulers" aria-label="Rulers"><Ruler /></ToggleGroupItem>
            </ToggleGroup>
          </Group>
          <Separator orientation="vertical" className="h-auto" />
          <Group label="Grid & ruler spacing">
            <div className="flex flex-col gap-1">
              <Label htmlFor="gridstep" className="sr-only">Grid spacing (m)</Label>
              <div className="flex gap-1">
                <Input
                  id="gridstep" type="number" min="0.1" step="1" placeholder="auto…"
                  value={gridStep ?? ''}
                  onChange={(e) => setGridStep(e.target.value === '' ? null : Number(e.target.value))}
                  aria-label="Grid spacing in meters, blank for auto"
                  className="w-20"
                />
                <Button variant="outline" size="sm" onClick={() => setGridStep(null)} title="Auto spacing" aria-label="Auto spacing">
                  Auto
                </Button>
              </div>
            </div>
          </Group>
          <Separator orientation="vertical" className="h-auto" />
          <Group label="Tool">
            <ToggleGroup type="single" variant="outline" value={tool}
              onValueChange={(v) => v && setTool(v)}
            >
              <ToggleGroupItem value="select" title="Select / drag" aria-label="Select / drag"><MousePointer2 /></ToggleGroupItem>
              <ToggleGroupItem value="pan" title="Pan" aria-label="Pan"><Hand /></ToggleGroupItem>
            </ToggleGroup>
          </Group>
        </TabsContent>

        <TabsContent value="tools" className="ribbon-body">
          <Group label="Appearance">
            <CustomizeUiDialog theme={theme} setTheme={setTheme} />
          </Group>
          <Separator orientation="vertical" className="h-auto" />
          <Group label="Preferences">
            <SettingsDialog
              rackWidth={rackWidth} setRackWidth={setRackWidth}
              rackBeamSpacing={rackBeamSpacing} setRackBeamSpacing={setRackBeamSpacing}
              roadWidth={roadWidth} setRoadWidth={setRoadWidth}
              showGrid={showGrid} setShowGrid={setShowGrid}
              showRuler={showRuler} setShowRuler={setShowRuler}
              gridStep={gridStep} setGridStep={setGridStep}
            />
          </Group>
        </TabsContent>
      </Tabs>
    </div>
  )
}

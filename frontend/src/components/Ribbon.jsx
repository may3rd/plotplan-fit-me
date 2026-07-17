import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeftRight, FilePlus, FileUp, Grid3x3, Hand, Info, LayoutGrid, ListOrdered, Loader2, Magnet,
  MousePointer2, Pencil, Play, Rows3, Route, Ruler, Save, Search, Trash2,
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
function ZoomDialog({ zoomPct, setZoomPercent }) {
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
        <Button variant="outline" size="icon" title="Zoom"><Search /></Button>
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

// Ranked seed/score table from the last Solve — hidden until `results` exist.
function ResultsDialog({ results }) {
  const [open, setOpen] = useState(false)
  if (!results?.length) return null
  const bestCost = Math.min(...results.map((r) => r.cost))

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" title="Seed results">
          <ListOrdered className="size-4" /> Results
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Seed results</DialogTitle>
        </DialogHeader>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="pb-1">Seed</th>
              <th className="pb-1">Score</th>
            </tr>
          </thead>
          <tbody>
            {[...results].sort((a, b) => a.cost - b.cost).map((r) => (
              <tr key={r.seed} className={r.cost === bestCost ? 'font-semibold' : ''}>
                <td>{r.seed}</td>
                <td>{r.cost.toFixed(0)}{r.cost === bestCost ? ' (best)' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">Close</Button></DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function Ribbon(props) {
  const {
    units, unitName, setUnitName, seedsInput, setSeedsInput, solve, solving, results,
    showGrid, setShowGrid, showRuler, setShowRuler, gridStep, setGridStep, snap, setSnap,
    tool, setTool, bumpDrawPrompt, fit, zoomPct, setZoomPercent,
    bumpEditPrompt, selectedZone, deleteZone,
    newProject, openProject, saveProject, saveProjectAs, exportDxf, exportTakeoff, exportRaster,
  } = props

  const openInputRef = useRef(null)

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
      <Tabs defaultValue="home" className="ribbon-tabs gap-0">
        {/* single Word-style row: File menu, the ribbon tabs, then Help menu
            pushed to the right — no separate menu-bar strip above the tabs. */}
        <div className="ribbon-tabrow">
          <LayoutGrid className="app-icon" />
          <Menubar className="titlebar-menubar border-0 bg-transparent p-0 shadow-none">
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

          <TabsList variant="line" className="ribbon-tablist">
            <TabsTrigger value="home">Home</TabsTrigger>
            <TabsTrigger value="insert">Insert</TabsTrigger>
            <TabsTrigger value="view">View</TabsTrigger>
          </TabsList>

          <Menubar className="titlebar-menubar ml-auto border-0 bg-transparent p-0 shadow-none">
            <MenubarMenu>
              <MenubarTrigger>Help</MenubarTrigger>
              <MenubarContent align="end">
                <MenubarItem
                  onSelect={() =>
                    window.alert(
                      'plotplan-fit-me — generative plot plan tool for refinery/petrochemical unit '
                      + 'layout.\n\nPick a Case Study (or File > New), drag equipment for a live '
                      + 'score, or Solve to auto-lay-out. Insert > Draw lets you add roads and pipe '
                      + 'racks directly on the canvas.',
                    )}
                >
                  Plotplan Fit Me Help
                </MenubarItem>
                <MenubarItem
                  onSelect={() => window.alert('Plotplan Fit Me\nGenerative plot plan layout tool.')}
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
              <SelectTrigger className="w-48"><SelectValue placeholder="Select a unit" /></SelectTrigger>
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
              <ToggleGroupItem value="select" title="Select / Move"><MousePointer2 /></ToggleGroupItem>
              <ToggleGroupItem value="pan" title="Pan"><Hand /></ToggleGroupItem>
              <ToggleGroupItem value="edit" title="Edit — drag roads, pipe racks, and other zones to move them"><Pencil /></ToggleGroupItem>
            </ToggleGroup>
          </Group>
          <Separator orientation="vertical" className="h-auto" />
          <Group label="Zoom">
            <ZoomDialog zoomPct={zoomPct} setZoomPercent={setZoomPercent} />
            <Button variant="outline" size="icon" onClick={fit} title="Fit width"><ArrowLeftRight /></Button>
          </Group>
          <Separator orientation="vertical" className="h-auto" />
          <Group label="Solve">
            <Button onClick={solve} disabled={solving} className="solve-btn flex-col gap-1 px-4">
              {solving ? <Loader2 className="size-5 animate-spin" /> : <Play className="size-5" />}
            </Button>
            <ResultsDialog results={results} />
          </Group>
          <Separator orientation="vertical" className="h-auto" />
          <Group label="Seeds">
            <div className="flex flex-col gap-1">
              <Input
                id="seeds" value={seedsInput} onChange={(e) => setSeedsInput(e.target.value)}
                title="n or a:b" placeholder="n or a:b" className="w-28"
              />
            </div>
          </Group>
        </TabsContent>

        <TabsContent value="insert" className="ribbon-body">
          <Group label="Draw zone">
            <Button
              variant={tool === 'draw-road' ? 'default' : 'outline'} size="icon"
              onClick={() => { setTool('draw-road'); bumpDrawPrompt() }} title="Draw road"
            >
              <Route />
            </Button>
            <Button
              variant={tool === 'draw-rack' ? 'default' : 'outline'} size="icon"
              onClick={() => { setTool('draw-rack'); bumpDrawPrompt() }} title="Draw pipe rack"
            >
              <Rows3 />
            </Button>
            <Button
              variant={tool === 'draw-maint' ? 'default' : 'outline'} size="icon"
              onClick={() => { setTool('draw-maint'); bumpDrawPrompt() }} title="Draw maintenance corridor"
            >
              <Route />
            </Button>
            <Button
              variant={tool === 'draw-underground' ? 'default' : 'outline'} size="icon"
              onClick={() => { setTool('draw-underground'); bumpDrawPrompt() }} title="Draw underground keep-out"
            >
              <Route />
            </Button>
            <Button
              variant={tool === 'draw-keepout' ? 'default' : 'outline'} size="icon"
              onClick={() => { setTool('draw-keepout'); bumpDrawPrompt() }} title="Draw keep-out zone"
            >
              <Route />
            </Button>
          </Group>
          <Separator orientation="vertical" className="h-auto" />
          <Group label="Selected zone">
            <Button
              variant="outline" size="icon"
              disabled={!selectedZone}
              onClick={() => bumpEditPrompt()} title="Edit selected zone"
            >
              <Pencil />
            </Button>
            <Button
              variant="outline" size="icon"
              disabled={!selectedZone}
              onClick={() => deleteZone(selectedZone)} title="Delete selected zone"
            >
              <Trash2 />
            </Button>
          </Group>
          <Separator orientation="vertical" className="h-auto" />
          <Group label="Snap">
            <Toggle variant="outline" pressed={snap} onPressedChange={setSnap} title="Snap to grid">
              <Magnet />
            </Toggle>
          </Group>
        </TabsContent>

        <TabsContent value="view" className="ribbon-body">
          <Group label="Zoom">
            <ZoomDialog zoomPct={zoomPct} setZoomPercent={setZoomPercent} />
            <Button variant="outline" size="icon" onClick={fit} title="Fit width"><ArrowLeftRight /></Button>
          </Group>
          <Separator orientation="vertical" className="h-auto" />
          <Group label="Show">
            <ToggleGroup type="multiple" variant="outline"
              value={[showGrid && 'grid', showRuler && 'ruler'].filter(Boolean)}
              onValueChange={(vals) => { setShowGrid(vals.includes('grid')); setShowRuler(vals.includes('ruler')) }}
            >
              <ToggleGroupItem value="grid" title="Grid"><Grid3x3 /></ToggleGroupItem>
              <ToggleGroupItem value="ruler" title="Rulers"><Ruler /></ToggleGroupItem>
            </ToggleGroup>
          </Group>
          <Separator orientation="vertical" className="h-auto" />
          <Group label="Grid & ruler spacing">
            <div className="flex flex-col gap-1">
              <div className="flex gap-1">
                <Input
                  id="gridstep" type="number" min="0.1" step="1" placeholder="auto"
                  value={gridStep ?? ''}
                  onChange={(e) => setGridStep(e.target.value === '' ? null : Number(e.target.value))}
                  className="w-20"
                />
                <Button variant="outline" size="sm" onClick={() => setGridStep(null)} title="Auto spacing">
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
              <ToggleGroupItem value="select" title="Select / drag"><MousePointer2 /></ToggleGroupItem>
              <ToggleGroupItem value="pan" title="Pan"><Hand /></ToggleGroupItem>
            </ToggleGroup>
          </Group>
        </TabsContent>
      </Tabs>
    </div>
  )
}

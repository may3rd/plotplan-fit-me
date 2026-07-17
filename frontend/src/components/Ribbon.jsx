import {
  Grid3x3, Hand, Info, Loader2, Maximize, MousePointer2, Play, Ruler, ZoomIn, ZoomOut,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Menubar, MenubarCheckboxItem, MenubarContent, MenubarItem, MenubarMenu,
  MenubarSeparator, MenubarShortcut, MenubarTrigger,
} from '@/components/ui/menubar'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

function Group({ label, children }) {
  return (
    <div className="ribbon-group">
      <div className="ribbon-group-body">{children}</div>
      <div className="ribbon-group-label">{label}</div>
    </div>
  )
}

export default function Ribbon(props) {
  const {
    units, unitName, setUnitName, seedsInput, setSeedsInput, solve, solving, score,
    showGrid, setShowGrid, showRuler, setShowRuler, tool, setTool,
    zoomIn, zoomOut, fit,
  } = props

  return (
    <div className="ribbon-shell">
      <div className="menubar-row">
        <span className="app-name">plotplan-fit-me</span>
        <Menubar className="border-0 bg-transparent shadow-none">
          <MenubarMenu>
            <MenubarTrigger>File</MenubarTrigger>
            <MenubarContent>
              <MenubarItem onSelect={solve} disabled={solving}>
                Solve <MenubarShortcut>⏎</MenubarShortcut>
              </MenubarItem>
              <MenubarSeparator />
              <MenubarItem onSelect={fit}>Fit to view</MenubarItem>
            </MenubarContent>
          </MenubarMenu>
          <MenubarMenu>
            <MenubarTrigger>View</MenubarTrigger>
            <MenubarContent>
              <MenubarCheckboxItem checked={showGrid} onCheckedChange={setShowGrid}>
                Grid
              </MenubarCheckboxItem>
              <MenubarCheckboxItem checked={showRuler} onCheckedChange={setShowRuler}>
                Rulers
              </MenubarCheckboxItem>
              <MenubarSeparator />
              <MenubarItem onSelect={zoomIn}>Zoom in</MenubarItem>
              <MenubarItem onSelect={zoomOut}>Zoom out</MenubarItem>
              <MenubarItem onSelect={fit}>Reset zoom</MenubarItem>
            </MenubarContent>
          </MenubarMenu>
          <MenubarMenu>
            <MenubarTrigger>Help</MenubarTrigger>
            <MenubarContent>
              <MenubarItem
                onSelect={() =>
                  window.alert(
                    'plotplan-fit-me — generative plot plan tool.\nDrag equipment for a live score, or Solve to auto-lay-out.',
                  )}
              >
                <Info className="size-4" /> About
              </MenubarItem>
            </MenubarContent>
          </MenubarMenu>
        </Menubar>

        {score != null && (
          <Badge
            variant={score.feasible ? 'secondary' : 'destructive'}
            className="ml-auto self-center px-3 py-1 text-sm"
          >
            {score.feasible ? `score: ${score.cost.toFixed(0)}` : 'infeasible layout'}
          </Badge>
        )}
      </div>

      <Tabs defaultValue="home" className="ribbon-tabs gap-0">
        <TabsList className="ribbon-tablist">
          <TabsTrigger value="home">Home</TabsTrigger>
          <TabsTrigger value="view">View</TabsTrigger>
        </TabsList>

        <TabsContent value="home" className="ribbon-body">
          <Group label="Unit">
            <Select value={unitName ?? ''} onValueChange={setUnitName}>
              <SelectTrigger className="w-48"><SelectValue placeholder="Select a unit" /></SelectTrigger>
              <SelectContent>
                {units.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}
              </SelectContent>
            </Select>
          </Group>
          <Separator orientation="vertical" className="h-auto" />
          <Group label="Seeds">
            <div className="flex flex-col gap-1">
              <Label htmlFor="seeds" className="text-[11px] text-muted-foreground">n or a:b</Label>
              <Input id="seeds" value={seedsInput} onChange={(e) => setSeedsInput(e.target.value)} className="w-28" />
            </div>
          </Group>
          <Separator orientation="vertical" className="h-auto" />
          <Group label="Solve">
            <Button onClick={solve} disabled={solving} className="h-14 flex-col gap-1 px-4">
              {solving ? <Loader2 className="size-5 animate-spin" /> : <Play className="size-5" />}
              <span className="text-xs">{solving ? 'Solving…' : 'Solve'}</span>
            </Button>
          </Group>
        </TabsContent>

        <TabsContent value="view" className="ribbon-body">
          <Group label="Zoom">
            <Button variant="outline" size="icon" onClick={zoomOut} title="Zoom out"><ZoomOut /></Button>
            <Button variant="outline" size="icon" onClick={zoomIn} title="Zoom in"><ZoomIn /></Button>
            <Button variant="outline" size="icon" onClick={fit} title="Fit to view"><Maximize /></Button>
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

import { ZoomDialog } from '@/components/Ribbon'

export default function StatusBar({
  projectLabel, score, cursor, zoomPct, setZoomPercent, tool, realtimeMode, relaxOk,
}) {
  return (
    <div className="statusbar">
      <span>{projectLabel ?? '—'}</span>
      <span className="status-sep" />
      <span className={score && !score.feasible ? 'text-destructive' : ''}>
        {score == null
          ? 'no layout scored'
          : score.feasible
            ? `score ${score.cost.toFixed(0)}`
            : 'infeasible'}
      </span>
      {realtimeMode && (
        <>
          <span className="status-sep" />
          {relaxOk
            ? <span className="statusbar-realtime">⚡ Real-time</span>
            : (
              <span className="text-destructive" title="Too many overlaps for real-time to legalize — try Solve first, or drag to a more open spot">
                ⚡ Real-time — can't reflow here
              </span>
            )}
        </>
      )}
      <span className="ml-auto tabular-nums">
        {cursor ? `x ${cursor.x.toFixed(1)}  y ${cursor.y.toFixed(1)} m` : ''}
      </span>
      <span className="status-sep" />
      <span className="capitalize">{tool}</span>
      <span className="status-sep" />
      <input
        type="range" min="10" max="400" step="1" list="zoom-100"
        value={Math.min(400, Math.max(10, zoomPct))}
        onChange={(e) => setZoomPercent(Number(e.target.value))}
        className="zoom-slider" title={`${zoomPct}%`}
      />
      <datalist id="zoom-100"><option value="100" /></datalist>
      <ZoomDialog
        zoomPct={zoomPct} setZoomPercent={setZoomPercent}
        trigger={(
          <button type="button" className="tabular-nums w-10 text-right zoom-pct-btn">
            {zoomPct}%
          </button>
        )}
      />
    </div>
  )
}

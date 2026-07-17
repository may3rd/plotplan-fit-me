export default function StatusBar({ projectLabel, score, cursor, zoomPct, setZoomPercent, tool }) {
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
      <span className="ml-auto tabular-nums">
        {cursor ? `x ${cursor.x.toFixed(1)}  y ${cursor.y.toFixed(1)} m` : ''}
      </span>
      <span className="status-sep" />
      <span className="capitalize">{tool}</span>
      <span className="status-sep" />
      <input
        type="range" min="10" max="400" step="1"
        value={Math.min(400, Math.max(10, zoomPct))}
        onChange={(e) => setZoomPercent(Number(e.target.value))}
        className="zoom-slider" title={`${zoomPct}%`}
      />
      <span className="tabular-nums w-10 text-right">{zoomPct}%</span>
    </div>
  )
}

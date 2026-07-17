export default function StatusBar({ projectLabel, score, cursor, zoomPct, tool }) {
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
      <span className="tabular-nums">{zoomPct}%</span>
    </div>
  )
}

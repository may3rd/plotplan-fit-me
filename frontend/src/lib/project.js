// Pure project (save-file) helpers — assembling the inline case-study
// payload the backend's /api/score, /api/solve, /api/export/* endpoints
// expect, and building/parsing the on-disk .json project file. Kept pure
// (no fetch/DOM) so it gets a runnable check like view.js/geom.js
// (project.test.js).

export const PROJECT_FORMAT = 'plotplan-project'
export const PROJECT_VERSION = 1

/** A brand-new, empty project — used by File > New. No equipment/
 * connections yet since this app has no "add equipment" UI; New starts a
 * blank canvas the same size/shape a hand-edited or generated project
 * would use, ready for File > Open to load real content into. */
export const BLANK_PROJECT = {
  name: 'untitled',
  site: { w: 50, d: 50, racks: [], wind_dir: '' },
  equipment: [],
  connections: [],
  keepouts: {},
  spacing: [],
  wind_clearance_m: 20,
}

/** Merge live drag/solve `positions` (tag -> {x, y}) onto `data.equipment`,
 * producing the full inline case-study body the backend's /api/score,
 * /api/solve, and /api/export/* endpoints take as `{ data: ... }`. */
export function buildCaseData(data, positions) {
  const equipment = data.equipment.map((e) => {
    const p = positions[e.tag] ?? { x: e.x, y: e.y }
    return { ...e, x: p.x, y: p.y }
  })
  return {
    name: data.name ?? 'layout',
    equipment,
    connections: data.connections ?? [],
    site: data.site,
    keepouts: data.keepouts ?? {},
    spacing: data.spacing ?? [],
  }
}

/** Serialize the current project (data + live positions) to the .json
 * project-file text saved by File > Save / Save As. */
export function projectFileContents(data, positions) {
  const body = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    ...buildCaseData(data, positions),
    wind_clearance_m: data.wind_clearance_m ?? BLANK_PROJECT.wind_clearance_m,
  }
  return JSON.stringify(body, null, 2)
}

/** Parse+validate project-file text loaded by File > Open. Throws with a
 * readable message on anything that isn't at least equipment+site shaped —
 * deliberately lenient about `format`/`version` so a hand-edited or
 * unit-derived JSON (same shape as GET /api/units/{name}) still opens. */
export function parseProjectFile(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('not valid JSON')
  }
  if (!parsed || !Array.isArray(parsed.equipment) || !parsed.site) {
    throw new Error('not a plotplan project file (missing equipment/site)')
  }
  return parsed
}

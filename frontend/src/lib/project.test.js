// Runnable check for project.js. No framework: `node src/lib/project.test.js`.
import assert from 'node:assert'
import { BLANK_PROJECT, buildCaseData, projectFileContents, parseProjectFile, PROJECT_FORMAT } from './project.js'

const data = {
  name: 'sample_unit',
  equipment: [
    { tag: 'A', cls: 'pump_hc', w: 2, d: 3, x: 0, y: 0, pinned: false, pull_side: '', pull_len: 0 },
    { tag: 'B', cls: 'vessel', w: 4, d: 4, x: 10, y: 10, pinned: true, pull_side: '', pull_len: 0 },
  ],
  connections: [{ a: 'A', b: 'B', weight: 1 }],
  site: { w: 90, d: 80, wind_dir: 'x+' },
  keepouts: {
    ROAD_main: [[0, 0], [1, 0], [1, 1]],
    RACK_1: [[0, 26], [90, 26], [90, 34], [0, 34]],
  },
  spacing: [{ a: 'pump_hc', b: 'vessel', gap: 5 }],
  wind_clearance_m: 20,
}

// buildCaseData: positions override x/y, missing tag falls back to e's own x/y
const moved = buildCaseData(data, { A: { x: 5, y: 6 } })
assert.deepEqual(moved.equipment[0], { ...data.equipment[0], x: 5, y: 6 })
assert.deepEqual(moved.equipment[1], data.equipment[1]) // no override for B -> keeps its own x/y
assert.equal(moved.name, 'sample_unit')
assert.deepEqual(moved.connections, data.connections)
assert.deepEqual(moved.keepouts, data.keepouts)
assert.deepEqual(moved.spacing, data.spacing)

// buildCaseData: defaults when optional fields are absent
const minimal = buildCaseData({ equipment: [], site: { w: 1, d: 1 } }, {})
assert.equal(minimal.name, 'layout')
assert.deepEqual(minimal.connections, [])
assert.deepEqual(minimal.keepouts, {})
assert.deepEqual(minimal.spacing, [])

// projectFileContents round-trips through parseProjectFile
const text = projectFileContents(data, {})
const roundTripped = parseProjectFile(text)
assert.equal(roundTripped.format, PROJECT_FORMAT)
assert.equal(roundTripped.equipment.length, 2)
assert.equal(roundTripped.site.w, 90)
assert.equal(roundTripped.wind_clearance_m, 20)

// nozzle_dx/nozzle_dy round-trip when present on equipment (kept by the
// ...e spread in buildCaseData, no special handling)
const withNozzle = { ...data, equipment: [
  { ...data.equipment[0], nozzle_dx: 1.5, nozzle_dy: -2 },
  data.equipment[1],
] }
const nzRound = parseProjectFile(projectFileContents(withNozzle, {}))
assert.equal(nzRound.equipment[0].nozzle_dx, 1.5)
assert.equal(nzRound.equipment[0].nozzle_dy, -2)

// parseProjectFile rejects garbage and shapes missing equipment/site
assert.throws(() => parseProjectFile('not json'), /not valid JSON/)
assert.throws(() => parseProjectFile('{"foo": 1}'), /missing equipment\/site/)
assert.throws(() => parseProjectFile('{"equipment": [], "site": null}'), /missing equipment\/site/)

// BLANK_PROJECT is itself a valid project file
assert.equal(parseProjectFile(JSON.stringify(BLANK_PROJECT)).name, 'untitled')

console.log('project.test.js OK')

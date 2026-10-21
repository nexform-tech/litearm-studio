// Derives the preview model the 3D viewport loads from the fetched upstream package.
//
// Who reads this: anyone asking why `public/description/` is not byte-identical to
// `nexform-tech/litearm-description`. The upstream meshes are SolidWorks STLs totalling
// 61 MB / 1.26M triangles for a small arm — far more detail than a preview needs, and
// enough to keep the panel visibly "assembling itself" on slower machines. This script
// decimates every mesh and writes the result to `public/description/`, keeping the URDF
// and every file name untouched, so urdf-loader and the daemon need no changes.
//
// The raw package is not thrown away: `fetch-description.mjs` keeps it in
// `.cache/description/` and verifies it against `description.lock.json`. The lock still
// pins the upstream bytes; the shipped build carries the derived preview.
//
//   node scripts/build-description.mjs
//
// The output is cached: if the source ref/files and the parameters below are unchanged
// and the output files still hash the same, it exits without re-reading the 61 MB.
//
// ⚠ Keep these deterministic. The same source must produce the same bytes in CI, the
// .deb container and a Windows release build; the simplification is a WASM build of a
// pinned meshoptimizer and takes no timestamps or random seeds.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MeshoptSimplifier } from 'meshoptimizer/simplifier'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** The raw upstream package, written and hash-checked by `fetch-description.mjs`. */
const SRC = join(ROOT, '.cache', 'description')
/** What the frontend actually ships and loads. */
const OUT = join(ROOT, 'public', 'description')
const SRC_MARKER = join(SRC, '.model.json')
const OUT_MARKER = join(OUT, '.model.json')
const URDF_PATH = 'urdf/litearm_description.urdf'

/** Keep this share of the triangles, but never deviate more than `ERROR_CAP_M` metres. */
const PREVIEW_RATIO = 0.1
/** Absolute deviation cap, in metres (URDF units). 0.5 mm is invisible at preview size. */
const ERROR_CAP_M = 0.0005
/** Recorded in the marker: a tool bump invalidates the cached output. */
const TOOL = `meshoptimizer@${JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).devDependencies.meshoptimizer}`

const say = (msg) => process.stderr.write(`[preview] ${msg}\n`)
const die = (msg) => { process.stderr.write(`[preview] error: ${msg}\n`); process.exit(1) }
const sha256 = (buf) => `sha256:${createHash('sha256').update(buf).digest('hex')}`
const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null)
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** Every `meshes/...` the URDF points at, in document order. */
function meshFiles(urdf) {
  const files = []
  for (const [, filename] of urdf.matchAll(/filename="([^"]+)"/g)) {
    const path = filename.replace(/^package:\/\/[^/]+\//, '')
    if (path.startsWith('meshes/')) files.push(path)
    else die(`the URDF references "${filename}", which is not under meshes/`)
  }
  if (!files.length) die(`no meshes/ references in ${URDF_PATH}; did upstream change the package layout?`)
  return [...new Set(files)]
}

/** Relative paths of everything under `dir`, marker excluded. */
function filesUnder(dir, prefix = '') {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) return filesUnder(join(dir, entry.name), rel)
    return rel === '.model.json' ? [] : [rel]
  })
}

/** Delete whatever the preview no longer has, then the empty directories. */
function prune(kept) {
  for (const path of filesUnder(OUT)) {
    if (!kept.includes(path)) rmSync(join(OUT, path))
  }
  const dirs = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { walk(join(dir, entry.name)); dirs.push(join(dir, entry.name)) }
    }
  }
  walk(OUT)
  for (const dir of dirs) {
    try { rmdirSync(dir) } catch { /* still holds a kept file */ }
  }
}

/**
 * Binary STL -> indexed triangles (positions are deduplicated; STL repeats every shared
 * vertex once per triangle), which is what the simplifier needs.
 */
function parseStl(buf, name) {
  if (buf.length < 84) die(`${name}: too short to be a binary STL (${buf.length} bytes)`)
  const triangles = buf.readUInt32LE(80)
  if (84 + triangles * 50 !== buf.length) {
    die(`${name}: not a binary STL (${buf.length} bytes, header claims ${triangles} triangles)`)
  }
  const positions = []
  const indices = new Uint32Array(triangles * 3)
  const seen = new Map()
  let at = 0
  for (let i = 0; i < triangles; i++) {
    const base = 84 + i * 50 + 12
    for (let v = 0; v < 3; v++) {
      const p = base + v * 12
      const x = buf.readFloatLE(p)
      const y = buf.readFloatLE(p + 4)
      const z = buf.readFloatLE(p + 8)
      const key = `${x}|${y}|${z}`
      let id = seen.get(key)
      if (id === undefined) {
        id = positions.length / 3
        positions.push(x, y, z)
        seen.set(key, id)
      }
      indices[at++] = id
    }
  }
  return { triangles, positions: new Float32Array(positions), indices }
}

/** Binary STL with one normal per face, recomputed from the simplified triangles. */
function writeStl(name, positions, indices) {
  const triangles = indices.length / 3
  const out = Buffer.alloc(84 + triangles * 50)
  out.write(`LiteArm Studio preview (${TOOL})`, 0)
  out.writeUInt32LE(triangles, 80)
  for (let i = 0; i < triangles; i++) {
    const a = indices[i * 3]
    const b = indices[i * 3 + 1]
    const c = indices[i * 3 + 2]
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2]
    const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2]
    const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2]
    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const length = Math.hypot(nx, ny, nz)
    if (length > 0) { nx /= length; ny /= length; nz /= length }
    const o = 84 + i * 50
    out.writeFloatLE(nx, o)
    out.writeFloatLE(ny, o + 4)
    out.writeFloatLE(nz, o + 8)
    const vertices = [ax, ay, az, bx, by, bz, cx, cy, cz]
    for (let k = 0; k < 9; k++) out.writeFloatLE(vertices[k], o + 12 + k * 4)
  }
  return out
}

function simplify(buf, name) {
  const { triangles, positions, indices } = parseStl(buf, name)
  const target = Math.max(3, Math.floor((indices.length * PREVIEW_RATIO) / 3) * 3)
  const [simplified, error] = MeshoptSimplifier.simplify(
    indices,
    positions,
    3,
    target,
    ERROR_CAP_M,
    ['ErrorAbsolute'],
  )
  return {
    stl: writeStl(name, positions, simplified),
    before: triangles,
    after: simplified.length / 3,
    error,
  }
}

async function main() {
  const source = readJson(SRC_MARKER)
  if (!source) die(`no fetched model at ${SRC} — run \`node scripts/fetch-description.mjs\` first`)

  const urdf = readFileSync(join(SRC, URDF_PATH))
  const meshes = meshFiles(urdf.toString('utf8'))
  const expectedPaths = [URDF_PATH, ...meshes]

  // ---- already derived? -----------------------------------------
  const marker = readJson(OUT_MARKER)
  const upToDate =
    marker &&
    marker.ref === source.ref &&
    same(marker.sourceFiles, source.files) &&
    marker.preview?.ratio === PREVIEW_RATIO &&
    marker.preview?.errorCapM === ERROR_CAP_M &&
    marker.preview?.tool === TOOL &&
    same(filesUnder(OUT).sort(), [...expectedPaths].sort()) &&
    expectedPaths.every((path) => {
      const full = join(OUT, path)
      return existsSync(full) && marker.files?.[path] === sha256(readFileSync(full))
    })
  if (upToDate) {
    say(`${source.ref} preview is up to date (${mb(Object.values(marker.bytes).reduce((a, b) => a + b, 0))})`)
    return
  }

  // ---- derive ---------------------------------------------------
  if (!MeshoptSimplifier.supported) die('this meshoptimizer build does not support simplification')
  await MeshoptSimplifier.ready

  mkdirSync(dirname(join(OUT, URDF_PATH)), { recursive: true })
  writeFileSync(join(OUT, URDF_PATH), urdf)

  const files = { [URDF_PATH]: sha256(urdf) }
  const bytes = { [URDF_PATH]: urdf.length }
  let beforeTotal = 0
  let afterTotal = 0
  let trianglesBefore = 0
  let trianglesAfter = 0
  for (const path of meshes) {
    const raw = readFileSync(join(SRC, path))
    const result = simplify(raw, path)
    mkdirSync(dirname(join(OUT, path)), { recursive: true })
    writeFileSync(join(OUT, path), result.stl)
    files[path] = sha256(result.stl)
    bytes[path] = result.stl.length
    beforeTotal += raw.length
    afterTotal += result.stl.length
    trianglesBefore += result.before
    trianglesAfter += result.after
    say(
      `${path} ${result.before} -> ${result.after} tris ` +
      `(${(result.error * 1000).toFixed(2)} mm, ${mb(raw.length)} -> ${mb(result.stl.length)})`,
    )
  }

  // Upstream dropped meshes must not linger: they ship in `dist/` and stay reachable.
  prune(Object.keys(files))
  writeFileSync(
    OUT_MARKER,
    `${JSON.stringify({
      ref: source.ref,
      repo: source.repo,
      path: source.path,
      source: source.source,
      files,
      bytes,
      sourceFiles: source.files,
      preview: { ratio: PREVIEW_RATIO, errorCapM: ERROR_CAP_M, tool: TOOL },
    }, null, 2)}\n`,
  )
  say(
    `${source.ref}: ${trianglesBefore} -> ${trianglesAfter} tris, ` +
    `${mb(beforeTotal)} -> ${mb(afterTotal)}`,
  )
}

main().catch((error) => die(error.stack || String(error)))

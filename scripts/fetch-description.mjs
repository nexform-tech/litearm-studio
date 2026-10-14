// Materialises the robot model (URDF + meshes) that the 3D viewport serves.
//
// Who reads this: anyone asking where `public/description/` comes from. It is **not in
// git** — this script produces it, and `pnpm dev` / `pnpm build` / `pnpm test` all run it
// first. The model belongs to another repository we do not own:
//
//     https://github.com/nexform-tech/litearm-description    (package SE/litearm_description)
//
// Two modes, and the difference is the whole point:
//
//   track (default)  resolve the newest upstream tag, use it, and rewrite
//                    `description.lock.json` when it moved. Local builds follow upstream,
//                    so a model change is seen by whoever builds next rather than by
//                    whoever remembers to bump something.
//   locked           (`--locked`, or LITEARM_DESCRIPTION_MODE=locked) use the ref the lock
//                    file pins, and refuse to continue if the bytes do not match its
//                    hashes. `make deb` and the release workflow run this way: same tree,
//                    same package. The lock pins **content**, not just a ref name, because
//                    upstream can move a tag.
//
//   node scripts/fetch-description.mjs                # newest tag, update the lock
//   node scripts/fetch-description.mjs --locked       # exactly what the lock pins
//   node scripts/fetch-description.mjs --ref v2.0.0   # one specific ref, lock untouched
//
// Environment: LITEARM_DESCRIPTION_REF, LITEARM_DESCRIPTION_MODE (track|locked),
// LITEARM_DESCRIPTION_REPO, LITEARM_DESCRIPTION_QUIET, and the three a mirror needs —
// LITEARM_DESCRIPTION_GIT_URL (the tag list), LITEARM_DESCRIPTION_BASE_URL (the files).
//
// ⚠ The meshes are fetched **in parallel**. Measured from the maintainer's network, one
// stream to raw.githubusercontent.com runs at ~0.3 MB/s (3.5 minutes for the 63 MB model)
// while ten reach ~2.4 MB/s. Do not turn this into a sequential loop.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public', 'description')
const LOCK_PATH = join(ROOT, 'description.lock.json')
const MARKER = join(OUT, '.model.json')

const REPO = process.env.LITEARM_DESCRIPTION_REPO || 'nexform-tech/litearm-description'
/** The package inside the upstream repository holding this arm's model. */
const PACKAGE_DIR = 'SE/litearm_description'
const URDF_PATH = 'urdf/litearm_description.urdf'
const BASE_URL = (process.env.LITEARM_DESCRIPTION_BASE_URL || `https://raw.githubusercontent.com/${REPO}`).replace(/\/+$/, '')
/** Where the tag list comes from. Separate from BASE_URL so both can point at a mirror. */
const GIT_URL = process.env.LITEARM_DESCRIPTION_GIT_URL || `https://github.com/${REPO}.git`

const LOCKED = process.argv.includes('--locked') || process.env.LITEARM_DESCRIPTION_MODE === 'locked'
const QUIET = process.argv.includes('--quiet') || process.env.LITEARM_DESCRIPTION_QUIET === '1'
const say = (msg) => { if (!QUIET) process.stderr.write(`[description] ${msg}\n`) }
const warn = (msg) => process.stderr.write(`[description] ${msg}\n`)
const die = (msg) => { process.stderr.write(`[description] error: ${msg}\n`); process.exit(1) }
/** The one line worth showing from whatever was thrown: git puts the cause in stderr. */
const reason = (error) => {
  const lines = String(error?.stderr || error?.message || error).trim().split('\n').filter((line) => line.trim())
  return lines.at(-1) ?? String(error)
}

const flagValue = (name) => {
  const i = process.argv.indexOf(name)
  if (i === -1) return undefined
  const value = process.argv[i + 1]
  if (!value || value.startsWith('--')) die(`${name} needs a value`)
  return value
}
const REQUESTED_REF = flagValue('--ref') || process.env.LITEARM_DESCRIPTION_REF || ''

const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null)
const sha256 = (buf) => `sha256:${createHash('sha256').update(buf).digest('hex')}`
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** The newest `v<major>.<minor>.<patch>` upstream has tagged. */
async function newestTag() {
  const { stdout } = await run('git', ['ls-remote', '--tags', '--refs', GIT_URL], {
    timeout: 30_000,
    // A build step has no terminal to answer a credential prompt on: without this, a typo
    // in the repo name (or a private repo) makes git wait on /dev/tty instead of failing.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    // Windows: a console window flashing up in the middle of a build (the release workflow
    // builds on windows-latest, and this is the same complaint fd2e87a fixed).
    windowsHide: true,
  })
  const versions = stdout
    .split('\n')
    .map((line) => /^refs\/tags\/v?(\d+)\.(\d+)\.(\d+)$/.exec(line.split('\t')[1] ?? ''))
    .filter(Boolean)
    .map(([, major, minor, patch]) => ({ ref: `v${major}.${minor}.${patch}`, parts: [+major, +minor, +patch] }))
    .sort((a, b) => a.parts[0] - b.parts[0] || a.parts[1] - b.parts[1] || a.parts[2] - b.parts[2])
  if (!versions.length) throw new Error(`no version tags in https://github.com/${REPO}`)
  return versions.at(-1).ref
}

/** Every `meshes/...` the URDF's visuals and collisions point at, in document order. */
function meshFiles(urdf) {
  const files = new Set()
  for (const [, filename] of urdf.matchAll(/filename="([^"]+)"/g)) {
    const path = filename.replace(/^package:\/\/[^/]+\//, '')
    if (path.startsWith('meshes/')) files.add(path)
    else warn(`the URDF references "${filename}", which is not under meshes/ — skipped`)
  }
  if (!files.size) die(`no meshes/ references in ${URDF_PATH}; did upstream change the layout of the package?`)
  return [...files]
}

/**
 * One file, retried once. Ten parallel streams over a home connection drop one of them often
 * enough that losing the other nine (63 MB again) is not worth the purity of a single try.
 */
async function download(path, ref, attempt = 1) {
  const url = `${BASE_URL}/${ref}/${PACKAGE_DIR}/${path}`
  try {
    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`)
    const body = Buffer.from(await response.arrayBuffer())
    say(`  ↓ ${path} (${mb(body.length)})`)
    return body
  } catch (error) {
    if (attempt > 1) throw error
    await new Promise((resume) => setTimeout(resume, 500))
    return download(path, ref, attempt + 1)
  }
}

/** Relative paths of everything under `dir`, forward-slashed, marker excluded. */
function filesUnder(dir, prefix = '') {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) return filesUnder(join(dir, entry.name), rel)
    return rel === '.model.json' ? [] : [rel]
  })
}

/** What is on disk for `path` (relative to OUT), or null when it is not there at all. */
function localCopy(path) {
  const full = join(OUT, path)
  if (!existsSync(full)) return null
  const body = readFileSync(full)
  return { digest: sha256(body), bytes: body.length }
}

/** True when every path in `expected` (relative -> `sha256:...`) is on disk with that hash. */
function matches(expected) {
  return Object.entries(expected).every(([path, digest]) => localCopy(path)?.digest === digest)
}

/** Delete whatever the ref we just materialised does not have, then the empty directories. */
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

const total = (bytes) => Object.values(bytes).reduce((sum, n) => sum + n, 0)
const summary = (files, bytes) => `${Object.keys(files).length} files, ${mb(total(bytes))}`

/**
 * What is on disk, where it came from, and how big each file is. Served at
 * `/description/.model.json`: it is the only way to tell which model a built package carries,
 * and the sizes are what let a later run report a byte delta instead of a new total.
 */
function writeMarker(ref, files, bytes) {
  writeFileSync(MARKER, `${JSON.stringify({ ref, repo: REPO, path: PACKAGE_DIR, source: BASE_URL, files, bytes }, null, 2)}\n`)
}

async function main() {
  const lock = readJson(LOCK_PATH)
  const marker = readJson(MARKER)

  // ---- which ref ------------------------------------------------
  let ref = REQUESTED_REF
  if (!ref && LOCKED) {
    if (!lock) die('--locked needs a description.lock.json to pin; run once without it to create one')
    ref = lock.ref
  }
  const tracking = !ref && !LOCKED
  if (tracking) {
    try {
      ref = await newestTag()
    } catch (error) {
      // No network (or no git). Still fine, as long as the lock's bytes are already here.
      if (lock && matches(lock.files)) {
        warn(`cannot reach ${REPO} (${reason(error)}) — using the locked ${lock.ref}`)
        return
      }
      die(`cannot reach ${REPO} and nothing usable is on disk: ${reason(error)}\n       a first build needs network access`)
    }
  }
  if (LOCKED && REQUESTED_REF && lock?.ref !== REQUESTED_REF) {
    die(`--locked pins ${lock?.ref ?? 'nothing'}, so --ref ${REQUESTED_REF} contradicts it; drop --locked to use another ref`)
  }

  // What this ref must hash to, when something already records it.
  const pinned = lock?.ref === ref ? lock.files : null
  const expected = pinned ?? (marker?.ref === ref ? marker.files : null)

  // ---- already materialised? ------------------------------------
  if (expected && matches(expected) && filesUnder(OUT).length === Object.keys(expected).length) {
    say(`${ref} is already in place (${Object.keys(expected).length} files)`)
    // The bytes are right, but the marker can still name an older ref: it is written after
    // the files, so an interrupted run — or a build from an older checkout — leaves it
    // behind. It ships at `/description/.model.json`, where a stale one misreports which
    // model the package contains.
    if (marker?.ref !== ref) {
      writeMarker(ref, expected, Object.fromEntries(Object.entries(expected).map(([path]) => [path, localCopy(path).bytes])))
    }
    return
  }

  // ---- fetch ----------------------------------------------------
  say(`fetching ${ref} from ${BASE_URL}/${PACKAGE_DIR}`)
  let files
  let bytes
  try {
    // The URDF is always fetched: it is 12 KB, and it is what says which meshes this model
    // needs. The meshes are fetched only when their bytes are not already right — on a slow
    // link, "one file was wrong" must not cost another 63 MB.
    const urdf = await download(URDF_PATH, ref)
    const meshes = meshFiles(urdf.toString('utf8'))
    // ⚠ `localCopy(path)?.digest !== expected?.[path]` is **not** this test: with no record
    // for the path both sides are `undefined`, so a file that is not on disk at all looks
    // like a match and is never fetched (it then crashes the loop below, far from the cause).
    const stale = meshes.filter((path) => {
      const copy = localCopy(path)
      return !copy || copy.digest !== expected?.[path]
    })
    const bodies = await Promise.all(stale.map((path) => download(path, ref)))

    files = { [URDF_PATH]: sha256(urdf) }
    bytes = { [URDF_PATH]: urdf.length }
    mkdirSync(dirname(join(OUT, URDF_PATH)), { recursive: true })
    writeFileSync(join(OUT, URDF_PATH), urdf)
    for (const [i, path] of stale.entries()) {
      mkdirSync(dirname(join(OUT, path)), { recursive: true })
      writeFileSync(join(OUT, path), bodies[i])
      files[path] = sha256(bodies[i])
      bytes[path] = bodies[i].length
    }
    for (const path of meshes) {
      if (files[path]) continue
      const kept = localCopy(path)
      files[path] = kept.digest
      bytes[path] = kept.bytes
    }
    prune(Object.keys(files)) // a mirror, not an overlay: names upstream dropped must go
  } catch (error) {
    // Nothing has been written yet (every body is downloaded before the first write), so a
    // failed fetch leaves the previous model intact. Use it: a build that has a complete,
    // hash-verified model on disk should not fail because upstream moved and the download
    // died halfway — that is exactly what a slow or flaky link does.
    const fallback = [pinned, lock?.files, marker?.files]
      .find((record) => record && matches(record) && filesUnder(OUT).length === Object.keys(record).length)
    if (fallback) {
      warn(`cannot fetch ${ref} (${reason(error)}) — continuing with the model already on disk`)
      return
    }
    die(`cannot fetch ${ref}: ${reason(error)}\n       nothing usable is on disk either; a first build needs network access`)
  }

  // ---- verify, then record --------------------------------------
  const moved = pinned ? Object.keys(pinned).filter((path) => files[path] !== pinned[path]) : []
  if (moved.length && LOCKED) {
    die(`upstream moved ${ref}: ${moved.join(', ')}\n       the lock pins different bytes; review upstream, then refresh it with \`node scripts/fetch-description.mjs\``)
  }

  writeMarker(ref, files, bytes)
  if (moved.length) warn(`⚠ upstream moved ${ref} since the lock was written: ${moved.join(', ')}`)
  else if (marker?.ref && marker.ref !== ref) {
    const before = Object.keys(marker.files)
    const after = Object.keys(files)
    const changed = after.filter((path) => before.includes(path) && marker.files[path] !== files[path])
    const added = after.filter((path) => !before.includes(path))
    const removed = before.filter((path) => !after.includes(path))
    say(`model ${marker.ref} -> ${ref}: ${[...changed, ...added.map((p) => `${p} (new)`), ...removed.map((p) => `${p} (gone)`)].join(', ') || 'no file changed'}`)
    // The delta only means something when the previous run recorded its sizes too.
    const was = marker.bytes ? `${mb(total(marker.bytes))} -> ` : ''
    say(`  ${was}${mb(total(bytes))}`)
  }

  if (tracking && ref !== lock?.ref) {
    writeFileSync(LOCK_PATH, `${JSON.stringify({ ref, repo: REPO, path: PACKAGE_DIR, files }, null, 2)}\n`)
    say(`pinned ${lock?.ref ? `${lock.ref} -> ${ref}` : ref} (${summary(files, bytes)})`)
    say('commit description.lock.json so release builds pin the same model')
  } else {
    say(`${ref} in place (${summary(files, bytes)})`)
  }
}

main().catch((error) => die(error.stack || String(error)))

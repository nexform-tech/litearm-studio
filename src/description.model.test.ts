/**
 * What this file pins: the model the build fetched is one this application knows how to
 * drive — every mesh it references is on disk, and its joints and links carry the names
 * `RobotViewport` sets positions on and hangs the end-effector axes from.
 *
 * Why it exists: the model is **not in git**. It is fetched at build time from another
 * repository we do not own (`nexform-tech/litearm-description`), and a local build follows
 * that repository's newest tag automatically. Nothing else stands between an upstream
 * rename and a shipped 3D panel that draws the ground plane and no arm — which is exactly
 * what issue #150 looked like. `description.lock.json` pins the bytes for release builds;
 * this pins the *meaning* of those bytes.
 *
 * ⚠ It fails, and does not skip, when the model is absent: a skipped guard is not a guard.
 * `pnpm test` fetches the model first (package.json), so that failure means someone ran
 * vitest directly on a machine that never built, or a fetch was interrupted.
 */
/// <reference types="node" />
// 上面这一行是这个文件对 node 类型的一次**逐文件**订阅: 应用的 tsconfig 只放行
// `vite/client` (src/ 是浏览器代码, 不该随手 import node 内建)。这里要读磁盘, 所以单独声明。
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { END_EFFECTOR_LINK, JOINT_NAMES, MODEL_DIR, MODEL_PATH } from './components/robotModel'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const URDF = join(ROOT, 'public', MODEL_PATH)
/** Where `loader.packages` sends every `package://` name, so where the meshes must be. */
const MESH_ROOT = join(ROOT, 'public', MODEL_DIR)

function loadModel() {
  if (!existsSync(URDF)) {
    throw new Error(
      `${MODEL_PATH} is not there. The robot model is fetched at build time, not committed — ` +
        'run `node scripts/fetch-description.mjs` (or `pnpm build`, which does it first).',
    )
  }
  return readFileSync(URDF, 'utf8')
}

/** `name` of every `<tag ...>` in `xml`, in document order. Attribute order does not matter. */
function tagNames(xml: string, tag: string) {
  return [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'g'))]
    .map(([element]) => /\bname="([^"]+)"/.exec(element)?.[1])
    .filter((name): name is string => Boolean(name))
}

/** Every `package://<pkg>/<path>` a visual or collision points at, resolved against MESH_ROOT. */
function meshFiles(xml: string) {
  return [...xml.matchAll(/filename="package:\/\/[^/]+\/([^"]+)"/g)].map(([, path]) => path)
}

it('drives exactly the joints the model has, in the order it declares them', () => {
  const model = loadModel()
  const joints = [...model.matchAll(/<joint\b[^>]*>/g)]
    .filter(([element]) => /\btype="revolute"/.test(element))
    .map(([element]) => /\bname="([^"]+)"/.exec(element)?.[1])

  expect(joints).toEqual([...JOINT_NAMES])
})

it('hangs the end-effector axes on a link that exists', () => {
  const links = tagNames(loadModel(), 'link')

  expect(links).toContain('base_link') // the viewport looks this one up too
  expect(links).toContain(END_EFFECTOR_LINK)
})

it('references only meshes that are on disk, and leaves no others behind', () => {
  const meshes = meshFiles(loadModel())

  expect(meshes.length).toBeGreaterThan(0)
  expect(meshes.filter((path) => !existsSync(join(MESH_ROOT, path)))).toEqual([])

  // The other direction, because the fetch is a mirror: a model that changed what its links
  // are named leaves the old meshes here otherwise, and they ship in `dist/` and stay
  // reachable at their old URLs.
  const referenced = new Set(meshes.map((path) => path.replace(/^meshes\//, '')))
  const onDisk = readdirSync(join(MESH_ROOT, 'meshes'))
  expect(onDisk.filter((name) => !referenced.has(name))).toEqual([])
})

it('has the bytes the lock pins, not just the file names', () => {
  const lock = JSON.parse(readFileSync(join(ROOT, 'description.lock.json'), 'utf8')) as {
    files: Record<string, string>
  }
  const digest = `sha256:${createHash('sha256').update(readFileSync(URDF)).digest('hex')}`

  // Only the URDF: it is 12 KB. The meshes are 60 MB, and the fetch hashes all ten on every
  // run anyway — this test is for someone running vitest directly, with no fetch in front.
  expect(digest).toBe(lock.files[MODEL_PATH.slice(MODEL_DIR.length)])
})

it('pins exactly the files the model needs in the lock file', () => {
  const lock = JSON.parse(readFileSync(join(ROOT, 'description.lock.json'), 'utf8')) as {
    ref: string
    files: Record<string, string>
  }
  const pinned = Object.keys(lock.files)
  // The lock speaks the upstream package's paths; the model is a copy of that package.
  const needed = [MODEL_PATH.slice(MODEL_DIR.length), ...meshFiles(loadModel())]

  // Both directions, because either gap is silent: a file the model needs but the lock does
  // not cover is never hash-checked on fetch, and a lock entry nothing references is a pin
  // that has quietly stopped pinning anything.
  expect(needed.filter((path) => !pinned.includes(path))).toEqual([])
  expect(pinned.filter((path) => !needed.includes(path))).toEqual([])
  expect(lock.ref).toMatch(/^v?\d+\.\d+\.\d+$/)
})

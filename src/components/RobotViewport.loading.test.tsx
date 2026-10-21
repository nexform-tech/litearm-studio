/**
 * What this file pins: the viewport fits the camera to the arm when the **loader** says
 * every mesh has finished — never after a fixed stretch of time without progress.
 *
 * The bug it guards against (customer report after v0.24.0): the model is nine STLs
 * totaling ~61 MB, one per link, and they arrive asynchronously. The old code gave up
 * waiting after ~2 s without a new mesh and framed whatever had arrived. The camera sat
 * on the **partial** model's bounding box; the links that arrived afterwards ended up
 * outside the view — "only part of the joints are shown". Loading slowly is not the same
 * as loading failing, so completion has to come from the loader itself.
 *
 * The fake loader mirrors the real item accounting: one URDF item, then one item per
 * mesh started during parse, each mesh attached before its item ends. A mesh that fails
 * still ends its item (three calls `itemError` then `itemEnd`), which is what lets the
 * viewport frame the rest instead of waiting forever.
 */
import { render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as THREE from 'three'

interface Manager {
  itemStart: (url: string) => void
  itemEnd: (url: string) => void
  itemError: (url: string) => void
}

const { state } = vi.hoisted(() => ({
  state: {
    manager: null as Manager | null,
    robot: null as unknown,
    meshUrls: [] as string[],
  },
}))

vi.mock('urdf-loader', () => {
  class URDFLoader {
    packages: unknown = ''
    workingPath = ''
    private manager: Manager
    constructor(manager?: Manager) {
      // The whole point of the fix: completion comes from the loader's manager.
      if (!manager) throw new Error('RobotViewport must give URDFLoader a LoadingManager')
      this.manager = manager
      state.manager = manager
    }
    load(url: string, onComplete: (robot: unknown) => void) {
      // The real loader starts the URDF item before the fetch, starts one item per
      // mesh inside parse(), calls onComplete, then ends the URDF item.
      this.manager.itemStart(url)
      for (const meshUrl of state.meshUrls) this.manager.itemStart(meshUrl)
      onComplete(state.robot)
      this.manager.itemEnd(url)
    }
  }
  return { default: URDFLoader }
})

// jsdom has neither WebGL nor a GPU; everything else in three.js is real.
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>()
  class WebGLRenderer {
    domElement = document.createElement('canvas')
    setSize() {}
    setPixelRatio() {}
    render() {}
    dispose() {}
  }
  return { ...actual, WebGLRenderer }
})

import { RobotViewport } from './RobotViewport'

/** A robot shaped like the URDF's: one URDFVisual per link, meshes attached later. */
function makeRobot(meshCount: number) {
  const robot = new THREE.Group()
  robot.name = 'litearm_description'
  for (let i = 0; i < meshCount; i++) {
    const visual = new THREE.Group()
    ;(visual as THREE.Object3D & { isURDFVisual?: boolean }).isURDFVisual = true
    visual.name = `visual${i}`
    robot.add(visual)
  }
  return robot
}

/** Attach link `i`'s mesh at x, so framing recentres the robot. */
function attachMesh(robot: THREE.Object3D, i: number, x = 1) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshBasicMaterial())
  mesh.position.set(x, 0, 0)
  robot.children[i].add(mesh)
}

function stubCanvasContext() {
  const ctx = {
    font: '',
    textAlign: '',
    textBaseline: '',
    strokeStyle: '',
    lineWidth: 0,
    fillStyle: '',
    strokeText: vi.fn(),
    fillText: vi.fn(),
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((
    type: string,
  ) => (type === '2d' ? ctx : {})) as never)
}

beforeEach(() => {
  state.manager = null
  state.meshUrls = Array.from({ length: 9 }, (_, i) => `mesh-${i}.STL`)
  state.robot = makeRobot(state.meshUrls.length)

  // `isWebGLAvailable()` probes a bare context; the renderer itself is mocked.
  ;(window as unknown as { WebGLRenderingContext: unknown }).WebGLRenderingContext =
    function WebGLRenderingContext() {}
  stubCanvasContext()
  globalThis.ResizeObserver =
    class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('frames only after the last mesh: a slow load is not a partial model', async () => {
  render(<RobotViewport />)
  const manager = state.manager!
  const robot = state.robot as THREE.Object3D
  expect(manager).not.toBeNull()

  // Eight of nine meshes arrive and end their items; one is still in flight.
  for (let i = 0; i < 8; i++) {
    attachMesh(robot, i)
    manager.itemEnd(state.meshUrls[i])
  }
  expect(robot.position.x).toBe(0)

  // The old heuristic would have framed the eight-mesh model by now.
  await vi.advanceTimersByTimeAsync(10_000)
  expect(robot.position.x).toBe(0)

  // The last mesh completes the model — now, and only now, the camera is fitted.
  attachMesh(robot, 8)
  manager.itemEnd(state.meshUrls[8])
  expect(robot.position.x).toBeCloseTo(-1)
  expect(robot.position.y).toBeCloseTo(0.05)
})

it('frames what did load when a mesh fails instead of waiting forever', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  render(<RobotViewport />)
  const manager = state.manager!
  const robot = state.robot as THREE.Object3D

  for (let i = 0; i < 8; i++) {
    attachMesh(robot, i)
    manager.itemEnd(state.meshUrls[i])
  }

  // three's FileLoader reports a failure as itemError + itemEnd; the item still ends.
  manager.itemError(state.meshUrls[8])
  manager.itemEnd(state.meshUrls[8])

  expect(robot.position.x).toBeCloseTo(-1)
  expect(error).toHaveBeenCalledWith(expect.stringContaining('1 mesh(es) failed to load'))
  expect(error).toHaveBeenCalledWith(expect.stringContaining('mesh-8.STL'))
})

it('frames a stalled load at the watchdog, then reframes when the last mesh arrives', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  render(<RobotViewport />)
  const manager = state.manager!
  const robot = state.robot as THREE.Object3D

  for (let i = 0; i < 8; i++) {
    attachMesh(robot, i)
    manager.itemEnd(state.meshUrls[i])
  }

  // A request that neither succeeds nor fails keeps one item pending. The 2 s
  // heuristic is gone; there is no frame on the partial model at that scale.
  await vi.advanceTimersByTimeAsync(29_000)
  expect(robot.position.x).toBe(0)

  // The watchdog is generous enough not to mistake a slow cold start for a hang.
  await vi.advanceTimersByTimeAsync(2_000)
  expect(robot.position.x).toBeCloseTo(-1)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('framing after 30 s'))
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('mesh-8.STL'))

  // The hung request finally completes: the model is complete, so fit it again
  // instead of leaving the camera on the partial envelope.
  attachMesh(robot, 8, 3)
  manager.itemEnd(state.meshUrls[8])
  expect(robot.position.x).toBeCloseTo(-2)
})

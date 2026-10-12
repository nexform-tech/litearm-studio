/**
 * What this file pins: the bundled model's `package://` meshes resolve to the bundled
 * `description/` directory **whatever package name the URDF declares**.
 *
 * The bug it guards against (issue #150): `loader.packages` was a name → path map
 * (`{ litearm_description: '/description' }`), a second copy of a name the URDF already
 * carries. #126 renamed the package from `litearm_urdf` to `litearm_description`; a
 * webview whose disk cache still held the pre-#126 URDF resolved every mesh to `null`,
 * so the panel drew the ground plane and the base axes and no arm at all. The daemon now
 * makes the model revalidate instead of reusing it from cache, which is the real fix;
 * this file pins the half that keeps a stale template renderable.
 *
 * Read this before turning `packages` back into a map, or before moving the bundled
 * description to another path.
 */
import { render } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

// `vi.mock` factories are hoisted above the imports, so the record has to be hoisted too.
const { loads } = vi.hoisted(() => ({
  loads: [] as { url: string; packages: unknown; workingPath: string }[],
}))

vi.mock('urdf-loader', () => {
  class URDFLoader {
    packages: unknown = ''
    workingPath = ''
    load(url: string) {
      loads.push({ url, packages: this.packages, workingPath: this.workingPath })
    }
  }
  return { default: URDFLoader }
})

// jsdom has neither WebGL nor a GPU, so the renderer is the one piece of three.js that
// cannot be real here. Everything else (scene, camera, OrbitControls) stays real: the
// point of the test is what the load call receives, and it is only reached if the
// component gets that far without failing.
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

beforeEach(() => {
  loads.length = 0
  // `isWebGLAvailable()` requires `window.WebGLRenderingContext` *and* a truthy context.
  ;(window as unknown as { WebGLRenderingContext: unknown }).WebGLRenderingContext =
    function WebGLRenderingContext() {}
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as never)
  globalThis.ResizeObserver =
    class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})

it('resolves the bundled meshes whatever package name the URDF declares', () => {
  render(<RobotViewport />)

  // The premise: the component really did hand the bundled model to the loader.
  expect(loads).toHaveLength(1)
  expect(loads[0].url).toBe('/description/litearm.urdf')
  expect(loads[0].workingPath).toBe('/description/')

  // The name the bundled URDF carries today, and the one a pre-#126 template carries.
  const resolve = loads[0].packages as (pkg: string) => string
  expect(typeof resolve).toBe('function')
  expect(resolve('litearm_description')).toBe('/description')
  expect(resolve('litearm_urdf')).toBe('/description')
})

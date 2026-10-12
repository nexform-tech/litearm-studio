/**
 * What this file pins: a viewport that cannot create its renderer must degrade to a
 * message **inside its own panel**, and never take the page down with it.
 *
 * The bug it guards against: `isWebGLAvailable()` probes a bare `getContext('webgl')`,
 * and the real `new THREE.WebGLRenderer({ antialias: true, alpha: true })` right after it
 * asks for a stricter context. A machine can pass the probe and still fail to create the
 * renderer. The throw then escapes the effect, and React hands it to the nearest error
 * boundary — which replaces the entire console with "页面渲染遇到异常", so the operator
 * loses the arm controls over a viewport they were not using. Reported on a real Ubuntu
 * desktop, where the packaged application was unusable.
 *
 * Read this before changing how the renderer is created, or before removing the
 * `try`/`catch` around it as dead code.
 */
import { render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import i18n from '@/i18n'

// `vi.mock` factories are hoisted above the imports, so the spy has to be hoisted too.
const { constructedRenderers } = vi.hoisted(() => ({ constructedRenderers: vi.fn() }))

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>()
  return {
    ...actual,
    WebGLRenderer: class {
      constructor(...args: unknown[]) {
        constructedRenderers(...args)
        throw new Error('Error creating WebGL context.')
      }
    },
  }
})

import { RobotViewport } from './RobotViewport'

beforeEach(() => {
  constructedRenderers.mockClear()
  // jsdom ships no WebGL at all, so both halves of the check have to be faked to reach
  // the renderer at all: `isWebGLAvailable()` requires `window.WebGLRenderingContext`
  // *and* a truthy context.
  ;(window as unknown as { WebGLRenderingContext: unknown }).WebGLRenderingContext =
    function WebGLRenderingContext() {}
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as never)
})

it('keeps the page alive when the renderer cannot be created', () => {
  // The premise of the test: we really did get as far as creating a renderer, and it
  // really did throw. Without this, a future change could make the test pass by never
  // reaching the renderer at all.
  expect(() => render(<RobotViewport />)).not.toThrow()
  expect(constructedRenderers).toHaveBeenCalled()

  // The viewport says what is wrong, in its own panel.
  // 词条而不是写死的中文：jsdom 的 navigator 语言决定这里的默认语言，写死会在英文环境下翻车。
  expect(screen.getByText(i18n.t('common:render.webglContextFailed'))).toBeTruthy()
})

it('still reports a missing WebGL context as a message, not a crash', () => {
  ;(window as unknown as { WebGLRenderingContext: unknown }).WebGLRenderingContext =
    undefined

  expect(() => render(<RobotViewport />)).not.toThrow()
  expect(constructedRenderers).not.toHaveBeenCalled()
  expect(screen.getByText(i18n.t('common:render.webglUnsupported'))).toBeTruthy()
})

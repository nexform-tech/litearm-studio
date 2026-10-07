import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'

const mocks = vi.hoisted(() => ({ listDir: vi.fn() }))

vi.mock('@/lib/arm/gripperClient', () => ({
  gripperClient: { listDir: mocks.listDir },
  hasCandidate: (e: { type?: string; valid?: unknown }) =>
    e.type === 'file' && typeof e.valid === 'boolean',
}))

const { useGripperBrowse, dirOf } = await import('./useGripperBrowse')
const { formatArmError } = await import('@/lib/arm/errors')

const FILE = {
  name: 'can0_calibration.json',
  path: '/home/u/.litegrip/can0_calibration.json',
  type: 'file',
  readable: true,
  symlink: false,
  size: 210,
  mtime: 1,
  source: 'measured',
  provenance: 'user_file',
  template: null,
  channel: 'can0',
  valid: true,
  problems: [],
  warnings: [],
  closedRad: 1.7,
  openRad: -0.06,
  fileRadToMm: 46.7,
  mount: 'normal',
} as const

function listing(path: string, parent: string | null, ...entries: unknown[]) {
  return { path, parent, truncated: false, entries }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('dirOf', () => {
  it('takes the parent directory, or gives up when there is none', () => {
    expect(dirOf('/home/u/a.json')).toBe('/home/u')
    expect(dirOf('/a.json')).toBeUndefined() // 根下一层：没有可用的上级
    expect(dirOf('a.json')).toBeUndefined()
    expect(dirOf('')).toBeUndefined()
    expect(dirOf('  /tmp/  ')).toBe('/tmp')
  })
})

describe('useGripperBrowse', () => {
  it('lists the home directory when opened without an initial path', async () => {
    mocks.listDir.mockResolvedValue(listing('/home/u', '/home', FILE))
    const { result, rerender } = renderHook(
      ({ open, initialPath }) => useGripperBrowse(open, initialPath),
      { initialProps: { open: false as boolean, initialPath: undefined as string | undefined } },
    )
    expect(mocks.listDir).not.toHaveBeenCalled() // 没开就不问

    rerender({ open: true, initialPath: undefined })
    await waitFor(() => expect(result.current.entries).toHaveLength(1))
    expect(mocks.listDir).toHaveBeenCalledWith(undefined)
    expect(result.current.dir).toBe('/home/u')
    expect(result.current.parent).toBe('/home')
  })

  it('opens into the parent of the typed path', async () => {
    mocks.listDir.mockResolvedValue(listing('/home/u/.litegrip', '/home/u', FILE))
    const { result } = renderHook(() =>
      useGripperBrowse(true, dirOf('/home/u/.litegrip/can0_calibration.json')),
    )
    await waitFor(() => expect(result.current.dir).toBe('/home/u/.litegrip'))
    expect(mocks.listDir).toHaveBeenCalledWith('/home/u/.litegrip')
  })

  it('navigates into another directory', async () => {
    mocks.listDir.mockResolvedValue(listing('/home/u', '/home', FILE))
    const { result } = renderHook(() => useGripperBrowse(true))
    await waitFor(() => expect(result.current.dir).toBe('/home/u'))

    mocks.listDir.mockResolvedValue(listing('/tmp', '/', FILE))
    act(() => result.current.navigate('/tmp'))
    await waitFor(() => expect(result.current.dir).toBe('/tmp'))
    expect(mocks.listDir).toHaveBeenLastCalledWith('/tmp')
  })

  it('goes up to the parent, and does nothing at the root', async () => {
    mocks.listDir.mockResolvedValue(listing('/home/u', '/home', FILE))
    const { result } = renderHook(() => useGripperBrowse(true))
    await waitFor(() => expect(result.current.dir).toBe('/home/u'))

    // 有上级：上去。
    act(() => result.current.up())
    await waitFor(() => expect(mocks.listDir).toHaveBeenLastCalledWith('/home'))

    // 到根：parent 为 null，up() 不该再发请求。
    mocks.listDir.mockResolvedValue(listing('/', null))
    act(() => result.current.navigate('/'))
    await waitFor(() => expect(result.current.parent).toBeNull())
    const calls = mocks.listDir.mock.calls.length
    act(() => result.current.up())
    expect(mocks.listDir.mock.calls.length).toBe(calls)
  })

  it('shows a mapped error inline and empties the list', async () => {
    const err = { err: { kind: 'GripperBrowseError', msg: '/x 不是一个可访问的目录' } }
    mocks.listDir.mockResolvedValue(listing('/home/u', '/home', FILE))
    const { result } = renderHook(() => useGripperBrowse(true))
    await waitFor(() => expect(result.current.entries).toHaveLength(1))

    mocks.listDir.mockRejectedValue(err)
    act(() => result.current.navigate('/nope'))
    await waitFor(() => expect(result.current.error).not.toBe(''))
    expect(result.current.error).toBe(formatArmError(err))
    expect(result.current.entries).toEqual([])
    expect(result.current.truncated).toBe(false)
  })

  it('keeps only the latest navigation when responses arrive out of order', async () => {
    mocks.listDir.mockResolvedValueOnce(listing('/home/u', '/home', FILE))
    const { result } = renderHook(() => useGripperBrowse(true))
    await waitFor(() => expect(result.current.dir).toBe('/home/u'))

    const first = deferred<ReturnType<typeof listing>>()
    const second = deferred<ReturnType<typeof listing>>()
    mocks.listDir.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    act(() => result.current.navigate('/a'))
    act(() => result.current.navigate('/b'))

    // 后发的先回，先发的后回：落地必须是 /b。
    second.resolve(listing('/b', '/', FILE))
    await waitFor(() => expect(result.current.dir).toBe('/b'))
    first.resolve(listing('/a', '/', FILE))
    await Promise.resolve()
    expect(result.current.dir).toBe('/b')
  })
})

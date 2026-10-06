import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'

const mocks = vi.hoisted(() => ({
  license: vi.fn(),
  activate: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { success: mocks.success, warning: mocks.warning, error: mocks.error },
}))

vi.mock('@/lib/arm', () => ({
  armClient: {
    license: mocks.license,
    activate: mocks.activate,
    versions: { daemon: '0.1.0', sdk: '2.1.0' },
  },
  useArmConnection: () => ({ status: 'connected' }),
  formatArmError: (err: unknown) => String((err as Error)?.message ?? err),
}))

const { useActivation } = await import('./useActivation')

const UID = '101112131415161718191a1b'
const REQUEST = {
  uid: UID,
  contact: {
    name: '张三',
    phone: '13800000000',
    organization: '某大学',
    wechatId: '',
    email: 'z@example.com',
    region: '上海',
    industry: '',
    purpose: '',
  },
  consent: { granted: true },
  diagnostics: { studio: 'test', sdk: '2.1.0', firmware: 'Litearm1.8.0-7J' },
}

const LOCKED = { supported: true, uid: UID, activated: false }
const CONFIRMED = { ...LOCKED, activated: true }

describe('useActivation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.license.mockResolvedValue(LOCKED)
  })

  it('toasts success only when the read-back confirms the arm is activated', async () => {
    mocks.activate.mockResolvedValue(CONFIRMED)
    const { result } = renderHook(() => useActivation())
    await waitFor(() => expect(result.current.snapshot).toEqual(LOCKED))

    await act(async () => {
      await result.current.submit(REQUEST)
    })

    expect(mocks.success).toHaveBeenCalledTimes(1)
    expect(mocks.warning).not.toHaveBeenCalled()
  })

  it('warns instead of claiming success when the read-back could not confirm', async () => {
    // ⚠ 写之后的回读超时时, daemon 回的就是 `{supported: null}` —— 而服务端照样是 ok。
    //   这时候弹"已解锁"与面板上的"读不到"直接矛盾。
    mocks.activate.mockResolvedValue({ supported: null })
    const { result } = renderHook(() => useActivation())
    await waitFor(() => expect(result.current.snapshot).toEqual(LOCKED))

    await act(async () => {
      await result.current.submit(REQUEST)
    })

    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.warning).toHaveBeenCalledTimes(1)
  })

  it('warns when the write went through but the record still reads as locked', async () => {
    mocks.activate.mockResolvedValue(LOCKED)
    const { result } = renderHook(() => useActivation())
    await waitFor(() => expect(result.current.snapshot).toEqual(LOCKED))

    await act(async () => {
      await result.current.submit(REQUEST)
    })

    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.warning).toHaveBeenCalledTimes(1)
  })

  it('clears a stale error once a later read succeeds', async () => {
    mocks.license.mockRejectedValueOnce(new Error('boom'))
    mocks.license.mockResolvedValueOnce(LOCKED)

    const { result } = renderHook(() => useActivation())
    await waitFor(() => expect(result.current.error).toBeTruthy())

    await act(async () => {
      await result.current.refresh()
    })

    await waitFor(() => expect(result.current.snapshot).toEqual(LOCKED))
    expect(result.current.error).toBeNull()
  })
})

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'

const mocks = vi.hoisted(() => ({
  requestStop: vi.fn(),
  disconnect: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    warning: mocks.toastWarning,
    success: vi.fn(),
    info: vi.fn(),
  },
}))

const subscribe = () => () => {}

vi.mock('./client', () => ({
  armClient: {
    status: 'connected',
    conn: null,
    motionBusy: false,
    lastError: null,
    subscribeStatus: subscribe,
    subscribeMotion: subscribe,
    requestStop: mocks.requestStop,
    connect: vi.fn(),
    disconnect: mocks.disconnect,
  },
}))

const { useArmConnection } = await import('./useArmConnection')

describe('useArmConnection.requestStop', () => {
  beforeEach(() => {
    mocks.requestStop.mockReset()
    mocks.toastError.mockReset()
  })

  it('surfaces a rejected estop to the operator', async () => {
    mocks.requestStop.mockRejectedValueOnce(
      Object.assign(new Error('已有运动在途'), { err: { kind: 'MotionBusyError', msg: '已有运动在途' } }),
    )

    const { result } = renderHook(() => useArmConnection())
    result.current.requestStop()

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
    const [message, options] = mocks.toastError.mock.calls[0]
    expect(typeof message).toBe('string')
    expect(message.length).toBeGreaterThan(0)
    expect(options).toMatchObject({ id: 'estop-failed' })
  })

  it('stays quiet when the estop is accepted', async () => {
    mocks.requestStop.mockResolvedValueOnce(null)

    const { result } = renderHook(() => useArmConnection())
    result.current.requestStop()

    await waitFor(() => expect(mocks.requestStop).toHaveBeenCalledTimes(1))
    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})

describe('useArmConnection.disconnect', () => {
  beforeEach(() => {
    mocks.disconnect.mockReset()
    mocks.toastError.mockReset()
  })

  it('surfaces an unacknowledged disconnect instead of letting it pass silently', async () => {
    // 断开是**带确认的请求**（#82）：daemon 没确认就不许静默 —— 否则操作员以为断了、
    // 其实臂还连在原口上，下一次换口连接必被拒。
    mocks.disconnect.mockRejectedValueOnce(new Error('本地程序未连接'))

    const { result } = renderHook(() => useArmConnection())
    result.current.disconnect()

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
    const [message, options] = mocks.toastError.mock.calls[0]
    expect(typeof message).toBe('string')
    expect(message.length).toBeGreaterThan(0)
    expect(options).toMatchObject({ id: 'disconnect-failed' })
  })

  it('stays quiet when the disconnect is acknowledged', async () => {
    mocks.disconnect.mockResolvedValueOnce(undefined)

    const { result } = renderHook(() => useArmConnection())
    result.current.disconnect()

    await waitFor(() => expect(mocks.disconnect).toHaveBeenCalledTimes(1))
    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})

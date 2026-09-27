import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'

const mocks = vi.hoisted(() => ({
  readPayload: vi.fn(),
  setPayload: vi.fn(),
  readGravityScale: vi.fn(),
  readInertiaScale: vi.fn(),
  readGravityVector: vi.fn(),
  setGravityScale: vi.fn(),
  setInertiaScale: vi.fn(),
  setGravityVector: vi.fn(),
  getJointParams: vi.fn(),
  setJointParam: vi.fn(),
  setJointLimits: vi.fn(),
  saveParams: vi.fn(),
  resetFactoryParams: vi.fn(),
  kinBench: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
    warning: vi.fn(),
    info: vi.fn(),
  },
}))

vi.mock('@/lib/arm', () => ({
  armClient: {
    readPayload: mocks.readPayload,
    setPayload: mocks.setPayload,
    readGravityScale: mocks.readGravityScale,
    readInertiaScale: mocks.readInertiaScale,
    readGravityVector: mocks.readGravityVector,
    setGravityScale: mocks.setGravityScale,
    setInertiaScale: mocks.setInertiaScale,
    setGravityVector: mocks.setGravityVector,
    getJointParams: mocks.getJointParams,
    setJointParam: mocks.setJointParam,
    setJointLimits: mocks.setJointLimits,
    saveParams: mocks.saveParams,
    resetFactoryParams: mocks.resetFactoryParams,
    kinBench: mocks.kinBench,
  },
  formatArmError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  useArmConnection: () => ({ status: 'connected' }),
}))

const { useSettingsState } = await import('./useSettingsState')

const JOINT = { idx: 0, kp: 50, kd: 2, tau_max: 10, q_min: -1.5, q_max: 1.5 }

function primeHappyPath() {
  mocks.readPayload.mockResolvedValue({ mass: 1, com: [0, 0, 0] })
  mocks.readGravityScale.mockResolvedValue([1, 1, 1, 1, 1, 1, 1])
  mocks.readInertiaScale.mockResolvedValue([1, 1, 1, 1, 1, 1, 1])
  mocks.readGravityVector.mockResolvedValue([0, 0, -1])
  mocks.getJointParams.mockResolvedValue([JOINT])
}

describe('useSettingsState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    primeHappyPath()
  })

  it('reads every parameter group once the session is connected', async () => {
    const { result } = renderHook(() => useSettingsState())
    await waitFor(() => expect(result.current.joints).toHaveLength(1))
    expect(mocks.readPayload).toHaveBeenCalledTimes(1)
    expect(mocks.readGravityScale).toHaveBeenCalledTimes(1)
    expect(result.current.feedForward.gravityVector).toEqual([0, 0, -1])
  })

  it('shows the value read back after a write, not the value that was sent', async () => {
    const { result } = renderHook(() => useSettingsState())
    await waitFor(() => expect(result.current.joints).toHaveLength(1))

    mocks.setPayload.mockResolvedValue(null)
    // 固件把负质量静默钳成 0：下发 -5，读回 0。
    mocks.readPayload.mockResolvedValueOnce({ mass: 0, com: [-0.25, 0.1, 1] })
    await act(async () => {
      await result.current.savePayload(-5, [-0.25, 0.1, 1])
    })

    expect(mocks.setPayload).toHaveBeenCalledWith(-5, [-0.25, 0.1, 1])
    expect(result.current.payload).toEqual({ mass: 0, com: [-0.25, 0.1, 1] })
    expect(mocks.toastSuccess).toHaveBeenCalled()
  })

  it('surfaces a rejected write instead of failing silently', async () => {
    const { result } = renderHook(() => useSettingsState())
    await waitFor(() => expect(result.current.joints).toHaveLength(1))

    mocks.setJointLimits.mockRejectedValueOnce(new Error('firmware requires a disabled arm'))
    await act(async () => {
      await result.current.saveJointLimits(0, -1, 1)
    })

    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })

  it('runs the firmware self-test and stores the result', async () => {
    mocks.kinBench.mockResolvedValueOnce({ ok: true, crc_errors: 0, fifo_drops: 3 })
    const { result } = renderHook(() => useSettingsState())
    await waitFor(() => expect(result.current.joints).toHaveLength(1))

    await act(async () => {
      await result.current.runSelfTest()
    })

    expect(result.current.kinBench).toMatchObject({ crc_errors: 0, fifo_drops: 3 })
    expect(mocks.toastSuccess).toHaveBeenCalled()
  })
})

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'

const mocks = vi.hoisted(() => ({
  readPayload: vi.fn(),
  setPayload: vi.fn(),
  readGravityVector: vi.fn(),
  setGravityVector: vi.fn(),
  getGravity: vi.fn(),
  getJointParams: vi.fn(),
  setJointParam: vi.fn(),
  setJointLimits: vi.fn(),
  saveParams: vi.fn(),
  resetFactoryParams: vi.fn(),
  kinBench: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  /** daemon 的使能位：`enabled` 决定「下发（须失能）」能不能点。 */
  robotState: null as { enabled: boolean; q: number[] } | null,
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
    readGravityVector: mocks.readGravityVector,
    setGravityVector: mocks.setGravityVector,
    getGravity: mocks.getGravity,
    getJointParams: mocks.getJointParams,
    setJointParam: mocks.setJointParam,
    setJointLimits: mocks.setJointLimits,
    saveParams: mocks.saveParams,
    resetFactoryParams: mocks.resetFactoryParams,
    kinBench: mocks.kinBench,
  },
  formatArmError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  useArmConnection: () => ({ status: 'connected' }),
  useArmState: () => mocks.robotState,
}))

const { useSettingsState } = await import('./useSettingsState')

const JOINT = { idx: 0, kp: 50, kd: 2, tau_max: 10, q_min: -1.5, q_max: 1.5 }

function primeHappyPath() {
  mocks.readPayload.mockResolvedValue({ mass: 1, com: [0, 0, 0] })
  mocks.readGravityVector.mockResolvedValue([0, 0, -9.81])
  mocks.getGravity.mockResolvedValue([0, 0, 0, 0, 0, 0, 0])
  mocks.getJointParams.mockResolvedValue([JOINT])
  mocks.robotState = { enabled: false, q: [0, 0, 0, 0, 0, 0, 0] }
}

describe('useSettingsState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.robotState = null
    primeHappyPath()
  })

  it('reads every parameter group once the session is connected', async () => {
    const { result } = renderHook(() => useSettingsState())
    await waitFor(() => expect(result.current.joints).toHaveLength(1))
    expect(mocks.readPayload).toHaveBeenCalledTimes(1)
    expect(result.current.gravityVector).toEqual([0, 0, -9.81])
  })

  it('rereads only the gravity vector for the installation tab, leaving the other drafts alone', async () => {
    // ⚠ 「读当前」不能走 `refresh()`: 那会把载荷与逐轴参数一起重读, 把别的页签里
    //   还没保存的草稿悄悄覆盖掉。
    const { result } = renderHook(() => useSettingsState())
    await waitFor(() => expect(result.current.joints).toHaveLength(1))
    mocks.readPayload.mockClear()

    mocks.readGravityVector.mockResolvedValueOnce([9.81, 0, 0])
    await act(async () => {
      await result.current.readGravity()
    })

    expect(result.current.gravityVector).toEqual([9.81, 0, 0])
    expect(mocks.readPayload).not.toHaveBeenCalled()
  })

  it('reports the enable bit, so the panel can block the write the firmware would refuse', async () => {
    mocks.robotState = { enabled: true, q: [0, 0, 0, 0, 0, 0, 0] }
    const { result } = renderHook(() => useSettingsState())
    await waitFor(() => expect(result.current.joints).toHaveLength(1))
    expect(result.current.enabled).toBe(true)
    expect(result.current.stateKnown).toBe(true)
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

  it('refuses to write a direction it never read back from the device', async () => {
    // ⚠ 未读就写 = 把控件里的默认值（[0,0,0]）当成一个装向盲写进固件。闸门在界面上
    //   （按钮灰掉），这里钉的是"即使点得到也发不出去"。
    mocks.readGravityVector.mockRejectedValue(new Error('link down'))
    const { result } = renderHook(() => useSettingsState())
    await waitFor(() => expect(mocks.readGravityVector).toHaveBeenCalled())

    expect(result.current.gravitySynced).toBe(false)
    await act(async () => {
      await result.current.applyGravityVector([9.81, 0, 0])
    })

    expect(mocks.setGravityVector).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalled()
  })

  it('refuses to write while the state is unknown, because not knowing is not being safe', async () => {
    mocks.robotState = null // 一颗状态帧都还没到
    const { result } = renderHook(() => useSettingsState())
    await waitFor(() => expect(result.current.joints).toHaveLength(1))
    expect(result.current.gravitySynced).toBe(true) // 读回来了, 但仍然不知道使能态
    expect(result.current.stateKnown).toBe(false)

    await act(async () => {
      await result.current.applyGravityVector([9.81, 0, 0])
    })

    expect(mocks.setGravityVector).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalled()
  })

  it('refuses to write while the drives are enabled', async () => {
    mocks.robotState = { enabled: true, q: [0, 0, 0, 0, 0, 0, 0] }
    const { result } = renderHook(() => useSettingsState())
    await waitFor(() => expect(result.current.joints).toHaveLength(1))

    await act(async () => {
      await result.current.applyGravityVector([9.81, 0, 0])
    })

    expect(mocks.setGravityVector).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalled()
  })

  it('self-checks a write: same pose for both G(q) reads, and the read-back diff', async () => {
    // ⚠ 写同值 G(q) 不该变，改动过则必须变 —— 只有这一条能证明"真的进了模型"。
    mocks.readGravityVector.mockResolvedValueOnce([0, 0, -9.81]).mockResolvedValue([9.81, 0, 0])
    mocks.getGravity.mockResolvedValueOnce([0, 1, 1, 1, 1, 1, 1])
    mocks.getGravity.mockResolvedValueOnce([0.5, 1, 1, 1, 1, 1, 1])
    const { result } = renderHook(() => useSettingsState())
    await waitFor(() => expect(result.current.joints).toHaveLength(1))

    await act(async () => {
      await result.current.applyGravityVector([9.81, 0, 0])
    })

    const check = result.current.installationCheck!
    expect(check.readbackOk).toBe(true)
    expect(check.magnitudeOk).toBe(true)
    expect(check.gqChanged).toBe(true)
    expect(check.gqOk).toBe(true)
    // 前后两次用的是**同一个**姿态（否则"变了没有"分不清是参数生效还是臂动了）。
    expect(mocks.getGravity.mock.calls.map((c) => c[0])).toEqual([
      [0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0],
    ])
    expect(result.current.gravityVector).toEqual([9.81, 0, 0])
  })

  it('calls out a write whose G(q) did not move the way it had to', async () => {
    // 字节落位了、回读一致，但模型那侧没动 —— 这正是"读回比对"抓不到的那种失败。
    mocks.readGravityVector.mockResolvedValueOnce([0, 0, -9.81]).mockResolvedValue([9.81, 0, 0])
    mocks.getGravity.mockResolvedValue([0, 1, 1, 1, 1, 1, 1]) // 前后一样
    const { result } = renderHook(() => useSettingsState())
    await waitFor(() => expect(result.current.joints).toHaveLength(1))

    await act(async () => {
      await result.current.applyGravityVector([9.81, 0, 0])
    })

    expect(result.current.installationCheck!.gqChanged).toBe(false)
    expect(result.current.installationCheck!.gqOk).toBe(false)
    expect(mocks.toastError).toHaveBeenCalled()
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })

  it('degrades to "skipped" when the firmware has no G(q) command', async () => {
    mocks.getGravity.mockRejectedValue(new Error('unknown command'))
    const { result } = renderHook(() => useSettingsState())
    await waitFor(() => expect(result.current.joints).toHaveLength(1))

    await act(async () => {
      await result.current.applyGravityVector([0, 0, -9.81])
    })

    const check = result.current.installationCheck!
    expect(check.gqChanged).toBeNull()
    expect(check.gqOk).toBeNull()
    // 取不到 G(q) 不该把"字节写进去了"这个结论也一起丢掉。
    expect(check.readbackOk).toBe(true)
  })
})

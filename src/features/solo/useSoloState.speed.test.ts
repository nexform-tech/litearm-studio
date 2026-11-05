import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'

// 固件调速器（`set_speed` 0x21）是**全局且持续**的速度上限：它一直夹着之后每一条运动，
// 直到复位或断电，而且协议没有回读 —— 界面上看不见。旧版本的就绪姿态/回零曾把滑条值
// 写进调速器，于是回零之后滑条再往上推也不生效，重启上位机也修不好（issue #236）。
// 这组用例钉住修复后的分工：连接时把调速器归一到 100%，回零/就绪姿态不再碰它，
// 滑条只作为单条轨迹的倍率下发。
const mocks = vi.hoisted(() => ({
  getJointParams: vi.fn(),
  getTcpPose: vi.fn(),
  movej: vi.fn(),
  home: vi.fn(),
  setSpeed: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
  status: 'connected' as string,
  conn: null as unknown,
  armState: null as unknown,
}))

vi.mock('sonner', () => ({
  toast: {
    warning: mocks.toastWarning,
    error: mocks.toastError,
    success: vi.fn(),
    info: vi.fn(),
  },
}))

vi.mock('@/lib/arm', () => ({
  armClient: {
    getJointParams: mocks.getJointParams,
    getTcpPose: mocks.getTcpPose,
    movej: mocks.movej,
    home: mocks.home,
    setSpeed: mocks.setSpeed,
  },
  formatArmError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  useArmConnection: () => ({ status: mocks.status, conn: mocks.conn }),
  useArmState: () => mocks.armState,
  useArmMetrics: () => ({}),
}))

const { useSoloState } = await import('./useSoloState')

const LIMITS = Array.from({ length: 7 }, (_, i) => ({ idx: i, kp: 1, kd: 1, tau_max: 1, q_min: -1, q_max: 1 }))

const conn = (n: number) => ({ status: 'connected', port: null, firmware: '', n, cart: true, error: null })

/** 已连接、已使能且静止（`ready`）的机械臂 —— `enableOn` 为真的最小状态。 */
const armWith = (count: number) => ({
  q: Array.from({ length: count }, () => 0),
  dq: Array.from({ length: count }, () => 0),
  tau: Array.from({ length: count }, () => 1),
  errs: Array.from({ length: count }, () => 0),
  temps: [],
  fault: [],
  mode: 1,
  modeName: 'MOVE_J',
  flags: 0,
  flagNames: [],
  jointFault: 0,
  faultAxes: [],
  enabled: true,
  cartBusy: false,
  faulted: false,
  faultDetail: '',
  seq: 1,
  state: 'ready',
})

async function renderSolo() {
  const rendered = renderHook(() => useSoloState())
  await act(async () => {}) // 冲掉挂载时的 effect 与在途的关节限位读取
  return rendered
}

describe('useSoloState speed governor', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
    localStorage.clear()
    mocks.getJointParams.mockReset().mockResolvedValue(LIMITS)
    mocks.getTcpPose.mockReset().mockResolvedValue([0.32, 0, 0.45, 0, 1.57, 0])
    mocks.movej.mockReset().mockResolvedValue(null)
    mocks.home.mockReset().mockResolvedValue(null)
    mocks.setSpeed.mockReset().mockResolvedValue(null)
    mocks.toastWarning.mockReset()
    mocks.toastError.mockReset()
    mocks.status = 'connected'
    mocks.conn = conn(7)
    mocks.armState = armWith(7)
  })

  it('normalizes the persistent governor to 100% once connected', async () => {
    await renderSolo()

    expect(mocks.setSpeed).toHaveBeenCalledTimes(1)
    expect(mocks.setSpeed).toHaveBeenCalledWith(100)
  })

  it('does not touch the governor while disconnected', async () => {
    mocks.status = 'disconnected'
    mocks.conn = null
    mocks.armState = null

    await renderSolo()

    expect(mocks.setSpeed).not.toHaveBeenCalled()
  })

  it('does not normalize the governor in simulation mode', async () => {
    const { result } = await renderSolo()
    mocks.setSpeed.mockClear()

    const simTab = result.current.viewTabs.find((tab) => tab.key === 'sim')!
    act(() => simTab.onClick())
    await act(async () => {})

    expect(mocks.setSpeed).not.toHaveBeenCalled()
  })

  it('keeps the slider out of the governor when moving to the ready pose', async () => {
    const { result } = await renderSolo()
    mocks.setSpeed.mockClear()

    // 滑条 setter 只改本地状态；它不该把值写进固件的调速器。
    act(() => result.current.setSpeed(30))
    expect(mocks.setSpeed).not.toHaveBeenCalled()

    await act(async () => {
      result.current.homeJoints()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.setSpeed).not.toHaveBeenCalled()
    const [target, factor] = mocks.movej.mock.calls.at(-1)!
    expect(target).toEqual([0, 0.5, 0, -1, 0, 0.6, 0])
    // 滑条仍然决定这条运动的速度：30% ⇒ 0.3 的轨迹倍率。
    expect(factor).toBeCloseTo(0.3, 6)
  })

  it('keeps the slider out of the governor when zeroing', async () => {
    const { result } = await renderSolo()
    mocks.setSpeed.mockClear()

    await act(async () => {
      result.current.setSpeed(10)
    })

    await act(async () => {
      result.current.zeroJoints()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.setSpeed).not.toHaveBeenCalled()
    expect(mocks.home).toHaveBeenCalledTimes(1)
  })
})

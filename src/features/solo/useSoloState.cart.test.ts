import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'

// daemon 的 `conn` 帧是笛卡尔能力唯一的来源：固件没编译笛卡尔规划时 cart=false，
// movel 与点动都会被拒。这组用例钉住 UI 是否据此收手。
const mocks = vi.hoisted(() => ({
  getJointParams: vi.fn(),
  getTcpPose: vi.fn(),
  movel: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
  status: 'connected' as string,
  conn: { cart: true } as { cart: boolean } | null,
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
    movel: mocks.movel,
  },
  formatArmError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  useArmConnection: () => ({ status: mocks.status, conn: mocks.conn }),
  useArmState: () => mocks.armState,
  useArmMetrics: () => ({}),
}))

const { useSoloState } = await import('./useSoloState')

const LIMITS = Array.from({ length: 7 }, (_, i) => ({
  idx: i,
  kp: 1,
  kd: 1,
  tau_max: 1,
  q_min: -1,
  q_max: 1,
}))

/** 已连接、已使能且静止（`ready`）的机械臂——即 `realEnabled` 为真的最小状态。 */
const ENABLED_ARM = {
  q: [0, 0, 0, 0, 0, 0, 0],
  dq: [0, 0, 0, 0, 0, 0, 0],
  tau: [1, 1, 1, 1, 1, 1, 1],
  errs: [1, 1, 1, 1, 1, 1, 1],
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
}

async function renderSolo() {
  const rendered = renderHook(() => useSoloState())
  // 冲掉挂载时的 effect 与在途 promise（关节限位读取、TCP 位姿轮询）。未连接时不会
  // 发起读取，所以这里不能等 `getJointParams` 被调用。
  await act(async () => {})
  return rendered
}

describe('useSoloState cartesian capability gating', () => {
  beforeEach(async () => {
    // jsdom 的 navigator.language 是 en-US，语言探测器会选中英文；这里固定成中文，
    // 好让下面的断言同时验证 zh 词条确实存在（缺键时 i18next 会回退成键名本身）。
    await i18n.changeLanguage('zh')
    mocks.getJointParams.mockReset().mockResolvedValue(LIMITS)
    mocks.getTcpPose.mockReset().mockResolvedValue([0.32, 0, 0.45, 0, 1.57, 0])
    mocks.movel.mockReset().mockResolvedValue(null)
    mocks.toastWarning.mockReset()
    mocks.toastError.mockReset()
    mocks.status = 'connected'
    mocks.conn = { cart: true }
    mocks.armState = ENABLED_ARM
  })

  it('exposes both readouts at once, so neither needs a tab to be seen', async () => {
    const { result } = await renderSolo()

    expect(result.current.poseJoint.map((p) => p.k)).toEqual(['J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'J7'])
    expect(result.current.poseCart?.map((p) => p.k)).toEqual(['X', 'Y', 'Z', 'RX', 'RY', 'RZ'])
  })

  it('drops the cartesian readout when cart=false instead of showing the local fallback', async () => {
    mocks.conn = { cart: false }

    const { result } = await renderSolo()

    expect(result.current.cartUnsupported).toBe(true)
    // 「笛卡尔」读数读的是 TCP 位姿 RPC，固件没有规划时必然失败：不该轮询，
    // 更不该把本地兜底的 `s.cart` 初始值当作真实位姿显示。
    expect(result.current.poseCart).toBeNull()
    expect(result.current.poseJoint.map((p) => p.k)).toEqual(['J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'J7'])
    expect(mocks.getTcpPose).not.toHaveBeenCalled()
  })

  it('refuses movel and jog when cart=false instead of letting the firmware reject them', async () => {
    mocks.conn = { cart: false }

    const { result } = await renderSolo()

    await act(async () => {
      await result.current.movelTarget([0.3, 0, 0.4], [0, 1.57, 0])
    })
    expect(mocks.movel).not.toHaveBeenCalled()
    expect(mocks.toastWarning).toHaveBeenCalledWith(expect.stringContaining('笛卡尔'), {
      id: 'solo-cart-unsupported',
    })

    act(() => result.current.onJogPress('X+'))
    expect(mocks.getTcpPose).not.toHaveBeenCalled()
    expect(mocks.movel).not.toHaveBeenCalled()
  })

  it('keeps the cartesian surface live when cart=true', async () => {
    const { result } = await renderSolo()

    expect(result.current.cartUnsupported).toBe(false)
    // 关节与笛卡尔同时可见 ⇒ 只要连着就轮询 TCP 位姿，不再等某个页签被点开。
    expect(mocks.getTcpPose).toHaveBeenCalled()
    expect(result.current.poseCart?.[0]).toEqual({ k: 'X', v: '0.320000', u: 'm' })

    await act(async () => {
      await result.current.movelTarget([0.3, 0, 0.4], [0, 1.57, 0])
    })
    expect(mocks.movel).toHaveBeenCalledTimes(1)
    expect(mocks.toastWarning).not.toHaveBeenCalled()
  })

  it('does not blame the firmware in simulation mode', async () => {
    mocks.conn = { cart: false }

    const { result } = await renderSolo()

    act(() => result.current.viewTabs.find((tab) => tab.key === 'sim')?.onClick())

    // 仿真模式本就不下发指令，能力缺失不是它的原因：读数不该被撤掉。
    expect(result.current.cartUnsupported).toBe(false)
    expect(result.current.poseCart).not.toBeNull()
  })

  it('does not blame the firmware while disconnected', async () => {
    mocks.status = 'disconnected'

    const { result } = await renderSolo()

    // 没有 conn 帧就没有能力结论；未连接发不出指令，与固件是否支持笛卡尔无关。
    expect(result.current.cartUnsupported).toBe(false)
    expect(result.current.poseCart).not.toBeNull()
  })
})

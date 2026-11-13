import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'

// daemon 的 `conn` 帧是笛卡尔能力唯一的来源：固件没编译笛卡尔规划时 cart=false，
// movel 与点动都会被拒。这组用例钉住 UI 是否据此收手。
const mocks = vi.hoisted(() => ({
  getJointParams: vi.fn(),
  getTcpPose: vi.fn(),
  movel: vi.fn(),
  movej: vi.fn(),
  // 连接时的调速器归一化（issue #236）会走这条；缺了 effect 里会抛 `not a function`。
  setSpeed: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
  status: 'connected' as string,
  // `cartProbeSilent` 与 `cart` 配对：决定"笛卡尔不可用"该说哪一句话（见
  // `cartUnsupportedHintKey`）。可缺省 —— 旧版守护进程不发它。
  conn: { cart: true } as { cart: boolean; cartProbeSilent?: boolean } | null,
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
    movej: mocks.movej,
    setSpeed: mocks.setSpeed,
  },
  formatArmError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  isMotionSuperseded: () => false,
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
    mocks.setSpeed.mockReset().mockResolvedValue(null)
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
    expect(result.current.poseCart?.[0]).toEqual({ k: 'X', v: '0.3200', u: 'm' })
    // 读数固定 4 位小数：daemon 发的是 6 位，但那是帧格式不是测量精度，末两位跟着噪声跳。
    for (const p of result.current.poseCart ?? []) expect(p.v).toMatch(/^-?\d+\.\d{4}$/)
    expect(result.current.poseJoint[0].v).toMatch(/^-?\d+\.\d{4}$/)

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

    // 仿真模式本就不下发指令，能力缺失不是它的原因；但也没有实机位姿可显示 ——
    // 不能拿本地初值当读数，提示语要说"仿真模式"。
    expect(result.current.cartUnsupported).toBe(false)
    expect(result.current.poseCart).toBeNull()
    expect(result.current.cartPoseHintKey).toBe('solo:cartesian.poseSim')
  })

  it('does not blame the firmware while disconnected', async () => {
    mocks.status = 'disconnected'

    const { result } = await renderSolo()

    // 没有 conn 帧就没有能力结论；未连接发不出指令，与固件是否支持笛卡尔无关。
    expect(result.current.cartUnsupported).toBe(false)
    expect(result.current.poseCart).toBeNull()
    expect(result.current.cartPoseHintKey).toBe('solo:cartesian.poseDisconnected')
  })

  // ── `cart=false` 的两种成因要分开说 ─────────────────────────────────────────
  //
  // SDK 探测笛卡尔能力那三帧若全无应答（本硬件的 USB CDC 上行有已知丢帧），它会
  // fail-closed 地当"不支持"，同时把这一情形单独记进 `_cart_probe_silent`。守护进程
  // 把两者一起发来，因为**下一步动作不同**：一个是刷固件，一个是查链路。以前只有
  // `cart`，第二种被说成了第一种。

  it('says the firmware lacks a planner when the firmware said so', async () => {
    mocks.conn = { cart: false, cartProbeSilent: false }

    const { result } = await renderSolo()

    expect(result.current.cartUnsupported).toBe(true)
    expect(result.current.cartProbeSilent).toBe(false)
    expect(result.current.cartHintKey).toBe('solo:cartesian.unsupportedHint')
  })

  it('says the probe went unanswered when that is what happened', async () => {
    mocks.conn = { cart: false, cartProbeSilent: true }

    const { result } = await renderSolo()

    // 处理不变（一样关掉笛卡尔 —— SDK 那边同样会拒），变的只是那句话。
    expect(result.current.cartUnsupported).toBe(true)
    expect(result.current.cartProbeSilent).toBe(true)
    expect(result.current.cartHintKey).toBe('solo:cartesian.probeSilentHint')
  })

  it('does not blame the firmware for a silent probe either', async () => {
    mocks.conn = { cart: false, cartProbeSilent: true }

    const { result } = await renderSolo()

    await act(async () => {
      await result.current.movelTarget([0.3, 0, 0.4], [0, 1.57, 0])
    })
    expect(mocks.movel).not.toHaveBeenCalled()
    // 推到界面上的那句必须是"探测没答"，不是"固件没编"。
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      expect.stringContaining('没有应答'),
      { id: 'solo-cart-unsupported' },
    )
  })

  it('has nothing to explain while cartesian is available', async () => {
    const { result } = await renderSolo()

    expect(result.current.cartHintKey).toBeNull()
  })
})

describe('useSoloState operation error lifecycle', () => {
  const POSE: [number, number, number, number, number, number] = [0.32, 0, 0.45, 0, 1.57, 0]

  beforeEach(async () => {
    await i18n.changeLanguage('zh')
    mocks.getJointParams.mockReset().mockResolvedValue(LIMITS)
    mocks.getTcpPose.mockReset().mockResolvedValue(POSE)
    mocks.movel.mockReset().mockResolvedValue(null)
    mocks.setSpeed.mockReset().mockResolvedValue(null)
    mocks.toastWarning.mockReset()
    mocks.toastError.mockReset()
    mocks.status = 'connected'
    mocks.conn = { cart: true }
    mocks.armState = ENABLED_ARM
  })

  it('clears a stale pose-read failure once the next read succeeds', async () => {
    // 与点动同一个毛病：读位姿失败记进了故障灯旁的红框，而重试成功却没有任何地方清它。
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result } = await renderSolo()

    mocks.getTcpPose.mockRejectedValueOnce(new Error('读位姿超时'))
    await act(async () => {
      await result.current.syncCurrentTcpPose()
    })
    expect(result.current.faultReason).toContain('读位姿超时')

    mocks.getTcpPose.mockResolvedValue(POSE)
    await act(async () => {
      await result.current.syncCurrentTcpPose()
    })
    expect(result.current.faultReason).toBeNull()
    consoleError.mockRestore()
  })

  it('does not let a successful read hide a motion failure', async () => {
    // 读通只证明读通了：它不能把「运动失败」那个更重的结论一起抹掉。
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result } = await renderSolo()

    mocks.movel.mockRejectedValueOnce(new Error('运动被拒'))
    await act(async () => {
      await result.current.movelTarget([0.3, 0, 0.4], [0, 1.57, 0])
    })
    expect(result.current.faultReason).toContain('运动被拒')

    mocks.getTcpPose.mockResolvedValue(POSE)
    await act(async () => {
      await result.current.syncCurrentTcpPose()
    })
    expect(result.current.faultReason).toContain('运动被拒')
    consoleError.mockRestore()
  })
})

describe('useSoloState unavailable feedback', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
    mocks.getJointParams.mockReset().mockResolvedValue(LIMITS)
    mocks.getTcpPose.mockReset().mockResolvedValue([0.32, 0, 0.45, 0, 1.57, 0])
    mocks.movel.mockReset().mockResolvedValue(null)
    mocks.movej.mockReset().mockResolvedValue(null)
    mocks.setSpeed.mockReset().mockResolvedValue(null)
    mocks.toastWarning.mockReset()
    mocks.toastError.mockReset()
    mocks.status = 'connected'
    mocks.conn = { cart: true }
    mocks.armState = ENABLED_ARM
  })

  it('warns instead of silently doing nothing when disconnected', async () => {
    mocks.status = 'disconnected'
    mocks.conn = null
    const { result } = await renderSolo()

    await act(async () => {
      result.current.homeJoints()
      result.current.zeroJoints()
      result.current.clearFault()
      result.current.resetArm()
      result.current.onJogPress('X+')
      await result.current.movelTarget([0.3, 0, 0.4], [0, 1.57, 0])
      await result.current.syncCurrentTcpPose()
    })

    // 没有下发任何东西，但每类操作都给出了「未连接」提示；关节滑条也不该被拨动。
    expect(mocks.movej).not.toHaveBeenCalled()
    expect(mocks.movel).not.toHaveBeenCalled()
    expect(mocks.getTcpPose).not.toHaveBeenCalled()
    expect(mocks.toastWarning).toHaveBeenCalled()
  })

  it('warns when the arm is connected but not enabled', async () => {
    mocks.armState = { ...ENABLED_ARM, enabled: false, state: 'disabled' }
    const { result } = await renderSolo()

    await act(async () => {
      result.current.homeJoints()
      result.current.zeroJoints()
    })

    expect(mocks.movej).not.toHaveBeenCalled()
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      expect.stringContaining('使能'),
      { id: 'solo-not-enabled' },
    )
  })
})

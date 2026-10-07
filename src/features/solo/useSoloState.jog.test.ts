import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { MODE_INTENT_TIMEOUT_MS } from './soloUtils'

// 这组用例渲染真实的 useSoloState，覆盖它的**自身逻辑**（点动手势、步长单位换算、模式
// 意图对账、关节下发目标），而不是 soloUtils 里那些纯函数。useSoloState.test.ts 只测
// 后者的 re-export，文件名承诺的 hook 覆盖由这里补上。
const mocks = vi.hoisted(() => ({
  getJointParams: vi.fn(),
  getTcpPose: vi.fn(),
  movel: vi.fn(),
  movej: vi.fn(),
  zeroGStart: vi.fn(),
  zeroGStop: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
  status: 'connected' as string,
  conn: { cart: true } as { cart: boolean; n?: number } | null,
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
    zeroGStart: mocks.zeroGStart,
    zeroGStop: mocks.zeroGStop,
  },
  formatArmError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  useArmConnection: () => ({ status: mocks.status, conn: mocks.conn }),
  useArmState: () => mocks.armState,
  useArmMetrics: () => ({}),
}))

const { useSoloState } = await import('./useSoloState')

/** 已连接、已使能、静止（`ready`）的机械臂 —— `realEnabled` 为真的最小状态。 */
function enabledArm(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  }
}

/** 每根轴范围都是 [-1, 1]，百分比换算一眼可算：pct = (rad + 1) * 50。 */
const LIMITS = Array.from({ length: 7 }, (_, i) => ({ idx: i, kp: 1, kd: 1, tau_max: 1, q_min: -1, q_max: 1 }))

const POSE = [0.3, 0, 0.4, 0, 0, 0]

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function renderSolo() {
  const rendered = renderHook(() => useSoloState())
  // 冲掉挂载时的 effect 与在途 promise（关节限位读取、TCP 位姿轮询）。轮询的 400ms
  // 定时器在 fake timers 下不会自己触发，所以这里落地的是 effect 里的第一次读取。
  await act(async () => {})
  return rendered
}

/** 冲掉 runJog 里 `getTcpPose` / `movel` 之间的多段 microtask。 */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })
}

/**
 * 把 `getTcpPose` 换成由用例手动决定何时落地的 promise：点动链路是
 * `await getTcpPose()` → 生成路点 → `await movel()` 的循环，只有能停在任意一段的
 * 边界上，才测得出"松开后续段不再发生"。
 *
 * ⚠ 必须在 `renderSolo()` **之后**安装：挂载时 effect 里的第一次轮询也会调用
 * `getTcpPose`，否则它会占掉一个 deferred。
 */
function controlTcpPose() {
  const poses: Array<Deferred<number[]>> = []
  mocks.getTcpPose.mockReset()
  mocks.getTcpPose.mockImplementation(() => {
    const d = deferred<number[]>()
    poses.push(d)
    return d.promise
  })
  return poses
}

function controlMovel() {
  const calls: Array<Deferred<unknown>> = []
  mocks.movel.mockReset()
  mocks.movel.mockImplementation(() => {
    const d = deferred<unknown>()
    calls.push(d)
    return d.promise
  })
  return calls
}

function modeOf(result: { current: ReturnType<typeof useSoloState> }, key: string) {
  return result.current.modes.find((m) => m.key === key)!
}

function expectJointPct(result: { current: ReturnType<typeof useSoloState> }, expected: number[]) {
  const actual = result.current.joints.map((j) => j.pct)
  expect(actual).toHaveLength(expected.length)
  actual.forEach((pct, i) => expect(pct).toBeCloseTo(expected[i], 10))
}

beforeEach(async () => {
  await i18n.changeLanguage('zh')
  // 点动链路里的 `getTcpPose` 由用例逐段放行，同时要挡住 400ms 的 TCP 轮询：否则
  // 轮询会往同一串 deferred 里插队，测出来的就不再是点动链路的调用序列。
  vi.useFakeTimers()
  mocks.getJointParams.mockReset().mockResolvedValue(LIMITS)
  mocks.getTcpPose.mockReset().mockResolvedValue(POSE)
  mocks.movel.mockReset().mockResolvedValue(null)
  mocks.movej.mockReset().mockResolvedValue(null)
  mocks.zeroGStart.mockReset().mockResolvedValue(null)
  mocks.zeroGStop.mockReset().mockResolvedValue(null)
  mocks.toastWarning.mockReset()
  mocks.toastError.mockReset()
  mocks.status = 'connected'
  mocks.conn = { cart: true, n: 7 }
  mocks.armState = enabledArm()
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useSoloState cartesian jog', () => {
  it('converts the mm step to metres on a base-frame translation press/release', async () => {
    const { result } = await renderSolo()
    const poses = controlTcpPose()
    mocks.movel.mockReset().mockResolvedValue(null)

    // 25 mm 的步长必须在 X+ 上变成 0.025 m：源串是 "25 mm"，不是毫米数直接当米用。
    act(() => result.current.setTransStep('25 mm'))
    act(() => {
      result.current.onJogPress('X+')
      // 单击：按下后马上松开。首段只有 1 个路点（FIRST_SEGMENT_POINTS），松开不得让
      // 链路续段 —— 这正是"单击变成异常长位移"那个竞态的反面。
      result.current.onJogRelease()
    })
    poses[0].resolve(POSE)
    await settle()

    expect(mocks.movel).toHaveBeenCalledTimes(1)
    const [pose, speed] = mocks.movel.mock.calls[0]
    expect(pose).toHaveLength(6)
    expect(pose[0]).toBeCloseTo(0.325, 10)
    expect(pose[1]).toBeCloseTo(0, 10)
    expect(pose[2]).toBeCloseTo(0.4, 10)
    // 速度按百分比下发：默认 50% ⇒ 0.5。
    expect(speed).toBeCloseTo(0.5, 10)
  })

  it('keeps the sign on a negative translation step', async () => {
    const { result } = await renderSolo()
    const poses = controlTcpPose()
    mocks.movel.mockReset().mockResolvedValue(null)

    act(() => result.current.setTransStep('10 mm'))
    act(() => {
      result.current.onJogPress('Z−')
      result.current.onJogRelease()
    })
    poses[0].resolve(POSE)
    await settle()

    const [pose] = mocks.movel.mock.calls[0]
    expect(pose[2]).toBeCloseTo(0.39, 10)
  })

  it('converts the degree step to radians on a base-frame rotation press/release', async () => {
    const { result } = await renderSolo()
    const poses = controlTcpPose()
    mocks.movel.mockReset().mockResolvedValue(null)

    // 30° 必须变成 π/6 rad；姿态轴用 °→rad，绝不复用平移的 mm→m。
    act(() => result.current.setRotStep('30 °'))
    act(() => {
      result.current.onJogPress('RX+')
      result.current.onJogRelease()
    })
    poses[0].resolve(POSE)
    await settle()

    expect(mocks.movel).toHaveBeenCalledTimes(1)
    const [pose] = mocks.movel.mock.calls[0]
    expect(pose[0]).toBeCloseTo(0.3, 10)
    expect(pose[1]).toBeCloseTo(0, 10)
    expect(pose[2]).toBeCloseTo(0.4, 10)
    expect(pose[3]).toBeCloseTo(Math.PI / 6, 10)
    expect(pose[4]).toBeCloseTo(0, 10)
    expect(pose[5]).toBeCloseTo(0, 10)
  })

  it('stops the in-flight chain when the operator releases mid-sequence', async () => {
    const { result } = await renderSolo()
    const poses = controlTcpPose()
    const movels = controlMovel()

    // 首段：1 个路点，落地后进入续段。
    act(() => result.current.onJogPress('X+'))
    poses[0].resolve(POSE)
    await settle()
    expect(mocks.movel).toHaveBeenCalledTimes(1)
    movels[0].resolve(null)
    await settle()

    // 续段：getTcpPose 落地后连续点动标志置位，第二段是 16 个路点（长按连续趋近）。
    expect(mocks.getTcpPose).toHaveBeenCalledTimes(2)
    poses[1].resolve(POSE)
    await settle()
    expect(mocks.movel).toHaveBeenCalledTimes(2)
    // 续段不是再来一个单击：默认 10 mm 步长 × NEXT_SEGMENT_POINTS(16) = 0.16 m。
    expect(mocks.movel.mock.calls[1][0][0]).toBeCloseTo(0.46, 10)

    // 松开时第二段（movel）还在途：松开必须作废这一代链路。
    act(() => result.current.onJogRelease())
    movels[1].resolve(null)
    await settle()

    // 在途段落地后不得再拉一次位姿、也不得再发一段 —— 否则操作员松手后机械臂仍在续走。
    expect(mocks.getTcpPose).toHaveBeenCalledTimes(2)
    expect(mocks.movel).toHaveBeenCalledTimes(2)
  })
})

describe('useSoloState joint dispatch', () => {
  it('dispatches the full pose the operator currently sees, not a captured snapshot', async () => {
    mocks.armState = enabledArm({ q: [-0.8, -0.4, 0, 0.2, 0.4, 0.6, 0.8] })
    const { result, rerender } = await renderSolo()
    // 广播把 [-1,1] 映射成滑条百分比：10/30/50/60/70/80/90。
    expectJointPct(result, [10, 30, 50, 60, 70, 80, 90])

    // 广播继续在动（操作员眼前的姿态也在变）。下发时其余轴必须取"当前"这一组，
    // 而不是闭包创建那一刻、更不是 seed 初值。
    mocks.armState = enabledArm({ q: [-0.6, -0.2, 0.2, 0.4, 0.6, 0.8, 0.9] })
    act(() => rerender())
    expectJointPct(result, [20, 40, 60, 70, 80, 90, 95])

    act(() => result.current.dispatchJoint(0, 60))
    await settle()

    expect(mocks.movej).toHaveBeenCalledTimes(1)
    const [target] = mocks.movej.mock.calls[0]
    // 只改 J1=60%，其余保持操作员当前看到的姿态：20/40/60/70/80/90/95%。
    expect(target).toHaveLength(7)
    const expected = [60, 40, 60, 70, 80, 90, 95].map((pct) => (pct / 100) * 2 - 1)
    target.forEach((v: number, i: number) => expect(v).toBeCloseTo(expected[i], 10))
  })

  it('sends the pose the operator synced for a movel, not the built-in fallback pose', async () => {
    const { result } = await renderSolo()

    // 操作员在笛卡尔面板里同步到当前 TCP 位姿后点「发送」：下发的必须是调用方给的那组
    // 坐标。若哪天改成读闭包里的 s.cart 兜底初值，发出去的就是开机默认位姿 —— 操作员
    // 眼前是一回事，机械臂走的是另一回事。
    const target = [0.9, 0.1, 0.2, 0.1, 0.2, 0.3] as [number, number, number, number, number, number]
    await act(async () => {
      await result.current.movelTarget([target[0], target[1], target[2]], [target[3], target[4], target[5]])
    })

    expect(mocks.movel).toHaveBeenCalledTimes(1)
    expect(mocks.movel.mock.calls[0][0]).toEqual(target)
    expect(mocks.toastWarning).not.toHaveBeenCalled()
  })
})

describe('useSoloState mode-intent reconciliation', () => {
  it('clears the optimistic intent once the broadcast confirms it', async () => {
    const { result, rerender } = await renderSolo()
    expect(result.current.viewBadge).toBe('位置 · 实机')

    act(() => modeOf(result, '拖动').onClick())
    // 指令在途时先按意图显示（广播还是"位置"）。
    expect(result.current.viewBadge).toBe('拖动 · 实机')
    expect(mocks.zeroGStart).toHaveBeenCalledTimes(1)

    // 广播追上意图：进入零重力（拖动）。
    mocks.armState = enabledArm({ state: 'zero_gravity' })
    act(() => rerender())
    // 再让广播回到"位置"：意图若已对账清除，显示就跟随广播；否则会残留"拖动"。
    mocks.armState = enabledArm({ state: 'ready' })
    act(() => rerender())
    expect(result.current.viewBadge).toBe('位置 · 实机')

    // 对账只是清掉乐观显示，不得把操作员的意图再镜像成一条真机命令。
    expect(mocks.zeroGStart).toHaveBeenCalledTimes(1)
    expect(mocks.zeroGStop).not.toHaveBeenCalled()
  })

  it('drops the optimistic intent when the broadcast never confirms it', async () => {
    const { result } = await renderSolo()

    act(() => modeOf(result, '拖动').onClick())
    expect(result.current.viewBadge).toBe('拖动 · 实机')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODE_INTENT_TIMEOUT_MS - 1)
    })
    // 超时前一直保留乐观显示。
    expect(result.current.viewBadge).toBe('拖动 · 实机')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    // 超时仍未确认：放弃乐观显示，回到广播的真实状态。
    expect(result.current.viewBadge).toBe('位置 · 实机')
    expect(mocks.zeroGStart).toHaveBeenCalledTimes(1)
  })

  it('keeps a mode switch local in simulation instead of sending a zero-g command', async () => {
    const { result } = await renderSolo()

    // 仿真模式是纯前端 dry-run：切到"拖动"只改本地显示，不能真去动机械臂。
    act(() => result.current.viewTabs.find((tab) => tab.key === 'sim')!.onClick())
    act(() => modeOf(result, '拖动').onClick())

    expect(modeOf(result, '拖动').active).toBe(true)
    expect(mocks.zeroGStart).not.toHaveBeenCalled()
    expect(mocks.zeroGStop).not.toHaveBeenCalled()
  })
})

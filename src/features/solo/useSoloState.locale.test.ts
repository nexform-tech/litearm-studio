import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'

// 「关节空间」卡片里的关节名与状态提示曾经写死成 `关节 ${n}`，英文界面下照旧显示中文，
// 而同一张卡上的位姿栏（`solo:pose.jointLabel`）一直是本地化的 —— 一栏翻、一栏不翻。
// 这组用例从界面语言出发，钉住卡片上的两处文案都跟着语言走。
const mocks = vi.hoisted(() => ({
  getJointParams: vi.fn(),
  getTcpPose: vi.fn(),
  status: 'connected' as string,
  conn: null as unknown,
  armState: null as unknown,
}))

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/arm', () => ({
  armClient: { getJointParams: mocks.getJointParams, getTcpPose: mocks.getTcpPose },
  formatArmError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  useArmConnection: () => ({ status: mocks.status, conn: mocks.conn }),
  useArmState: () => mocks.armState,
  useArmMetrics: () => ({}),
}))

const { useSoloState } = await import('./useSoloState')

const conn = (n: number) => ({ status: 'connected', port: null, firmware: '', n, cart: true, error: null })

/** 每根轴的范围都取 [-1, 1]，好让百分比换算能一眼算出来。 */
const LIMITS = Array.from({ length: 7 }, (_, i) => ({ idx: i, kp: 1, kd: 1, tau_max: 1, q_min: -1, q_max: 1 }))

/** 已连接、已使能且静止（`ready`）的机械臂 —— 关节圆点取 `ok` 的最小状态。 */
const armWith = (count: number, errs?: number[]) => ({
  q: Array.from({ length: count }, () => 0),
  dq: Array.from({ length: count }, () => 0),
  tau: Array.from({ length: count }, () => 1),
  errs: errs ?? Array.from({ length: count }, () => 1),
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

describe('useSoloState joint labels follow the interface language', () => {
  beforeEach(() => {
    mocks.getJointParams.mockReset().mockResolvedValue(LIMITS)
    mocks.getTcpPose.mockReset().mockResolvedValue([0.32, 0, 0.45, 0, 1.57, 0])
    mocks.status = 'connected'
    mocks.conn = conn(3)
    mocks.armState = armWith(3)
  })

  afterEach(async () => {
    // 语言缓存在 localStorage，改回去免得漏给后续用例
    await i18n.changeLanguage('zh')
  })

  it('names the joints in Chinese when the interface is Chinese', async () => {
    await i18n.changeLanguage('zh')

    const { result } = await renderSolo()

    expect(result.current.joints.map((j) => j.name)).toEqual(['关节 1', '关节 2', '关节 3'])
    expect(result.current.joints[0].dotTitle).toBe('关节 1 · 正常')
  })

  it('names the joints in English when the interface is English', async () => {
    await i18n.changeLanguage('en')

    const { result } = await renderSolo()

    expect(result.current.joints.map((j) => j.name)).toEqual(['Joint 1', 'Joint 2', 'Joint 3'])
    // 关节点上的悬停提示写的也是同一个关节名 + 状态，两处要一起翻
    expect(result.current.joints.every((j) => !j.dotTitle.includes('关节'))).toBe(true)
    expect(result.current.joints[0].dotTitle).toBe('Joint 1 · Normal')
  })

  it('keeps the fault tooltip in English as well', async () => {
    await i18n.changeLanguage('en')
    // 第 1 轴故障码 ≥ 8 ⇒ 圆点取 `warn`，悬停提示要说 "Fault" 而不是 "故障"
    mocks.armState = armWith(3, [8, 1, 1])

    const { result } = await renderSolo()

    expect(result.current.joints[0].dotTitle).toBe('Joint 1 · Fault')
    expect(result.current.joints[1].dotTitle).toBe('Joint 2 · Normal')
  })
})

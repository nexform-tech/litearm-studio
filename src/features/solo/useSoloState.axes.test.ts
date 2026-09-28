import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'

// `{1J}` 台架上，控制页此前仍然渲染 7 根关节滑条，并且把 7 个关节角塞进 movej ——
// 其中 6 个是内置默认值，固件侧只能拒（issue #37）。这组用例从 `conn` 帧的 `n` 出发，
// 钉住"看到几根滑条"= "发出去几个关节角"。
const mocks = vi.hoisted(() => ({
  getJointParams: vi.fn(),
  getTcpPose: vi.fn(),
  movel: vi.fn(),
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
    movel: mocks.movel,
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

/** 已连接、已使能且静止（`ready`）的机械臂 —— `realEnabled` 为真的最小状态。 */
const armWith = (count: number, q?: number[]) => ({
  q: q ?? Array.from({ length: count }, () => 0),
  dq: Array.from({ length: count }, () => 0),
  tau: Array.from({ length: count }, () => 1),
  errs: Array.from({ length: count }, () => 1),
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

const conn = (n: number) => ({ status: 'connected', port: null, firmware: '', n, cart: true, error: null })

/** 每根轴的范围都取 [-1, 1]，好让百分比换算能一眼算出来。 */
const LIMITS = Array.from({ length: 7 }, (_, i) => ({ idx: i, kp: 1, kd: 1, tau_max: 1, q_min: -1, q_max: 1 }))

async function renderSolo() {
  const rendered = renderHook(() => useSoloState())
  await act(async () => {}) // 冲掉挂载时的 effect 与在途的关节限位读取
  return rendered
}

describe('useSoloState axis count', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
    mocks.getJointParams.mockReset().mockResolvedValue(LIMITS)
    mocks.getTcpPose.mockReset().mockResolvedValue([0.32, 0, 0.45, 0, 1.57, 0])
    mocks.movel.mockReset().mockResolvedValue(null)
    mocks.movej.mockReset().mockResolvedValue(null)
    mocks.home.mockReset().mockResolvedValue(null)
    mocks.setSpeed.mockReset().mockResolvedValue(null)
    mocks.toastWarning.mockReset()
    mocks.toastError.mockReset()
    mocks.status = 'connected'
    mocks.conn = conn(1)
    mocks.armState = armWith(1)
  })

  it('renders exactly the reported number of joint sliders and readouts', async () => {
    const { result } = await renderSolo()

    expect(result.current.joints.map((j) => j.name)).toEqual(['关节 1'])
    expect(result.current.pose.map((p) => p.k)).toEqual(['J1'])
  })

  it('keeps all seven on a seven-axis arm', async () => {
    mocks.conn = conn(7)
    mocks.armState = armWith(7)

    const { result } = await renderSolo()

    expect(result.current.joints.map((j) => j.name)).toEqual([
      '关节 1', '关节 2', '关节 3', '关节 4', '关节 5', '关节 6', '关节 7',
    ])
  })

  it('follows the broadcast angle into a single slider', async () => {
    // 0.3 rad 落在 [-1,1] 的第 (0.3+1)/2 = 65%
    mocks.armState = armWith(1, [0.3])

    const { result } = await renderSolo()

    expect(result.current.joints).toHaveLength(1)
    expect(result.current.joints[0].pct).toBeCloseTo(65, 6)
  })

  it('sends a movej whose length matches the arm, not the built-in seven', async () => {
    const { result } = await renderSolo()

    act(() => result.current.dispatchJoint(0, 60))

    expect(mocks.movej).toHaveBeenCalledTimes(1)
    const [target] = mocks.movej.mock.calls[0]
    // [-1,1] 的 60% ⇒ 0.2 rad；长度必须是 1
    expect(target).toHaveLength(1)
    expect(target[0]).toBeCloseTo(0.2, 6)
  })

  it('trims a staged multi-joint send down to the real axes', async () => {
    const { result } = await renderSolo()

    act(() => result.current.dispatchJoints([10, 20, 30]))

    const [target] = mocks.movej.mock.calls[0]
    expect(target).toHaveLength(1)
    expect(target[0]).toBeCloseTo(-0.8, 6)
  })

  it('sends a home pose sized to the arm', async () => {
    const { result } = await renderSolo()

    await act(async () => {
      result.current.homeJoints()
      await Promise.resolve()
      await Promise.resolve()
    })

    const [target] = mocks.movej.mock.calls[0]
    expect(target).toEqual([0]) // HOME_JOINTS[0] = 0，第 2..7 轴不再跟着下发
  })

  it('keeps the full home pose on a seven-axis arm', async () => {
    mocks.conn = conn(7)
    mocks.armState = armWith(7)
    const { result } = await renderSolo()

    await act(async () => {
      result.current.homeJoints()
      await Promise.resolve()
      await Promise.resolve()
    })

    const [target] = mocks.movej.mock.calls[0]
    expect(target).toEqual([0, 0.5, 0, -1, 0, 0.6, 0])
  })

  it('falls back to the broadcast length when the count is not reported', async () => {
    mocks.conn = { status: 'connected', port: null, firmware: '', n: 0, cart: true, error: null }
    mocks.armState = armWith(2)

    const { result } = await renderSolo()

    expect(result.current.joints).toHaveLength(2)
  })
})

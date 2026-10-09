import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'

const mocks = vi.hoisted(() => {
  const conn = { current: null as Record<string, unknown> | null }
  const state = { current: null as Record<string, unknown> | null }
  const calib = { current: null as Record<string, unknown> | null }
  const status = { current: 'disconnected' as string }
  const present = { current: true }
  return {
    conn,
    state,
    calib,
    status,
    present,
    open: vi.fn(),
    close: vi.fn(),
    grasp: vi.fn(),
    release: vi.fn(),
    stop: vi.fn(),
    resetStop: vi.fn(),
    clearFault: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    moveTo: vi.fn(),
    setMotion: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  }
})

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}))

vi.mock('@/lib/arm/gripperClient', () => ({
  gripperClient: {
    open: mocks.open,
    close: mocks.close,
    grasp: mocks.grasp,
    release: mocks.release,
    stop: mocks.stop,
    resetStop: mocks.resetStop,
    clearFault: mocks.clearFault,
    enable: mocks.enable,
    disable: mocks.disable,
    moveTo: mocks.moveTo,
    setMotion: mocks.setMotion,
    connect: mocks.connect,
    disconnect: mocks.disconnect,
  },
}))

vi.mock('@/lib/arm/useGripper', () => ({
  useGripperConnection: () => ({
    conn: mocks.conn.current,
    status: mocks.status.current,
    present: mocks.present.current,
    busy: { busy: false, what: '' },
    connect: mocks.connect,
    disconnect: mocks.disconnect,
  }),
  useGripperState: () => mocks.state.current,
  useGripperCalibration: () => mocks.calib.current,
  useGripperAlerts: () => undefined,
}))

const { useGripperPanel } = await import('./useGripperPanel')

function ready(overrides: Record<string, unknown> = {}) {
  mocks.present.current = true
  mocks.status.current = 'connected'
  mocks.conn.current = {
    status: 'connected',
    channel: 'can0',
    canId: 8,
    mount: 'normal',
    declaredMount: 'normal',
    template: null,
    source: 'measured',
    path: '/tmp/cal.json',
    travelMm: 85,
    closedRad: 1.775959,
    openRad: -0.064279,
    fileRadToMm: 46.73,
    error: null,
    gate: 'READY',
    gateReason: '实测标定',
  }
  mocks.state.current = {
    positionMm: 12.5,
    forceN: 0,
    torqueNm: 0,
    velocityMmS: 0,
    enabled: true,
    state: 'holding',
    errorCode: 1,
    temps: { mosTemp: 30, coilTemp: 31 },
    fresh: true,
    gate: 'READY',
    gateReason: '实测标定',
    ...overrides,
  }
}

describe('useGripperPanel', () => {
  beforeEach(() => {
    window.localStorage.clear()
    ready()
    vi.clearAllMocks()
    mocks.moveTo.mockResolvedValue({ ok: true })
    mocks.setMotion.mockImplementation((p: { speedMmS?: number; forceN?: number }) =>
      Promise.resolve({ speedMmS: p.speedMmS ?? 50, forceN: p.forceN ?? 20 }),
    )
    for (const key of ['open', 'close', 'grasp', 'release', 'stop', 'resetStop', 'clearFault', 'enable', 'disable'] as const) {
      mocks[key].mockResolvedValue(null)
    }
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('allows every motion when the gate is READY and the drive is enabled', () => {
    const { result } = renderHook(() => useGripperPanel())
    expect(result.current.canControl).toBe(true)
    expect(result.current.canDirection).toBe(true)
    expect(result.current.disabledReason).toBe('')
  })

  it('refuses millimetre targets under a nominal template but allows open and close', () => {
    ready()
    mocks.conn.current = { ...mocks.conn.current, gate: 'TEMPLATE', source: 'template', mount: 'reverse' }
    mocks.state.current = { ...mocks.state.current, gate: 'TEMPLATE', gateReason: '标称模板（从未实测）' }

    const { result } = renderHook(() => useGripperPanel())
    expect(result.current.canControl).toBe(false)
    expect(result.current.canDirection).toBe(true)
    expect(result.current.gateAllows(true)).toBe(false)
    expect(result.current.gateAllows(false)).toBe(true)
  })

  it('explains why the controls are disabled instead of leaving them grey', () => {
    ready({ enabled: false, state: 'disabled' })
    const { result } = renderHook(() => useGripperPanel())
    expect(result.current.canControl).toBe(false)
    // 断言的是"说出了原因"，不是某一语言的措辞（i18n 语言由环境决定）。
    expect(result.current.disabledReason).toBe(i18n.t('common:errors.gripperNotEnabled'))
    // 夹爪的使能位与机械臂无关：一段夹爪自己的话，不是机械臂的 (#55)。
    expect(result.current.disabledReason).not.toBe(i18n.t('common:errors.notEnabled'))
    expect(result.current.disabledReason).not.toContain('机械臂')
    expect(result.current.disabledReason).not.toContain('Robot arm')
  })

  it('locks motion behind a latched stop and says so', () => {
    ready({ state: 'stopped', enabled: false })
    const { result } = renderHook(() => useGripperPanel())
    expect(result.current.estopped).toBe(true)
    expect(result.current.canControl).toBe(false)
    expect(result.current.disabledReason).toBe(i18n.t('common:errors.gripperEstopped'))
  })

  it('follows the device position while the user is not dragging', () => {
    const { result, rerender } = renderHook(() => useGripperPanel())
    expect(result.current.aperture).toBeCloseTo(12.5)
    act(() => {
      mocks.state.current = { ...mocks.state.current, positionMm: 30 }
    })
    rerender()
    expect(result.current.aperture).toBeCloseTo(30)
  })

  it('does not echo the device back into the slider while dragging', () => {
    const { result, rerender } = renderHook(() => useGripperPanel())
    act(() => {
      result.current.setDragging(true)
      result.current.setAperture(60)
      mocks.state.current = { ...mocks.state.current, positionMm: 12.5 }
    })
    rerender()
    expect(result.current.aperture).toBe(60)
  })

  it('commits an aperture move with the speed currently set', async () => {
    const { result } = renderHook(() => useGripperPanel())
    await act(async () => {
      result.current.commitAperture(40)
    })
    expect(mocks.moveTo).toHaveBeenCalledWith(40, expect.any(Number))
  })

  it('shows what the device reports after a motion-parameter write, not what was sent', async () => {
    mocks.setMotion.mockResolvedValue({ speedMmS: 25, forceN: 20 })
    const { result } = renderHook(() => useGripperPanel())
    await act(async () => {
      result.current.commitSpeed(120)
    })
    // 请求 120，daemon 回的是它真正生效的值 —— 显示后者。
    expect(mocks.setMotion).toHaveBeenCalledWith({ speedMmS: 120 })
    expect(result.current.speedMmS).toBe(25)
  })

  it('starts from the documented defaults (20 N, 50 mm/s) with no stored preference', () => {
    const { result } = renderHook(() => useGripperPanel())
    expect(result.current.forceN).toBe(20)
    expect(result.current.speedMmS).toBe(50)
  })

  it('survives a localStorage that throws instead of taking the whole page down', () => {
    // ⚠ 这三个偏好访问都在"挂载即执行"的路径上: 读是 `useState` 的惰性初始化, 写是
    // `useEffect` —— **两处的异常都会被错误边界接住**, 于是整页控制台被"页面渲染遇到
    // 异常"替换。真实桌面上就是这样。仓库里其它存储访问都做了防护, 只有这里漏了。
    const spy = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('SecurityError: localStorage is not available')
    })
    try {
      const { result } = renderHook(() => useGripperPanel())

      expect(result.current.forceN).toBe(20)
      expect(result.current.speedMmS).toBe(50)
    } finally {
      // 这个文件的 afterEach 只 clearAllMocks, 不还原 spy —— 不还原的话紧随其后的
      // beforeEach 会在 `localStorage.clear()` 上抛出。
      spy.mockRestore()
    }
  })

  it('stays quiet when the daemon has no gripper session at all', () => {
    mocks.present.current = false
    mocks.conn.current = null
    mocks.status.current = 'disconnected'
    mocks.state.current = null
    const { result } = renderHook(() => useGripperPanel())
    expect(result.current.present).toBe(false)
    // 这个构建形态（Windows、--no-gripper）只在控制页留一个离线的徽标，
    // 不再多写一段解释；设置页仍然说，因为那才是配置的地方。
    expect(result.current.disabledReason).toBe('')
  })
})

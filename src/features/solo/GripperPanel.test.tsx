import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import '@/i18n'

// vitest 未开 globals：RTL 的自动 cleanup 不会注册。
afterEach(cleanup)

// Radix 的 Slider 会量自己的宽度（`use-size`），jsdom 没有 ResizeObserver；
// 指针拖动还会用 Pointer Capture，jsdom 也没有实现。
beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  // Radix 的 Select 打开时会把当前项滚进视野; jsdom 没有这个方法。
  HTMLElement.prototype.scrollIntoView = () => {}
  HTMLElement.prototype.setPointerCapture = () => {}
  HTMLElement.prototype.releasePointerCapture = () => {}
  HTMLElement.prototype.hasPointerCapture = () => false
})

const mocks = vi.hoisted(() => {
  const conn = { current: null as Record<string, unknown> | null }
  const state = { current: null as Record<string, unknown> | null }
  const calib = { current: null as Record<string, unknown> | null }
  const status = { current: 'disconnected' as string }
  const present = { current: true }
  const channels = { current: ['can0'] as string[] }
  return {
    conn,
    state,
    calib,
    status,
    present,
    channels,
    open: vi.fn(),
    close: vi.fn(),
    grasp: vi.fn(),
    setZeroGravity: vi.fn(),
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
    setZeroGravity: mocks.setZeroGravity,
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
  useGripperChannels: () => ({ channels: mocks.channels.current, reload: vi.fn() }),
}))

const { GripperPanel } = await import('./GripperPanel')

function connected(overrides: { conn?: Record<string, unknown>; state?: Record<string, unknown> } = {}) {
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
    path: '/home/u/.litegrip/can0_calibration.json',
    travelMm: 85,
    closedRad: 1.775959,
    openRad: -0.064279,
    fileRadToMm: 46.73,
    error: null,
    gate: 'READY',
    gateReason: '实测标定',
    ...overrides.conn,
  }
  mocks.state.current = {
    positionMm: 41.2,
    forceN: 2.5,
    torqueNm: 0.25,
    velocityMmS: 0,
    enabled: true,
    state: 'holding',
    errorCode: 1,
    temps: { mosTemp: 31, coilTemp: 34 },
    fresh: true,
    gate: 'READY',
    gateReason: '实测标定',
    ...overrides.state,
  }
}

describe('GripperPanel', () => {
  beforeEach(() => {
    window.localStorage.clear()
    connected()
    vi.clearAllMocks()
    for (const key of [
      'open', 'close', 'grasp', 'setZeroGravity', 'stop', 'resetStop', 'clearFault', 'moveTo', 'setMotion',
    ] as const) {
      mocks[key].mockResolvedValue(null)
    }
  })

  it('renders the live readings and the calibration provenance', () => {
    render(<GripperPanel />)
    expect(screen.getByTestId('gripper-panel')).toBeTruthy()
    expect(screen.getByTestId('gripper-position').textContent).toContain('41.2')
    expect(screen.getByTestId('gripper-temps').textContent).toContain('MOS 31')
    expect(screen.getByTestId('gripper-source').textContent).toMatch(/Measured|实测/)
    expect(screen.getByTestId('gripper-gate').textContent).toMatch(/Ready|就绪/)
    // 标定卡片显示的是**具体数字**，不是一句"已标定"。
    expect(screen.getByText('1.7760')).toBeTruthy()
    expect(screen.getByText('-0.0643')).toBeTruthy()
  })

  it('offers the CAN channels and connects on the one the operator picked', () => {
    // 操作员在**这一页**驱动夹爪: 为了换一条 CAN 线跑回设置页、再回来重连, 是这里最没
    // 必要的一次往返。选了哪个通道, `gripper.connect` 就带哪个。
    mocks.status.current = 'disconnected'
    mocks.conn.current = null
    mocks.channels.current = ['can0', 'can1']
    render(<GripperPanel />)

    fireEvent.click(screen.getByTestId('gripper-panel-channel'))
    fireEvent.click(screen.getByRole('option', { name: 'can1' }))
    fireEvent.click(screen.getByTestId('gripper-connect'))

    expect(mocks.connect).toHaveBeenCalledWith({ channel: 'can1' })
  })

  it('locks the channel picker while the gripper is connected, and says why', () => {
    // daemon 会拒"连着的时候改通道/ID" (`_cmd_connect`), 所以这里放开只会让操作员撞
    // 一条拒绝; 锁住的同时必须把原因说出来。
    connected()
    render(<GripperPanel />)

    const picker = screen.getByTestId('gripper-panel-channel') as HTMLButtonElement
    expect(picker.disabled).toBe(true)
    expect(picker.getAttribute('title')).toMatch(/Disconnect|断开/)
  })

  it('lets the operator drive the gripper when the gate is ready', () => {
    render(<GripperPanel />)
    fireEvent.click(screen.getByTestId('gripper-open'))
    fireEvent.click(screen.getByTestId('gripper-close'))
    fireEvent.click(screen.getByTestId('gripper-grasp'))
    // 零重力是开关：没在零重力里时按下去, 发的是「进入」(`on:true`)。
    fireEvent.click(screen.getByTestId('gripper-release'))
    expect(mocks.open).toHaveBeenCalledTimes(1)
    expect(mocks.close).toHaveBeenCalledTimes(1)
    expect(mocks.grasp).toHaveBeenCalledTimes(1)
    expect(mocks.setZeroGravity).toHaveBeenCalledWith(true)
  })

  it('shows the zero-gravity state the daemon reports, and clears it when the axis moves again', () => {
    // 零重力是 daemon 的 `state:"released"` (`MotionState.RELEASE`), 不是界面猜的:
    // 按钮亮起、多出一条标识，进入时弹一条提示。
    connected({ state: { state: 'released' } })
    const { rerender } = render(<GripperPanel />)
    expect(screen.getByTestId('gripper-zero-gravity').textContent).toMatch(/Zero gravity|零重力/)
    expect((screen.getByTestId('gripper-release') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true')
    expect(toast.success).toHaveBeenCalled()

    // 在零重力里再按一下 = **退出**: 发的是 `on:false`（daemon 会 hold 住当前姿态）。
    fireEvent.click(screen.getByTestId('gripper-release'))
    expect(mocks.setZeroGravity).toHaveBeenCalledWith(false)

    // 一次运动把它带回位置控制: 标识必须消失，按钮回到未按下态。
    connected({ state: { state: 'moving' } })
    rerender(<GripperPanel />)
    expect(screen.queryByTestId('gripper-zero-gravity')).toBeNull()
    expect((screen.getByTestId('gripper-release') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('false')
  })

  it('disables millimetre targets under a nominal template and explains why', () => {
    connected({
      conn: { gate: 'TEMPLATE', source: 'template', template: 'normal', mount: 'reverse', declaredMount: 'reverse' },
      state: { gate: 'TEMPLATE', gateReason: '标称模板（从未实测）' },
    })
    render(<GripperPanel />)
    expect((screen.getByTestId('gripper-grasp') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('gripper-open') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByTestId('gripper-close') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByTestId('gripper-disabled-reason').textContent).toBeTruthy()
    // "从未实测" 必须看得见，而不是暗示（§6.3）。
    expect(screen.getByTestId('gripper-source').textContent).toMatch(/never measured|从未实测/)
  })

  it('disables everything behind a blocked gate', () => {
    connected({
      conn: { gate: 'BLOCKED', source: 'missing', path: null, closedRad: null, openRad: null },
      state: { gate: 'BLOCKED', gateReason: '未找到任何标定文件' },
    })
    render(<GripperPanel />)
    for (const id of ['gripper-open', 'gripper-close', 'gripper-grasp']) {
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(true)
    }
    expect(screen.getByTestId('gripper-disabled-reason').textContent).toBeTruthy()
  })

  it('does not cry "no calibration" before the gripper is even connected', () => {
    // daemon 在**没连上**时也会推一帧 `gripper_conn`: source 为 null、gate 是占位的
    // `BLOCKED`（reason 是"后端尚未报告标定信息"）。把这份占位渲染成
    // "已阻断 / 没有可用标定"，会让一个完全正常的空闲面板看着像坏了。
    mocks.present.current = true
    mocks.status.current = 'disconnected'
    mocks.conn.current = {
      status: 'disconnected',
      channel: 'can0',
      canId: 8,
      mount: 'normal',
      declaredMount: 'normal',
      template: null,
      source: null,
      path: null,
      travelMm: 85,
      closedRad: null,
      openRad: null,
      fileRadToMm: null,
      error: null,
      gate: 'BLOCKED',
      gateReason: '后端尚未报告标定信息；运动已禁止',
    }
    mocks.state.current = null
    render(<GripperPanel />)
    expect(screen.queryByTestId('gripper-gate')).toBeNull()
    expect(screen.queryByText(/No usable calibration|没有可用标定/)).toBeNull()
    // "未连接" 仍然由禁用原因说清楚，不是把这个提示也一并吞掉。
    expect(screen.getByTestId('gripper-disabled-reason').textContent).toMatch(/Disconnected|未连接/)
  })

  it('keeps the stop reachable while a move is running, and offers reset once latched', () => {
    connected({ state: { state: 'moving', positionMm: 30 } })
    const { rerender } = render(<GripperPanel />)
    expect((screen.getByTestId('gripper-stop') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByTestId('gripper-reset-stop') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('gripper-stop'))
    expect(mocks.stop).toHaveBeenCalledTimes(1)

    connected({ state: { state: 'stopped', enabled: false } })
    rerender(<GripperPanel />)
    expect((screen.getByTestId('gripper-reset-stop') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByTestId('gripper-open') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('gripper-reset-stop'))
    expect(mocks.resetStop).toHaveBeenCalledTimes(1)
  })

  it('leaves the panel inert when the daemon has no gripper session', () => {
    mocks.present.current = false
    mocks.conn.current = null
    mocks.status.current = 'disconnected'
    mocks.state.current = null
    render(<GripperPanel />)
    expect((screen.getByTestId('gripper-connect') as HTMLButtonElement).disabled).toBe(true)
    // 状态徽标已经说了"离线"，不再为这个构建形态多写一段解释。
    expect(screen.getByTestId('gripper-status').textContent).toMatch(/offline|离线/)
    expect(screen.queryByTestId('gripper-disabled-reason')).toBeNull()
  })

  it('shows an unknown position as unknown rather than as zero', () => {
    connected({ state: { positionMm: null, enabled: false, state: 'disabled' } })
    render(<GripperPanel />)
    expect(screen.getByTestId('gripper-position').textContent).toContain('--')
  })

  it('does not echo the device position back into the slider while dragging', () => {
    const { container, rerender } = render(<GripperPanel />)
    // aria-label 挂在 Slider.Root 上，aria-valuenow 在它的 Thumb 上。
    const thumb = () => container.querySelector<HTMLElement>('#gripper-aperture [role="slider"]')!
    fireEvent.focus(thumb())
    expect(thumb().getAttribute('aria-valuenow')).toBe('41.2')

    // 按住滑块：拖动开始（指针按下），位置由手指决定。
    fireEvent.pointerDown(thumb())
    fireEvent.keyDown(thumb(), { key: 'ArrowRight' })
    fireEvent.keyUp(thumb(), { key: 'ArrowRight' })
    // 拖动期间设备报 10，滑块必须停在手指拖到的 42，而不是被拽回去（§6.3）。
    connected({ state: { positionMm: 10 } })
    rerender(<GripperPanel />)
    expect(thumb().getAttribute('aria-valuenow')).toBe('42')

    // 松手之后回读生效：这一刻设备报的是 10，滑块被拉回 10。
    fireEvent.pointerUp(thumb())
    rerender(<GripperPanel />)
    expect(thumb().getAttribute('aria-valuenow')).toBe('10')
  })
})

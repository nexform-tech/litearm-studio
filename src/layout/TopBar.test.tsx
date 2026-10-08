import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'

afterEach(cleanup)

// Radix 的 Select 会量自己的宽度（`use-size`），指针交互还要 Pointer Capture ——
// jsdom 两样都没有。
beforeAll(() => {
  // jsdom 没有 PointerEvent: 不顶上的话 `fireEvent.pointerDown` 造出来的是没有 `button`
  // 的普通 Event, 而 Radix 的内部判据要看它。
  vi.stubGlobal('PointerEvent', MouseEvent)
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  HTMLElement.prototype.setPointerCapture = () => {}
  HTMLElement.prototype.releasePointerCapture = () => {}
  HTMLElement.prototype.hasPointerCapture = () => false
  HTMLElement.prototype.scrollIntoView = () => {}
})

const mocks = vi.hoisted(() => ({
  status: { current: 'disconnected' as string },
  conn: { current: null as Record<string, unknown> | null },
  ports: { current: [] as string[] },
  // 顶栏右侧的状态读数全部来自这一帧 —— 测试要能给它换值。
  armState: { current: null as Record<string, unknown> | null },
  reload: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}))

vi.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: '/control' }) }))

vi.mock('@/lib/arm', () => ({
  useArmConnection: () => ({
    status: mocks.status.current,
    conn: mocks.conn.current,
    motionBusy: false,
    lastError: null,
    connectError: null,
    connect: mocks.connect,
    disconnect: mocks.disconnect,
    requestStop: vi.fn(),
  }),
  useArmState: () => mocks.armState.current,
  useArmPorts: () => ({
    ports: mocks.ports.current,
    loading: false,
    error: null,
    reload: mocks.reload,
  }),
}))

const { TopBar } = await import('./TopBar')

const trigger = () => screen.getByTestId('topbar-port')
const connectButton = () => screen.getByRole('button', { name: /连接|Connect/ })

/** 打开下拉 —— Radix 在 jsdom 里只有 click 这一条路能真的把列表挂出来。 */
function openPicker() {
  fireEvent.click(trigger())
}

/** 打开下拉并点中某一项。 */
function pick(option: string | RegExp) {
  openPicker()
  fireEvent.click(screen.getByRole('option', { name: option }))
}

describe('TopBar port picker', () => {
  beforeEach(() => {
    mocks.status.current = 'disconnected'
    mocks.conn.current = null
    mocks.ports.current = ['/dev/ttyACM0', '/dev/ttyUSB0']
    mocks.armState.current = null
    vi.clearAllMocks()
  })

  it('connects on the port the operator picked, not on whatever discovery would find', () => {
    // ⚠ 这是这个功能的全部要点: 界面上选了哪个口, daemon 就只连哪个口。
    render(<TopBar />)

    pick('/dev/ttyUSB0')
    fireEvent.click(connectButton())

    expect(mocks.connect).toHaveBeenCalledWith('/dev/ttyUSB0')
  })

  it('sends no port at all when Auto-detect is selected', () => {
    // 没有 port 才是"交给 daemon 自己按顺序解析" —— 发空串会被当成"明确指出一个空路径"。
    render(<TopBar />)

    pick('/dev/ttyUSB0')
    expect(mocks.connect).not.toHaveBeenCalled()
    pick(/自动发现|Auto-detect/)

    fireEvent.click(connectButton())
    expect(mocks.connect).toHaveBeenCalledWith(undefined)
  })

  it('re-enumerates when the dropdown is opened', () => {
    render(<TopBar />)
    expect(mocks.reload).not.toHaveBeenCalled()

    openPicker()
    expect(mocks.reload).toHaveBeenCalled()
  })

  it('locks the picker while an arm is connected, and shows the port it resolved to', () => {
    // 换口必须先断开 (daemon 也会拒绝在途改口), 所以连着的时候这个下拉不该可点。
    mocks.status.current = 'connected'
    mocks.conn.current = { port: '/dev/ttyACM0', firmware: 'Litearm1.8.0-7J' }
    render(<TopBar />)

    expect(trigger().hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/\/dev\/ttyACM0 · Litearm1\.8\.0-7J/)).toBeTruthy()
  })

  it('keeps the picked port for a retry after a failed connect', () => {
    // 连不上之后操作员会再点一次「连接」—— 那一次必须还是**同一个口**。否则他以为在
    // 重试, 实际连的是自动发现到的另一台; 更糟的是下拉可能已经变回「自动发现」, 于是
    // 屏幕上没有任何东西说明这次连的是哪台。
    mocks.status.current = 'error'
    render(<TopBar />)

    pick('/dev/ttyUSB0')
    fireEvent.click(connectButton())
    fireEvent.click(connectButton())

    expect(mocks.connect).toHaveBeenNthCalledWith(1, '/dev/ttyUSB0')
    expect(mocks.connect).toHaveBeenNthCalledWith(2, '/dev/ttyUSB0')
    expect(trigger().textContent).toContain('/dev/ttyUSB0')
  })
})

describe('TopBar live arm state', () => {
  beforeEach(() => {
    mocks.status.current = 'connected'
    mocks.conn.current = { port: '/dev/ttyACM0', firmware: 'Litearm1.8.0-7J' }
    mocks.ports.current = []
    mocks.armState.current = null
  })

  it('reads enable and run state off the broadcast state frame', () => {
    mocks.armState.current = { enabled: true, state: 'zero_gravity', errs: [0, 0] }
    render(<TopBar />)

    expect(screen.getByText(i18n.t('common:armEnable'))).toBeDefined()
    expect(screen.getByText(i18n.t('common:enabled'))).toBeDefined()
    expect(screen.getByText(i18n.t('common:runState'))).toBeDefined()
    expect(screen.getByText(i18n.t('common:zeroGravity'))).toBeDefined()
  })

  it('shows dashes, not a constant, before the first state frame arrives', () => {
    render(<TopBar />)

    // 曾经的「控制频率 250 Hz」一帧状态都不需要就写在界面上 —— 那正是这次拿掉的东西:
    // 顶栏里的每个数字都必须来自设备。
    expect(screen.queryByText('250')).toBeNull()
    expect(screen.queryByText(i18n.t('common:enabled'))).toBeNull()
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2)
  })

  it('prints a state string it does not know verbatim', () => {
    // 固件加了新状态时, 让操作员看到固件真正说的那个词, 而不是一句我们猜的翻译。
    mocks.armState.current = { enabled: false, state: 'calibrating_j2', errs: [] }
    render(<TopBar />)

    expect(screen.getByText('calibrating_j2')).toBeDefined()
    expect(screen.getByText(i18n.t('common:disabled'))).toBeDefined()
  })

  it('keeps the fault readout next to the two new ones', () => {
    mocks.armState.current = { enabled: true, state: 'fault', errs: [8] }
    render(<TopBar />)

    // 故障时运行状态与故障读数的**值**是同一个词（「故障」/“Fault”），所以这里命中两处：
    // 一处是运行状态的值、一处是「故障」这一项的标题。
    expect(screen.getAllByText(i18n.t('common:faultStatus')).length).toBe(2)
    expect(screen.getByText(i18n.t('common:hasFault'))).toBeDefined()
  })
})

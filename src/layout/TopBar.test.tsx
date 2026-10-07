import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'

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
    connect: mocks.connect,
    disconnect: mocks.disconnect,
    requestStop: vi.fn(),
  }),
  useArmState: () => null,
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

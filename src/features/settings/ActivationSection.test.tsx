import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'

afterEach(cleanup)

const mocks = vi.hoisted(() => ({
  connected: { current: true },
  snapshot: { current: null as unknown },
  loading: { current: false },
  error: { current: null as string | null },
  refresh: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}))

vi.mock('./useActivation', () => ({
  useActivation: () => ({
    connected: mocks.connected.current,
    snapshot: mocks.snapshot.current,
    loading: mocks.loading.current,
    error: mocks.error.current,
    refresh: mocks.refresh,
  }),
}))

const { ActivationSection } = await import('./ActivationSection')
const { toast } = await import('sonner')

const RECORD = {
  supported: true as const,
  state: 1,
  stateName: 'activated',
  activated: true,
  factoryMode: false,
  ver: 1,
  uid: '101112131415161718191a1b',
  custId: 1042,
  issued: 20260929,
  flags: 0,
}

function setClipboard(writeText: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value: writeText, configurable: true })
}

describe('ActivationSection', () => {
  beforeEach(() => {
    mocks.connected.current = true
    mocks.snapshot.current = null
    mocks.loading.current = false
    mocks.error.current = null
    vi.clearAllMocks()
    setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) })
  })

  it('shows the device UID and the next step when the arm is not activated', () => {
    mocks.snapshot.current = { ...RECORD, state: 0, stateName: 'not_activated', activated: false, custId: 0, issued: 0 }
    render(<ActivationSection />)

    expect(screen.getByTestId('activation-status').textContent).toMatch(/未激活|Not activated/)
    // ⚠ UID 是这一段唯一的交付物 —— **未激活也必须显示**（签发凭据全靠它）。
    expect(screen.getByTestId('activation-uid').textContent).toBe('101112131415161718191a1b')
    // 未激活要说清"下一步做什么"，而不是只报一个状态（提示可能出现多处）。
    expect(screen.getAllByText(/供应商|supplier/i).length).toBeGreaterThan(0)
  })

  it('shows the licence details once activated', () => {
    mocks.snapshot.current = RECORD
    render(<ActivationSection />)

    expect(screen.getByTestId('activation-status').textContent).toMatch(/已激活|Activated/)
    expect(screen.getByTestId('activation-uid').textContent).toBe('101112131415161718191a1b')
    expect(screen.getByText('1042')).toBeTruthy()
    // 签发日按 YYYY-MM-DD 显示（固件给的是 20260929）。
    expect(screen.getByText('2026-09-29')).toBeTruthy()
  })

  it('keeps "the firmware has no such command" apart from "not read this time"', () => {
    mocks.snapshot.current = { supported: false }
    const { unmount } = render(<ActivationSection />)
    expect(screen.getByTestId('activation-status').textContent).toMatch(/固件不支持|Not supported/)
    expect(screen.getByText(/1\.8\.0/)).toBeTruthy()
    unmount()

    mocks.snapshot.current = { supported: null }
    render(<ActivationSection />)
    expect(screen.getByTestId('activation-status').textContent).toMatch(/读不到|Unreadable/)
  })

  it('says so instead of showing a stale record when no arm is connected', () => {
    mocks.connected.current = false
    render(<ActivationSection />)

    expect(screen.getByTestId('activation-status').textContent).toMatch(/离线|offline/i)
    expect(screen.queryByTestId('activation-uid')).toBeNull()
  })

  it('surfaces a read failure and still offers a retry', async () => {
    mocks.error.current = '与机械臂的通信失败'
    render(<ActivationSection />)

    expect(screen.getByTestId('activation-status').textContent).toMatch(/读不到|Unreadable/)
    expect(screen.getByText('与机械臂的通信失败')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /刷新|Refresh/ }))
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled())
  })

  it('copies the UID, and reports a copy failure instead of failing silently', async () => {
    mocks.snapshot.current = RECORD
    render(<ActivationSection />)

    fireEvent.click(screen.getByRole('button', { name: /复制|Copy/ }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())

    // 剪贴板不可用（http 非安全上下文、jsdom 等）时必须**报出来** —— 静默失败等于让
    // 操作员以为复制好了，实际交出去的是上次的旧 UID。
    setClipboard(undefined)
    fireEvent.click(screen.getByRole('button', { name: /复制|Copy/ }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
  })
})

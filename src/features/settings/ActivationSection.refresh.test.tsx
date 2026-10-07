import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'

afterEach(cleanup)

const mocks = vi.hoisted(() => ({
  license: vi.fn(),
  activate: vi.fn(),
  armState: { current: null as unknown },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}))

// ⚠ 这里刻意**不** mock `./useActivation`：本条用例要测的正是 hook 与面板之间的接缝。
//   旧实现里 hook 无条件用 `{supported: null}` 覆盖快照，面板再从快照推记录，于是"设备没
//   应答"这一条 —— 命令成功、不带任何错误 —— 会把 UID 和整个记录块从屏幕上抹掉。两层各自
//   的单测都盖不住这个空洞：hook 单测看不见渲染，面板单测喂的是 mock 出来的 hook 返回值。
vi.mock('@/lib/arm', () => ({
  armClient: { license: mocks.license, activate: mocks.activate, versions: { daemon: '0.1.0', sdk: '2.1.0' } },
  useArmConnection: () => ({ conn: { firmware: 'Litearm1.8.0-7J' }, status: 'connected' }),
  useArmState: () => mocks.armState.current,
  formatArmError: (err: unknown) => String((err as Error)?.message ?? err),
}))

const { ActivationSection } = await import('./ActivationSection')

const UID = '101112131415161718191a1b'

const RECORD = {
  supported: true as const,
  state: 1,
  stateName: 'activated',
  activated: true,
  factoryMode: false,
  ver: 1,
  uid: UID,
  custId: 1042,
  issued: 20260929,
  flags: 0,
}

const refreshButton = () => screen.getByRole('button', { name: /刷新|Refresh/ })

describe('ActivationSection after a refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.license.mockResolvedValue(RECORD)
    mocks.armState.current = null
  })

  it('keeps the UID and marks it stale when the device does not answer', async () => {
    render(<ActivationSection />)
    await waitFor(() => expect(screen.getByTestId('activation-uid').textContent).toBe(UID))
    expect(screen.queryByTestId('activation-stale')).toBeNull()

    // 设备不应答：daemon 把 `MotionTimeoutError` 吞成 `{supported: null}` 且应答 `ok: true`，
    // 所以界面上**没有**任何错误可看 —— 旧读数标记是唯一能说明"这不是刚读到的"的东西。
    mocks.license.mockResolvedValue({ supported: null })
    fireEvent.click(refreshButton())

    await waitFor(() => expect(screen.getByTestId('activation-stale')).toBeTruthy())
    expect(screen.getByTestId('activation-uid').textContent).toBe(UID)
    expect(screen.getByTestId('activation-status').textContent).toMatch(/读不到|Unreadable/)
  })

  it('drops the stale mark and updates the record once the device answers again', async () => {
    render(<ActivationSection />)
    await waitFor(() => expect(screen.getByTestId('activation-uid').textContent).toBe(UID))

    mocks.license.mockResolvedValue({ supported: null })
    fireEvent.click(refreshButton())
    await waitFor(() => expect(screen.getByTestId('activation-stale')).toBeTruthy())

    mocks.license.mockResolvedValue({ ...RECORD, activated: false, state: 0, custId: 0, issued: 0 })
    fireEvent.click(refreshButton())

    await waitFor(() => expect(screen.queryByTestId('activation-stale')).toBeNull())
    expect(screen.getByTestId('activation-uid').textContent).toBe(UID)
    expect(screen.getByTestId('activation-status').textContent).toMatch(/未激活|Not activated/)
  })

  it('shows only the "could not read" hint when there is no earlier record to keep', async () => {
    // 没有旧记录时不能凭空造一条 —— 只能照实说这次没读到。
    mocks.license.mockResolvedValue({ supported: null })
    render(<ActivationSection />)

    await waitFor(() =>
      expect(screen.getByTestId('activation-status').textContent).toMatch(/读不到|Unreadable/),
    )
    expect(screen.queryByTestId('activation-uid')).toBeNull()
    expect(screen.queryByTestId('activation-stale')).toBeNull()
  })
})

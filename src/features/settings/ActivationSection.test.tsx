import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'

afterEach(cleanup)

const mocks = vi.hoisted(() => ({
  connected: { current: true },
  snapshot: { current: null as unknown },
  loading: { current: false },
  submitting: { current: false },
  error: { current: null as string | null },
  armState: { current: null as unknown },
  refresh: vi.fn(),
  submit: vi.fn(),
  importLicense: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}))

vi.mock('@/lib/arm', () => ({
  armClient: { versions: { daemon: '0.1.0', sdk: '2.1.0' } },
  useArmConnection: () => ({ conn: { firmware: 'Litearm1.8.0-7J' }, status: 'connected' }),
  useArmState: () => mocks.armState.current,
  formatArmError: (err: unknown) => String((err as Error)?.message ?? err),
}))

vi.mock('./useActivation', () => ({
  useActivation: () => ({
    connected: mocks.connected.current,
    snapshot: mocks.snapshot.current,
    loading: mocks.loading.current,
    submitting: mocks.submitting.current,
    error: mocks.error.current,
    refresh: mocks.refresh,
    submit: mocks.submit,
    importLicense: mocks.importLicense,
  }),
}))

const { ActivationSection } = await import('./ActivationSection')
const { toast } = await import('sonner')

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

const LOCKED = {
  ...RECORD,
  state: 0,
  stateName: 'not_activated',
  activated: false,
  custId: 0,
  issued: 0,
}

function setClipboard(writeText: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value: writeText, configurable: true })
}

/** 填满必填项并勾选同意 —— 让提交按钮变得可用。 */
function fillForm() {
  fireEvent.change(screen.getByTestId('activation-name'), { target: { value: '张三' } })
  fireEvent.change(screen.getByTestId('activation-organization'), { target: { value: '某大学' } })
  fireEvent.change(screen.getByTestId('activation-email'), { target: { value: 'z@example.com' } })
  fireEvent.click(screen.getByTestId('activation-consent-required'))
}

const submitButton = () => screen.getByTestId('activation-submit') as HTMLButtonElement

describe('ActivationSection', () => {
  beforeEach(() => {
    mocks.connected.current = true
    mocks.snapshot.current = null
    mocks.loading.current = false
    mocks.submitting.current = false
    mocks.error.current = null
    mocks.armState.current = null
    vi.clearAllMocks()
    setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) })
  })

  it('shows the device UID and the next step when the arm is not activated', () => {
    mocks.snapshot.current = LOCKED
    render(<ActivationSection />)

    expect(screen.getByTestId('activation-status').textContent).toMatch(/未激活|Not activated/)
    // ⚠ UID 是这一段唯一的交付物 —— **未激活也必须显示**（签发凭据全靠它）。
    expect(screen.getByTestId('activation-uid').textContent).toBe(UID)
    // 未激活要说清"下一步做什么"，而不是只报一个状态（提示可能出现多处）。
    expect(screen.getAllByText(/供应商|supplier/i).length).toBeGreaterThan(0)
  })

  it('shows the licence details once activated, and no signup form', () => {
    mocks.snapshot.current = RECORD
    render(<ActivationSection />)

    expect(screen.getByTestId('activation-status').textContent).toMatch(/已激活|Activated/)
    expect(screen.getByTestId('activation-uid').textContent).toBe(UID)
    expect(screen.getByText('1042')).toBeTruthy()
    // 签发日按 YYYY-MM-DD 显示（固件给的是 20260929）。
    expect(screen.getByText('2026-09-29')).toBeTruthy()
    // 已激活就不该再出现注册表单：摆在那儿只会让人误点。
    expect(screen.queryByTestId('activation-submit')).toBeNull()
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

  it('keeps submit disabled until consent is ticked and the required fields are filled', () => {
    mocks.snapshot.current = LOCKED
    render(<ActivationSection />)

    expect(submitButton().disabled).toBe(true)

    fireEvent.change(screen.getByTestId('activation-name'), { target: { value: '张三' } })
    fireEvent.change(screen.getByTestId('activation-organization'), { target: { value: '某大学' } })
    fireEvent.change(screen.getByTestId('activation-email'), { target: { value: 'z@example.com' } })
    // 必填都填了，但**没同意** -> 仍然不能提交（同意是硬门禁，界面只是提前拦住）。
    expect(submitButton().disabled).toBe(true)

    fireEvent.click(screen.getByTestId('activation-consent-required'))
    expect(submitButton().disabled).toBe(false)
  })

  it('submits exactly the body the operator was shown', () => {
    mocks.snapshot.current = LOCKED
    render(<ActivationSection />)
    fillForm()

    const preview = JSON.parse(screen.getByTestId('activation-preview').textContent ?? '{}')
    expect(preview.uid).toBe(UID)
    expect(preview.contact).toEqual({
      name: '张三',
      organization: '某大学',
      email: 'z@example.com',
      phone: '',
    })
    // 隐私政策要能点开，且指向服务站点。
    expect(
      screen.getByRole('link', { name: /隐私政策|Privacy policy/ }).getAttribute('href'),
    ).toBe('https://act.nexform.tech/privacy')

    fireEvent.click(submitButton())
    // ⚠ 逐字相同：预览里显示的字段 == 发出去的字段。暗字段在这条用例下无处可藏。
    expect(mocks.submit).toHaveBeenCalledWith(preview)
  })

  it('adds the version block to the preview only when diagnostics are agreed to', () => {
    mocks.snapshot.current = LOCKED
    render(<ActivationSection />)
    fillForm()

    expect(screen.getByTestId('activation-preview').textContent).not.toContain('firmware')
    fireEvent.click(screen.getByTestId('activation-consent-diagnostics'))
    expect(screen.getByTestId('activation-preview').textContent).toContain('Litearm1.8.0-7J')
  })

  it('refuses to write while the arm is enabled, and says why', () => {
    mocks.snapshot.current = LOCKED
    mocks.armState.current = { enabled: true }
    render(<ActivationSection />)
    fillForm()

    expect(submitButton().disabled).toBe(true)
    expect(screen.getByText(/失能|Disable first/)).toBeTruthy()
  })

  it('imports a licence file through the daemon (the offline path)', async () => {
    mocks.snapshot.current = LOCKED
    render(<ActivationSection />)

    const text = JSON.stringify({ format: 1, uid: UID })
    const file = { text: () => Promise.resolve(text) } as unknown as File
    fireEvent.change(screen.getByTestId('activation-file'), { target: { files: [file] } })

    await waitFor(() => expect(mocks.importLicense).toHaveBeenCalledWith(text))
    // 离线那条路不许碰网络（`submit` 是唯一出网的动作）。
    expect(mocks.submit).not.toHaveBeenCalled()
  })
})

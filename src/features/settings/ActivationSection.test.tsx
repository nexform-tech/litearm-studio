import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

/** 填满**必填项**（与激活网站的表单同集：姓名、手机号、单位、邮箱、所在地区）。 */
function fillContact() {
  fireEvent.change(screen.getByTestId('activation-name'), { target: { value: '张三' } })
  fireEvent.change(screen.getByTestId('activation-phone'), { target: { value: '13800000000' } })
  fireEvent.change(screen.getByTestId('activation-organization'), { target: { value: '某大学' } })
  fireEvent.change(screen.getByTestId('activation-email'), { target: { value: 'z@example.com' } })
  fireEvent.change(screen.getByTestId('activation-region'), { target: { value: '上海' } })
}

function fillForm() {
  fillContact()
  fireEvent.click(screen.getByTestId('activation-consent'))
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

  it('keeps submit disabled until consent is ticked and every required field is filled', () => {
    mocks.snapshot.current = LOCKED
    render(<ActivationSection />)

    expect(submitButton().disabled).toBe(true)
    // 必填与否由按钮的可用状态拦，不靠 HTML 的 required（这里没有浏览器表单提交）。
    expect((screen.getByTestId('activation-phone') as HTMLInputElement).required).toBe(false)

    fireEvent.change(screen.getByTestId('activation-name'), { target: { value: '张三' } })
    fireEvent.change(screen.getByTestId('activation-phone'), { target: { value: '13800000000' } })
    fireEvent.change(screen.getByTestId('activation-organization'), { target: { value: '某大学' } })
    fireEvent.change(screen.getByTestId('activation-email'), { target: { value: 'z@example.com' } })
    // ⚠ 所在地区是必填（网站上它就是必填）：少它一个就不能提交。
    expect(submitButton().disabled).toBe(true)

    fireEvent.change(screen.getByTestId('activation-region'), { target: { value: '上海' } })
    // 必填都填了，但**没同意** -> 仍然不能提交（同意是硬门禁，界面只是提前拦住）。
    expect(submitButton().disabled).toBe(true)

    fireEvent.click(screen.getByTestId('activation-consent'))
    expect(submitButton().disabled).toBe(false)
  })

  it('refuses a value the website form would reject, and says which field it is', () => {
    mocks.snapshot.current = LOCKED
    render(<ActivationSection />)
    fillForm()

    fireEvent.change(screen.getByTestId('activation-phone'), { target: { value: '1380000' } })
    expect(submitButton().disabled).toBe(true)
    expect(screen.getByTestId('activation-invalid').textContent).toMatch(/11 位|11-digit/)

    // 改对之后又能提交 —— 拦的是值，不是这个人。
    fireEvent.change(screen.getByTestId('activation-phone'), { target: { value: '13800000000' } })
    expect(screen.queryByTestId('activation-invalid')).toBeNull()
    expect(submitButton().disabled).toBe(false)
  })

  it('submits the consented body and shows no raw request preview', () => {
    mocks.snapshot.current = LOCKED
    render(<ActivationSection />)
    fillForm()

    // 「将要发送的内容」按需求去掉了 —— 采集内容改由同意书逐项列出。
    expect(screen.queryByTestId('activation-preview')).toBeNull()

    fireEvent.click(submitButton())
    expect(mocks.submit).toHaveBeenCalledWith({
      uid: UID,
      // 八个字段与激活网站的表单同集；选填的没填就是空串。
      contact: {
        name: '张三',
        phone: '13800000000',
        organization: '某大学',
        wechatId: '',
        email: 'z@example.com',
        region: '上海',
        industry: '',
        purpose: '',
      },
      consent: { granted: true },
      // 版本信息与联系人字段在**同一份**同意书里，所以一起发。
      diagnostics: { studio: '0.1.0', sdk: '2.1.0', firmware: 'Litearm1.8.0-7J' },
    })
  })

  it('spells out every item the request carries inside the consent document', () => {
    mocks.snapshot.current = LOCKED
    render(<ActivationSection />)

    // 同意书默认关着，点开才看。
    expect(screen.queryByTestId('activation-consent-dialog')).toBeNull()
    fireEvent.click(screen.getByTestId('activation-consent-open'))

    const dialog = screen.getByTestId('activation-consent-dialog')
    const items = within(dialog).getAllByRole('listitem')
    // 逐项列出：联系人与微信号、地区/行业/用途、设备 UID、版本。
    expect(items).toHaveLength(4)
    expect(dialog.textContent).toMatch(/姓名|Name/)
    expect(dialog.textContent).toMatch(/微信号|WeChat ID/)
    expect(dialog.textContent).toMatch(/用途说明|purpose/i)
    expect(dialog.textContent).toMatch(/设备 UID|Device UID/)
    expect(dialog.textContent).toMatch(/版本|versions/)
    // ⚠ IP 由服务端自己记，不属于"上位机发出去的字段"：列在这里会被读成"我们在采集"。
    expect(dialog.textContent).not.toMatch(/来源 IP|Source IP/)
    // 文档名说的是激活注册信息（发送什么），不是信息收集。
    expect(dialog.textContent).not.toMatch(/信息收集|Information Collection/)
    // 隐私政策要能点开，且指向服务站点。
    expect(
      within(dialog).getByRole('link', { name: /隐私政策|Privacy policy/ }).getAttribute('href'),
    ).toBe('https://act.nexform.tech/privacy')
  })

  it('ticks the box from inside the consent document', () => {
    mocks.snapshot.current = LOCKED
    render(<ActivationSection />)
    fillContact()

    expect(submitButton().disabled).toBe(true)
    fireEvent.click(screen.getByTestId('activation-consent-open'))
    fireEvent.click(screen.getByTestId('activation-consent-agree'))

    // 「同意」既勾上复选框又关掉弹窗；于是按钮变亮。
    expect((screen.getByTestId('activation-consent') as HTMLInputElement).checked).toBe(true)
    expect(screen.queryByTestId('activation-consent-dialog')).toBeNull()
    expect(submitButton().disabled).toBe(false)
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

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'

/**
 * 这一份钉的是「安装方向」页签**看得懂、点得动、发得对**：
 * 预设填的是哪三个数（m/s²，不是单位向量）、rpy 与向量的关系、以及"须失能"这条门禁。
 * 换算本身的判据在 `installationPose.test.ts`，这里只看界面。
 */
afterEach(() => {
  cleanup()
  // 弹窗的桩必须还原：漏一个 `window.confirm` 就会让后面每条用例都静默"确认"。
  vi.restoreAllMocks()
})

const mocks = vi.hoisted(() => ({
  readPayload: vi.fn(),
  setPayload: vi.fn(),
  readGravityVector: vi.fn(),
  setGravityVector: vi.fn(),
  getGravity: vi.fn(),
  getJointParams: vi.fn(),
  saveParams: vi.fn(),
  resetFactoryParams: vi.fn(),
  kinBench: vi.fn(),
  /** daemon 的使能位 —— 「下发（须失能）」该不该灰掉看它。 */
  enabled: false,
  /** 状态帧到没到手：`null` = 状态未知（与"失能"是两件事）。 */
  state: null as { q: number[]; enabled: boolean } | null,
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/arm', () => ({
  armClient: {
    readPayload: mocks.readPayload,
    setPayload: mocks.setPayload,
    readGravityVector: mocks.readGravityVector,
    setGravityVector: mocks.setGravityVector,
    getGravity: mocks.getGravity,
    getJointParams: mocks.getJointParams,
    setJointParam: vi.fn(),
    setJointLimits: vi.fn(),
    saveParams: mocks.saveParams,
    resetFactoryParams: mocks.resetFactoryParams,
    kinBench: mocks.kinBench,
  },
  formatArmError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  useArmConnection: () => ({ status: 'connected' }),
  useArmState: () => mocks.state,
}))

vi.mock('./ActivationSection', () => ({ ActivationSection: () => <div /> }))
vi.mock('./FirmwareSection', () => ({ FirmwareSection: () => <div /> }))
vi.mock('./GripperSection', () => ({ GripperSection: () => <div /> }))

const { SettingsPage } = await import('./SettingsPage')

/** 打开「安装方向」页签（用 URL 进，省得跟 Radix 的 tab 点击较劲）。 */
async function renderInstallation(expected = /已读取设备当前装向（正装）/) {
  render(
    <MemoryRouter initialEntries={['/settings?tab=installation']}>
      <SettingsPage />
    </MemoryRouter>,
  )
  // 等读回值进 state —— 状态那一行只有在读回之后才说得出装法。
  await screen.findByText(expected)
  // ⚠ 读回值进来之后组件里的草稿 effect 还要再跑一拍（预设与 rpy 跟着读回值走）。
  //   不把这一拍跑完就点预设，随后落下的 effect 会把刚选的预设覆盖掉。
  await act(async () => {})
}

describe('SettingsPage — installation direction', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
    vi.clearAllMocks()
    mocks.enabled = false
    mocks.state = { q: [0, 0, 0, 0, 0, 0, 0], enabled: false }
    mocks.readPayload.mockResolvedValue({ mass: 1, com: [0, 0, 0] })
    mocks.readGravityVector.mockResolvedValue([0, 0, -9.81])
    mocks.getGravity.mockResolvedValue([0, 0, 0, 0, 0, 0, 0])
    mocks.getJointParams.mockResolvedValue([])
    mocks.setGravityVector.mockResolvedValue(undefined)
    mocks.saveParams.mockResolvedValue(undefined)
  })

  it('says which way the device is mounted, in words, from the read-back value', async () => {
    await renderInstallation()

    expect(screen.getByText('已读取设备当前装向（正装）')).toBeDefined()
    // 「设备当前」读的是固件里的值，不是草稿 —— 带符号的 4 位定点。
    expect(screen.getByText(/设备当前：\(\+0\.0000, \+0\.0000, -9\.8100\) = 正装 \|g\|=9\.8100/)).toBeDefined()
  })

  it('offers the six mountings plus the custom marker, in the documented order', async () => {
    await renderInstallation()

    for (const label of ['正装', '倒装', '侧装+x', '侧装-x', '侧装+y', '侧装-y', '自定义']) {
      expect(screen.getByRole('radio', { name: label })).toBeDefined()
    }
    expect(screen.getByRole('radio', { name: '正装' }).getAttribute('aria-checked')).toBe('true')
  })

  it('fills the exact m/s² vector of the preset, and sends that, not a unit vector', async () => {
    // ⚠ 这是"预设值要准确"的判据: 侧装+x 下发的是 [9.81, 0, 0]，不是 [1, 0, 0]。
    await renderInstallation()

    fireEvent.click(screen.getByRole('radio', { name: '侧装+x' }))

    expect(screen.getByDisplayValue('9.8100')).toBeDefined() // gravity x
    expect(screen.getByDisplayValue('1.5708')).toBeDefined() // base_rpy pitch
    expect(screen.getByRole('radio', { name: '侧装+x' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: /下发/ }))
    await waitFor(() => expect(mocks.setGravityVector).toHaveBeenCalledWith([9.81, 0, 0]))
  })

  it('goes back to custom after a preset, so the custom pill is not a one-way door', async () => {
    // ⚠ 曾经「自定义」是个点不动的牌子 (onClick 空函数), 于是选了侧装+x 之后就再也回不去。
    await renderInstallation()

    fireEvent.click(screen.getByRole('radio', { name: '侧装+x' }))
    expect(screen.getByRole('radio', { name: '侧装+x' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('radio', { name: '自定义' }))
    expect(screen.getByRole('radio', { name: '自定义' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: '侧装+x' }).getAttribute('aria-checked')).toBe('false')
    // 退出预设只是不再点着那块牌子, 三个数原样留着 —— 它们正是接着改的起点。
    expect(screen.getByDisplayValue('9.8100')).toBeDefined()
    expect(screen.getByDisplayValue('1.5708')).toBeDefined()
  })

  it('recomputes the vector when rpy is edited, and marks rpy custom when the vector is edited', async () => {
    await renderInstallation()

    // 手改 pitch ⇒ 向量由 g = R(rpy)ᵀ·(0,0,-9.81) 重算。
    const pitch = screen.getByLabelText('pitch')
    fireEvent.change(pitch, { target: { value: '1.5708' } })
    fireEvent.blur(pitch)
    await waitFor(() => expect(screen.getByDisplayValue('9.8100')).toBeDefined())
    expect(screen.getByRole('radio', { name: '侧装+x' }).getAttribute('aria-checked')).toBe('true')

    // 反过来：直接改向量，rpy 不再描述它 ⇒ 落到「自定义」，并明说 rpy 是自定义的。
    const gravityZ = screen.getByLabelText('z')
    fireEvent.change(gravityZ, { target: { value: '-3.0000' } })
    fireEvent.blur(gravityZ)
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: '自定义' }).getAttribute('aria-checked')).toBe('true'),
    )
    expect(screen.getByText('（自定义）')).toBeDefined()
  })

  it('reads the current direction on demand, without touching the other tabs', async () => {
    await renderInstallation()

    mocks.readGravityVector.mockResolvedValueOnce([0, 9.81, 0])
    fireEvent.click(screen.getByRole('button', { name: /读当前/ }))

    await waitFor(() => expect(screen.getByDisplayValue('9.8100')).toBeDefined())
    expect(await screen.findByText(/已读取设备当前装向（侧装\+y）/)).toBeDefined()
    // 只读重力向量：载荷与逐轴参数的读回各只有挂载时那一次。
    expect(mocks.readPayload).toHaveBeenCalledTimes(1)
  })

  it('blocks the write while the drives are enabled, because the firmware would refuse it', async () => {
    mocks.state = { q: [0, 0, 0, 0, 0, 0, 0], enabled: true }
    await renderInstallation()

    expect((screen.getByRole('button', { name: /下发/ }) as HTMLButtonElement).disabled).toBe(true)
    // 固化到 Flash 同样被拦住：固件在这里也要求失能态，而"提前替它撒谎"与"发出去
    // 再解释拒绝"相比，前者省掉一次注定失败的往返。
    expect((screen.getByRole('button', { name: /固化到 Flash/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/请先失能/)).toBeDefined()
  })

  it('persists the direction to flash on demand', async () => {
    await renderInstallation()

    fireEvent.click(screen.getByRole('button', { name: /固化到 Flash/ }))
    await waitFor(() => expect(mocks.saveParams).toHaveBeenCalledTimes(1))
  })

  it('says nothing has been read yet when the read-back is all zeros', async () => {
    mocks.readGravityVector.mockResolvedValue([0, 0, 0])
    await renderInstallation(/尚未读取设备装向/)

    expect(screen.queryByText(/已读取设备当前装向/)).toBeNull()
  })

  it('blocks the write until the device direction has been read back', async () => {
    // 读失败 ⇒ 手里那三个数只是控件默认值（[0,0,0]），下发等于把一个"装向"盲写进固件。
    mocks.readGravityVector.mockRejectedValue(new Error('link down'))
    render(
      <MemoryRouter initialEntries={['/settings?tab=installation']}>
        <SettingsPage />
      </MemoryRouter>,
    )
    await screen.findByText(/尚未成功读取设备当前装向/)

    expect((screen.getByRole('button', { name: /下发/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /固化到 Flash/ }) as HTMLButtonElement).disabled).toBe(true)
    // 读当前仍然可点 —— 它正是解除这道闸门的那一步。
    await waitFor(() =>
      expect((screen.getByRole('button', { name: /读当前/ }) as HTMLButtonElement).disabled).toBe(false),
    )
  })

  it('treats an unknown state as unsafe, not as a disabled arm', async () => {
    // ⚠ 「没收到状态帧」不等于「没使能」——不知道的时候下发，与已知使能时下发是同一个
    //   物理后果（三条分量非原子，中途模长 13.87）。
    mocks.state = null
    await renderInstallation()

    expect((screen.getByRole('button', { name: /下发/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /固化到 Flash/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/尚未收到状态帧/)).toBeDefined()
  })

  it('asks before sending a vector whose magnitude is not 9.81', async () => {
    // 正装改侧装时 z 没清零 —— 看着合理的错，|g| = 13.87 = 1.41g。固件照收不误。
    await renderInstallation()
    const gx = screen.getByLabelText('x')
    fireEvent.change(gx, { target: { value: '9.8100' } })
    fireEvent.blur(gx)
    // |g| = √2·9.81 = 13.8734（面板写"13.87"是取整的说法）。
    await waitFor(() => expect(screen.getByText(/13\.8734/)).toBeDefined())

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.click(screen.getByRole('button', { name: /下发/ }))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(mocks.setGravityVector).not.toHaveBeenCalled()

    // 确认之后照发 —— 闸门是"二次确认"，不是"不许发"。
    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: /下发/ }))
    await waitFor(() => expect(mocks.setGravityVector).toHaveBeenCalledWith([9.81, 0, -9.81]))
  })

  it('reports the post-write self-check: read-back, |g| and whether G(q) moved', async () => {
    // ⚠ 这一条是"真的进了模型"的判据：写同值 G(q) 不该变，改动过就必须变。
    // 基线是正装，写进去的是侧装+x ⇒ **值真的变了**，所以 G(q) 必须跟着变。
    mocks.readGravityVector.mockResolvedValueOnce([0, 0, -9.81]).mockResolvedValue([9.81, 0, 0])
    mocks.getGravity.mockResolvedValueOnce([0, 1, 2, 3, 4, 5, 6]) // 下发前
    mocks.getGravity.mockResolvedValueOnce([0.4, 1, 2, 3, 4, 5, 6]) // 下发后（变了 ⇒ 符合预期）
    await renderInstallation()

    fireEvent.click(screen.getByRole('radio', { name: '侧装+x' }))
    fireEvent.click(screen.getByRole('button', { name: /下发/ }))

    await waitFor(() => expect(mocks.setGravityVector).toHaveBeenCalledWith([9.81, 0, 0]))
    // 前后两次 G(q) 用的是**同一个** q（否则"变了没有"分不清是参数生效还是臂动了）。
    const qs = mocks.getGravity.mock.calls.map((c) => c[0])
    expect(qs).toHaveLength(2)
    expect(qs[0]).toEqual(qs[1])
    expect(
      await screen.findByText(/下发后自检：读回差异 0\.0e\+0 ✅ · \|g\|=9\.8100 ✅ · G\(q\)：变了（符合预期）/),
    ).toBeDefined()
  })

  it('skips the G(q) leg instead of faking it when the firmware has no 0x39', async () => {
    mocks.getGravity.mockRejectedValue(new Error('unknown command'))
    await renderInstallation()

    fireEvent.click(screen.getByRole('button', { name: /下发/ }))

    await waitFor(() => expect(mocks.setGravityVector).toHaveBeenCalled())
    // 字节写进去了 ⇒ 回读那一段照旧能给结论；只有模型那一段如实标"跳过"。
    expect(await screen.findByText(/G\(q\)：未取到当前姿态，跳过/)).toBeDefined()
    expect(screen.getByText(/读回差异/)).toBeDefined()
  })
})

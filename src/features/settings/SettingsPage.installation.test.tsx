import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'

/**
 * 这一份钉的是「安装方向」页签**看得懂、点得动、发得对**：
 * 预设填的是哪三个数（m/s²，不是单位向量）、rpy 与向量的关系、以及"须失能"这条门禁。
 * 换算本身的判据在 `installationPose.test.ts`，这里只看界面。
 */
afterEach(cleanup)

const mocks = vi.hoisted(() => ({
  readPayload: vi.fn(),
  setPayload: vi.fn(),
  readGravityVector: vi.fn(),
  setGravityVector: vi.fn(),
  getJointParams: vi.fn(),
  saveParams: vi.fn(),
  resetFactoryParams: vi.fn(),
  kinBench: vi.fn(),
  /** daemon 的使能位 —— 「下发（须失能）」该不该灰掉看它。 */
  enabled: false,
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
    getJointParams: mocks.getJointParams,
    setJointParam: vi.fn(),
    setJointLimits: vi.fn(),
    saveParams: mocks.saveParams,
    resetFactoryParams: mocks.resetFactoryParams,
    kinBench: mocks.kinBench,
  },
  formatArmError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  useArmConnection: () => ({ status: 'connected' }),
  useArmState: () => ({ enabled: mocks.enabled }),
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
    mocks.readPayload.mockResolvedValue({ mass: 1, com: [0, 0, 0] })
    mocks.readGravityVector.mockResolvedValue([0, 0, -9.81])
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
    mocks.enabled = true
    await renderInstallation()

    const send = screen.getByRole('button', { name: /下发/ }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    expect(screen.getByText(/请先失能/)).toBeDefined()
    // 固化到 Flash 仍然可点 —— 固件的拒绝会原样回传，界面不替它提前撒谎。
    expect((screen.getByRole('button', { name: /固化到 Flash/ }) as HTMLButtonElement).disabled).toBe(false)
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
})

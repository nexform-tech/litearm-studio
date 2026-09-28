import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'

// vitest 未开 globals，RTL 的自动 cleanup 不会注册：不手动挂 afterEach 的话，
// 上一个用例的 DOM 会留在 document 里，J1 的计数会叠加。
afterEach(cleanup)

const mocks = vi.hoisted(() => ({
  readPayload: vi.fn(),
  setPayload: vi.fn(),
  readGravityScale: vi.fn(),
  readInertiaScale: vi.fn(),
  readGravityVector: vi.fn(),
  setGravityScale: vi.fn(),
  setInertiaScale: vi.fn(),
  setGravityVector: vi.fn(),
  getJointParams: vi.fn(),
  setJointParam: vi.fn(),
  setJointLimits: vi.fn(),
  saveParams: vi.fn(),
  resetFactoryParams: vi.fn(),
  kinBench: vi.fn(),
  connectionStatus: 'connected',
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/arm', () => ({
  armClient: {
    readPayload: mocks.readPayload,
    setPayload: mocks.setPayload,
    readGravityScale: mocks.readGravityScale,
    readInertiaScale: mocks.readInertiaScale,
    readGravityVector: mocks.readGravityVector,
    setGravityScale: mocks.setGravityScale,
    setInertiaScale: mocks.setInertiaScale,
    setGravityVector: mocks.setGravityVector,
    getJointParams: mocks.getJointParams,
    setJointParam: mocks.setJointParam,
    setJointLimits: mocks.setJointLimits,
    saveParams: mocks.saveParams,
    resetFactoryParams: mocks.resetFactoryParams,
    kinBench: mocks.kinBench,
  },
  formatArmError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  useArmConnection: () => ({ status: mocks.connectionStatus }),
}))

const { SettingsPage } = await import('./SettingsPage')

/**
 * 轴数只由 `get_joint_params` 的返回条数体现（daemon 侧是 `range(arm.n)`）：
 * `{1J}` 台架返回 1 条，`{7J}` 返回 7 条。
 */
function primeArm(axes: number) {
  mocks.readPayload.mockResolvedValue({ mass: 1, com: [0, 0, 0] })
  mocks.readGravityScale.mockResolvedValue(Array.from({ length: 7 }, () => 1))
  mocks.readInertiaScale.mockResolvedValue(Array.from({ length: 7 }, () => 1))
  mocks.readGravityVector.mockResolvedValue([0, 0, -1])
  mocks.getJointParams.mockResolvedValue(
    Array.from({ length: axes }, (_, i) => ({ idx: i, kp: 50, kd: 2, tau_max: 10, q_min: -1.5, q_max: 1.5 })),
  )
  mocks.setGravityScale.mockResolvedValue(undefined)
  mocks.setInertiaScale.mockResolvedValue(undefined)
}

/** 渲染并等到首次读取落地（负载读回值渲染出来就说明 joints 也进 state 了）。 */
async function renderPage() {
  render(<SettingsPage />)
  await screen.findByDisplayValue('1')
}

/** Radix 的 Tab 在 mouseDown 上换页，click 不够。 */
function openTab(name: RegExp) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 })
}

describe('SettingsPage axis scaling', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
    mocks.connectionStatus = 'connected'
    vi.clearAllMocks()
  })

  it('renders one joint row, with a usable save button, on a one-axis arm', async () => {
    primeArm(1)
    await renderPage()
    openTab(/增益与限位/)

    // 表头 + 1 行：J2…J7 那些全 0 的占位行不再存在（issue #42）。
    expect(screen.getAllByRole('row')).toHaveLength(2)
    expect(screen.getAllByText('J1')).toHaveLength(1)
    expect(screen.queryByText('J2')).toBeNull()

    // 这一行的保存按钮是可用的 —— 以前 `jp` 为 undefined，行内保存被 `!jp` 禁掉。
    const row = screen.getAllByRole('row')[1]
    const save = screen.getAllByRole('button').find((b) => row.contains(b)) as HTMLButtonElement
    expect(save.disabled).toBe(false)
  })

  it('shows only the axes that exist in the feed-forward grids but still writes seven values', async () => {
    primeArm(1)
    await renderPage()
    openTab(/重力与惯量/)

    // 重力系数 + 惯量系数两张表各只剩 J1。
    expect(screen.getAllByText('J1')).toHaveLength(2)
    expect(screen.queryByText('J2')).toBeNull()

    const saves = screen.getAllByRole('button', { name: '保存' })
    fireEvent.click(saves[0])
    await waitFor(() => expect(mocks.setGravityScale).toHaveBeenCalledTimes(1))
    fireEvent.click(saves[1])
    await waitFor(() => expect(mocks.setInertiaScale).toHaveBeenCalledTimes(1))

    // 协议定长：SDK 的 set_ff_vec 只收 7 个值，发 1 个会被整条拒绝。
    expect(mocks.setGravityScale.mock.calls[0][0]).toHaveLength(7)
    expect(mocks.setInertiaScale.mock.calls[0][0]).toHaveLength(7)
  })

  it('still renders every row and field on a seven-axis arm', async () => {
    primeArm(7)
    await renderPage()

    openTab(/增益与限位/)
    expect(screen.getAllByRole('row')).toHaveLength(8)
    expect(screen.getAllByText('J7')).toHaveLength(1)
    openTab(/重力与惯量/)
    expect(screen.getAllByText('J7')).toHaveLength(2)
  })

  it('says nothing has been read yet while disconnected', async () => {
    mocks.connectionStatus = 'disconnected'
    render(<SettingsPage />)

    openTab(/增益与限位/)
    expect(screen.getByText('尚未读取到关节参数。')).toBeDefined()
    openTab(/重力与惯量/)
    // 重力系数与惯量系数两张表各自给一句空态。
    expect(screen.getAllByText(/前馈通道数跟随上报的轴数/)).toHaveLength(2)
    expect(screen.queryByText('J1')).toBeNull()
  })
})

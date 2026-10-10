import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'

afterEach(cleanup)

const mocks = vi.hoisted(() => {
  const conn = { current: null as Record<string, unknown> | null }
  const state = { current: null as Record<string, unknown> | null }
  const calib = { current: null as Record<string, unknown> | null }
  return {
    conn,
    state,
    calib,
    connect: vi.fn(),
    disconnect: vi.fn(),
    listChannels: vi.fn(),
    listCalibrations: vi.fn(),
    loadTemplate: vi.fn(),
    importCalibration: vi.fn(),
    setAllowFactory: vi.fn(),
    zero: vi.fn(),
    pickFile: vi.fn(),
  }
})

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}))

vi.mock('@/lib/arm/gripperClient', () => ({
  gripperClient: {
    connect: mocks.connect,
    disconnect: mocks.disconnect,
    listChannels: mocks.listChannels,
    listCalibrations: mocks.listCalibrations,
    loadTemplate: mocks.loadTemplate,
    importCalibration: mocks.importCalibration,
    setAllowFactory: mocks.setAllowFactory,
    zero: mocks.zero,
  },
}))

// "浏览…"由**本地程序**弹原生对话框（`POST /api/pick-file`）—— 测试里把它整条换掉。
vi.mock('@/lib/pickFile', () => ({
  pickFileThroughDaemon: mocks.pickFile,
}))

vi.mock('@/lib/arm/useGripper', () => ({
  useGripperConnection: () => ({
    conn: mocks.conn.current,
    status: mocks.conn.current ? 'connected' : 'disconnected',
    present: true,
    busy: { busy: false, what: '' },
    connect: mocks.connect,
    disconnect: mocks.disconnect,
  }),
  useGripperState: () => mocks.state.current,
  useGripperCalibration: () => mocks.calib.current,
  useGripperAlerts: () => undefined,
}))

const { GripperSection } = await import('./GripperSection')

const CANDIDATE = {
  path: '/home/u/.litegrip/can0_calibration.json',
  source: 'measured',
  provenance: 'user_file',
  template: null,
  channel: 'can0',
  valid: true,
  problems: [],
  warnings: [],
  closedRad: 1.7,
  openRad: -0.06,
  fileRadToMm: 46.7,
  mount: 'normal',
}

describe('GripperSection', () => {
  beforeEach(() => {
    mocks.conn.current = {
      status: 'connected',
      channel: 'can0',
      canId: 8,
      mount: 'normal',
      declaredMount: 'normal',
      template: null,
      source: 'measured',
      path: CANDIDATE.path,
      travelMm: 85,
      allowFactory: false,
      closedRad: 1.7,
      openRad: -0.06,
      fileRadToMm: 46.7,
      error: null,
      gate: 'READY',
      gateReason: '',
    }
    mocks.state.current = { enabled: true, state: 'holding', gate: 'READY', positionMm: 5 }
    mocks.calib.current = null
    vi.clearAllMocks()
    mocks.listChannels.mockResolvedValue(['can0'])
    mocks.listCalibrations.mockResolvedValue([CANDIDATE])
    mocks.zero.mockResolvedValue({ closedRad: 1.7, openRad: -0.06, radToMm: 46.7, source: 'measured', warnings: [] })
    mocks.pickFile.mockResolvedValue({ kind: 'cancelled' })
  })

  it('lists the calibrations with their provenance and the one in effect', async () => {
    render(<GripperSection />)
    await waitFor(() => expect(screen.getByTestId('gripper-calibrations')).toBeTruthy())
    const list = screen.getByTestId('gripper-calibrations')
    expect(list.textContent).toMatch(/Measured|实测/)
    expect(list.textContent).toMatch(/In effect|生效中/)
    expect(list.textContent).toContain('/home/u/.litegrip/can0_calibration.json')
  })

  it('runs zero with the travel field', async () => {
    render(<GripperSection />)
    await waitFor(() => expect(mocks.listCalibrations).toHaveBeenCalled())
    await waitFor(() =>
      expect((screen.getByTestId('gripper-zero') as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(screen.getByTestId('gripper-zero'))
    await waitFor(() => expect(mocks.zero).toHaveBeenCalledWith(85))
  })

  it('disables zero until the drive is enabled', async () => {
    mocks.state.current = { enabled: false, state: 'disabled', gate: 'READY', positionMm: null }
    render(<GripperSection />)
    await waitFor(() => expect(mocks.listCalibrations).toHaveBeenCalled())
    expect((screen.getByTestId('gripper-zero') as HTMLButtonElement).disabled).toBe(true)
  })

  it('defaults the mounting direction to normal, with no undeclared option', async () => {
    // daemon 侧不再有"未声明"这一态（参考硬件是正装）：没有记录时表单必须给正装，
    // 而不是一个空值。
    mocks.conn.current = { ...mocks.conn.current, mount: null, declaredMount: null }
    render(<GripperSection />)
    await waitFor(() => expect(mocks.listCalibrations).toHaveBeenCalled())
    expect(screen.getByTestId('gripper-mount').textContent).toMatch(/Normal|正向/)
    expect(screen.queryByText(/Not declared|未声明/)).toBeNull()
  })

  it('persists the factory acknowledgement through the toggle', async () => {
    mocks.setAllowFactory.mockResolvedValue({ allowFactory: true })
    render(<GripperSection />)
    await waitFor(() => expect(mocks.listCalibrations).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('gripper-allow-factory'))
    await waitFor(() => expect(mocks.setAllowFactory).toHaveBeenCalledWith(true))
  })

  it('imports a calibration from a typed path', async () => {
    mocks.importCalibration.mockResolvedValue({ path: '/tmp/my.json', source: 'measured' })
    render(<GripperSection />)
    await waitFor(() => expect(mocks.listCalibrations).toHaveBeenCalled())
    fireEvent.change(screen.getByTestId('gripper-import-path'), { target: { value: '/tmp/my.json' } })
    fireEvent.click(screen.getByTestId('gripper-import'))
    await waitFor(() => expect(mocks.importCalibration).toHaveBeenCalledWith('/tmp/my.json'))
  })

  // ── 浏览（由本地程序弹原生打开对话框） ──────────────────────────────────────

  it('fills the path box from the file the native dialog returned', async () => {
    mocks.pickFile.mockResolvedValue({ kind: 'picked', path: CANDIDATE.path })
    render(<GripperSection />)
    await waitFor(() => expect(mocks.listCalibrations).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId('gripper-import-browse'))

    await waitFor(() => expect(mocks.pickFile).toHaveBeenCalled())
    expect((screen.getByTestId('gripper-import-path') as HTMLInputElement).value).toBe(CANDIDATE.path)
    // 路径填上了、又连着，导入按钮就该亮起来。
    expect((screen.getByTestId('gripper-import') as HTMLButtonElement).disabled).toBe(false)
  })

  it('browses without a connection but still gates import on it', async () => {
    mocks.conn.current = null             // 断开：选文件免连接，导入不然
    render(<GripperSection />)
    await waitFor(() => expect(mocks.listCalibrations).toHaveBeenCalled())
    expect((screen.getByTestId('gripper-import-browse') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.change(screen.getByTestId('gripper-import-path'), { target: { value: '/tmp/a.json' } })
    expect((screen.getByTestId('gripper-import') as HTMLButtonElement).disabled).toBe(true)
  })

  it('says so when there is no local program to open the dialog', async () => {
    mocks.pickFile.mockResolvedValue({ kind: 'unavailable' })
    const { toast } = await import('sonner')
    render(<GripperSection />)
    await waitFor(() => expect(mocks.listCalibrations).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId('gripper-import-browse'))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    // 没选到文件，路径框不动。
    expect((screen.getByTestId('gripper-import-path') as HTMLInputElement).value).toBe('')
  })
})

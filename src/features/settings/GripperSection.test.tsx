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
    listDir: vi.fn(),
    loadTemplate: vi.fn(),
    importCalibration: vi.fn(),
    setAllowFactory: vi.fn(),
    zero: vi.fn(),
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
    listDir: mocks.listDir,
    loadTemplate: mocks.loadTemplate,
    importCalibration: mocks.importCalibration,
    setAllowFactory: mocks.setAllowFactory,
    zero: mocks.zero,
  },
  // 对话框用它分流目录行/文件行 —— 整个模块被 mock，所以这个也要在这里给。
  hasCandidate: (e: { type?: string; valid?: unknown }) =>
    e.type === 'file' && typeof e.valid === 'boolean',
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

  // ── 目录浏览（控制机文件系统） ──────────────────────────────────────────────

  const FILE_ENTRY = { ...CANDIDATE, name: 'can0_calibration.json', type: 'file', readable: true, symlink: false, size: 210, mtime: 1 }
  const DIR_ENTRY = { name: '.litegrip', path: '/home/u/.litegrip', type: 'dir', readable: true, symlink: false }
  const LISTING = { path: '/home/u', parent: '/home', truncated: false, entries: [DIR_ENTRY, FILE_ENTRY] }

  it('browses without a connection but still gates import on it', async () => {
    mocks.conn.current = null             // 断开：列举免连接，导入不然
    mocks.listDir.mockResolvedValue(LISTING)
    render(<GripperSection />)
    await waitFor(() => expect(mocks.listCalibrations).toHaveBeenCalled())
    expect((screen.getByTestId('gripper-import-browse') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.change(screen.getByTestId('gripper-import-path'), { target: { value: '/tmp/a.json' } })
    expect((screen.getByTestId('gripper-import') as HTMLButtonElement).disabled).toBe(true)
  })

  it('fills the path box from a picked file and closes the dialog', async () => {
    mocks.listDir.mockResolvedValue(LISTING)
    render(<GripperSection />)
    await waitFor(() => expect(mocks.listCalibrations).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('gripper-import-browse'))
    await waitFor(() => expect(mocks.listDir).toHaveBeenCalled())

    fireEvent.click(await screen.findByTestId('gripper-browse-file'))

    await waitFor(() => expect(screen.queryByTestId('gripper-browse-dialog')).toBeNull())
    expect((screen.getByTestId('gripper-import-path') as HTMLInputElement).value).toBe(CANDIDATE.path)
    expect((screen.getByTestId('gripper-import') as HTMLButtonElement).disabled).toBe(false)
  })

  it('navigates into a directory row', async () => {
    mocks.listDir.mockResolvedValue(LISTING)
    render(<GripperSection />)
    await waitFor(() => expect(mocks.listCalibrations).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('gripper-import-browse'))
    await waitFor(() => expect(mocks.listDir).toHaveBeenCalled())

    fireEvent.click(await screen.findByTestId('gripper-browse-dir'))

    await waitFor(() => expect(mocks.listDir).toHaveBeenLastCalledWith('/home/u/.litegrip'))
  })

  it('shows a browse refusal inline, mapped from its kind', async () => {
    mocks.listDir.mockRejectedValue({ err: { kind: 'GripperBrowseError', msg: '/x 不是一个可访问的目录' } })
    render(<GripperSection />)
    await waitFor(() => expect(mocks.listCalibrations).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('gripper-import-browse'))

    const err = await screen.findByTestId('gripper-browse-error')
    expect(err.textContent).toMatch(/Cannot open that folder|打不开这个目录/)
  })
})

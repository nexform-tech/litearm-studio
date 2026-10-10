import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'

const mocks = vi.hoisted(() => {
  const conn = { current: null as Record<string, unknown> | null }
  const state = { current: null as Record<string, unknown> | null }
  const calib = { current: null as Record<string, unknown> | null }
  const status = { current: 'connected' as string }
  const present = { current: true }
  return {
    conn,
    state,
    calib,
    status,
    present,
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

vi.mock('@/lib/arm/useGripper', () => ({
  useGripperConnection: () => ({
    conn: mocks.conn.current,
    status: mocks.status.current,
    present: mocks.present.current,
    busy: { busy: false, what: '' },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }),
  useGripperState: () => mocks.state.current,
  useGripperCalibration: () => mocks.calib.current,
  useGripperAlerts: () => undefined,
}))

// "浏览…"由**本地程序**弹原生对话框（`POST /api/pick-file`）—— 测试里把它整条换掉。
vi.mock('@/lib/pickFile', () => ({
  pickFileThroughDaemon: mocks.pickFile,
}))

const { useGripperSettings } = await import('./useGripperSettings')

function connected(overrides: Record<string, unknown> = {}) {
  mocks.present.current = true
  mocks.status.current = 'connected'
  mocks.conn.current = {
    status: 'connected',
    channel: 'can0',
    canId: 8,
    mount: 'normal',
    declaredMount: 'normal',
    template: null,
    source: 'measured',
    path: '/tmp/cal.json',
    travelMm: 85,
    allowFactory: false,
    closedRad: 1.7,
    openRad: -0.06,
    fileRadToMm: 46.7,
    error: null,
    gate: 'READY',
    gateReason: '',
    ...overrides,
  }
  mocks.state.current = {
    positionMm: 10,
    forceN: 0,
    torqueNm: 0,
    velocityMmS: 0,
    enabled: true,
    state: 'holding',
    errorCode: 1,
    temps: { mosTemp: 30, coilTemp: 31 },
    fresh: true,
    gate: 'READY',
    gateReason: '',
  }
}

describe('useGripperSettings', () => {
  beforeEach(() => {
    connected()
    vi.clearAllMocks()
    mocks.listChannels.mockResolvedValue(['can0', 'can1'])
    mocks.listCalibrations.mockResolvedValue([
      {
        path: '/tmp/cal.json',
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
      },
    ])
    mocks.connect.mockResolvedValue({ started: true })
    mocks.disconnect.mockResolvedValue({ stopped: true })
    mocks.loadTemplate.mockResolvedValue({ mount: 'reverse', source: 'template' })
    mocks.importCalibration.mockResolvedValue({ path: '/tmp/my.json', source: 'measured' })
    mocks.setAllowFactory.mockResolvedValue({ allowFactory: true })
    mocks.zero.mockResolvedValue({
      closedRad: 1.71,
      openRad: -0.07,
      radToMm: 46.5,
      source: 'measured',
      warnings: [],
    })
    mocks.pickFile.mockResolvedValue({ kind: 'cancelled' })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('scans channels and calibrations without a connection', async () => {
    const { result } = renderHook(() => useGripperSettings())
    await waitFor(() => expect(mocks.listCalibrations).toHaveBeenCalled())
    await waitFor(() => expect(result.current.channels).toEqual(['can0', 'can1']))
    expect(result.current.calibrations).toHaveLength(1)
    expect(result.current.calibrations[0].source).toBe('measured')
  })

  it('shows the record the device reports, not the last thing typed', async () => {
    const { result } = renderHook(() => useGripperSettings())
    await waitFor(() => expect(result.current.conn).not.toBeNull())
    expect(result.current.travel).toBe(85)
    expect(result.current.mount).toBe('normal')
  })

  it('applies the identity by disconnecting first and reconnecting with the form values', async () => {
    const { result } = renderHook(() => useGripperSettings())
    await act(async () => {
      result.current.setChannel('can1')
      result.current.setCanId(9)
      result.current.setMount('reverse')
    })
    await act(async () => {
      await result.current.apply()
    })
    expect(mocks.disconnect).toHaveBeenCalledTimes(1)
    expect(mocks.connect).toHaveBeenCalledWith({ channel: 'can1', canId: 9, mstId: undefined, mount: 'reverse' })
  })

  it('loads a template by name and adopts the read-back direction', async () => {
    const { result } = renderHook(() => useGripperSettings())
    await act(async () => {
      await result.current.useTemplate('reverse')
    })
    expect(mocks.loadTemplate).toHaveBeenCalledWith('reverse')
    expect(result.current.mount).toBe('reverse')
  })

  it('imports a calibration from a path on the control machine', async () => {
    const { result } = renderHook(() => useGripperSettings())
    await act(async () => {
      result.current.setImportPath('/tmp/my.json')
    })
    await act(async () => {
      await result.current.importCalibration()
    })
    expect(mocks.importCalibration).toHaveBeenCalledWith('/tmp/my.json')
    expect(result.current.importPath).toBe('')
  })

  it('does nothing on an empty import path', async () => {
    const { result } = renderHook(() => useGripperSettings())
    await act(async () => {
      await result.current.importCalibration()
    })
    expect(mocks.importCalibration).not.toHaveBeenCalled()
  })

  it('persists the factory acknowledgement', async () => {
    const { result } = renderHook(() => useGripperSettings())
    await act(async () => {
      await result.current.setAllowFactory(true)
    })
    expect(mocks.setAllowFactory).toHaveBeenCalledWith(true)
  })

  it('fills the import path from the file the native dialog returned', async () => {
    mocks.pickFile.mockResolvedValue({ kind: 'picked', path: '/tmp/picked.json' })
    const { result } = renderHook(() => useGripperSettings())
    await act(async () => {
      await result.current.pickCalibration()
    })
    expect(mocks.pickFile).toHaveBeenCalled()
    expect(result.current.importPath).toBe('/tmp/picked.json')
  })

  it('says so when there is no local program to open the dialog', async () => {
    mocks.pickFile.mockResolvedValue({ kind: 'unavailable' })
    const { result } = renderHook(() => useGripperSettings())
    await act(async () => {
      result.current.setImportPath('/tmp/typed.json')
    })
    await act(async () => {
      await result.current.pickCalibration()
    })
    const { toast } = await import('sonner')
    expect(toast.error).toHaveBeenCalledWith(
      i18n.t('gripper:settings.browseUnavailable'),
      expect.anything(),
    )
    // 弹不出对话框就不动已经填的路径。
    expect(result.current.importPath).toBe('/tmp/typed.json')
  })

  it('runs zero with the travel field and rescans afterwards', async () => {
    const { result } = renderHook(() => useGripperSettings())
    await act(async () => {
      result.current.setTravel(62.5)
    })
    mocks.listCalibrations.mockClear()
    await act(async () => {
      await result.current.zero()
    })
    expect(mocks.zero).toHaveBeenCalledWith(62.5)
    expect(mocks.listCalibrations).toHaveBeenCalled()
  })

  it('refuses a zero with a non-positive travel before touching the device', async () => {
    const { result } = renderHook(() => useGripperSettings())
    await act(async () => {
      result.current.setTravel(0)
    })
    await act(async () => {
      await result.current.zero()
    })
    expect(mocks.zero).not.toHaveBeenCalled()
    const { toast } = await import('sonner')
    expect(toast.error).toHaveBeenCalledWith(i18n.t('gripper:settings.noTravel'), expect.anything())
  })

  it('reports whether a probe is running', async () => {
    mocks.calib.current = { probe: 'zero', phase: 'close', step: 3, total: 100, progress: 0.03, detail: '…' }
    const running = renderHook(() => useGripperSettings())
    expect(running.result.current.probing).toBe(true)
    running.unmount()

    mocks.calib.current = { probe: 'zero', phase: 'done', step: 100, total: 100, progress: 1, detail: '' }
    const finished = renderHook(() => useGripperSettings())
    expect(finished.result.current.probing).toBe(false)
  })
})

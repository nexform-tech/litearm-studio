import 'fake-indexeddb/auto'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LogsPage } from './LogsPage'
import '@/i18n'

/**
 * 这一份钉的是**页面能读懂记录并把它显示出来**, 不是样式。
 *
 * 悬空的两条依赖都在 `vi.hoisted` 里换成可控的桩: 遥测那一半 (`useTelemetryState`) 与
 * 日志流 (`logStore`)。真实的 `logStore` 已经由 `src/lib/log/logStore.test.ts` 覆盖,
 * 这里只关心"记录进来之后表格里有什么"。
 */
const mock = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const state = {
    entries: [] as unknown[],
    samples: [] as unknown[],
    status: {
      seq: 0, dropped: 0, clients: 0, missed: 0, metaAt: 0, buffered: 0, writeErrors: 0,
      logDir: null as string | null, historyAvailable: true, loadingHistory: false,
    },
  }
  return {
    listeners,
    state,
    notify: () => listeners.forEach((cb) => cb()),
    telemetry: {
      connected: true,
      recording: false,
      port: '/dev/ttyACM0',
      sampleHz: 10,
      retentionMb: 10,
      retentionMinMb: 10,
      retentionMaxMb: 500,
      setRetentionMb: vi.fn(() => 10),
      sessionSamples: 0,
      lastSampleAt: null,
      totalSamples: 0,
      totalSessions: 0,
      sessions: [],
      selectedId: null,
      session: null,
      samples: [],
      samplesLoading: false,
      loading: false,
      error: null,
      hasMore: false,
      exporting: null,
      selectSession: vi.fn(),
      loadOlder: vi.fn(),
      refresh: vi.fn(),
      exportSession: vi.fn(),
    },
  }
})

vi.mock('./useTelemetryState', () => ({
  useTelemetryState: () => mock.telemetry,
}))

vi.mock('@/lib/log/logStore', () => ({
  logStore: {
    subscribe: (cb: () => void) => {
      mock.listeners.add(cb)
      return () => mock.listeners.delete(cb)
    },
    getEntries: () => mock.state.entries,
    getSamples: () => mock.state.samples,
    getStatus: () => mock.state.status,
    loadEarlier: () => Promise.resolve(0),
    hydrate: () => Promise.resolve(),
    clear: () => Promise.resolve(),
    start: () => undefined,
    stop: () => undefined,
  },
}))

vi.mock('@/lib/log/logDb', () => ({
  MAX_MEMORY_RECORDS: 5000,
  logDb: {
    count: () => Promise.resolve(0),
    estimatedBytes: () => Promise.resolve(0),
    clear: () => Promise.resolve(),
    recent: () => Promise.resolve([]),
    add: () => Promise.resolve(),
  },
}))

function record(overrides: Record<string, unknown> = {}) {
  return {
    seq: 1,
    event: 'arm.command.failed',
    kind: 'command',
    body: '命令 movej 失败: MotionBusyError',
    severity: 'ERROR',
    severityNumber: 17,
    tsNs: 1_778_152_382_123_456_000,
    ts: '2026-05-07T13:53:02.123456Z',
    traceId: 'b7c1f0e2a4d94e51b7c1f0e2a4d94e51',
    spanId: '9f3a21c4d8e74b02',
    service: 'litearm-studio-daemon',
    version: '1.0.0',
    host: 'bench-01',
    pid: 1,
    thread: 'litearm-cmd',
    source: 'litearm_studio_daemon.session',
    fields: { method: 'movej', outcome: 'error', duration_ms: 12.4 },
    ...overrides,
  }
}

/** 一条采样记录 —— 折叠区就是拿它画折线的。 */
function sample(tsNs: number, temps: number[], tau: number[]) {
  return record({
    seq: 0,
    kind: 'sample',
    event: 'state.sample',
    body: 'state=ready',
    severity: 'DEBUG',
    severityNumber: 5,
    tsNs,
    ts: new Date(tsNs / 1e6).toISOString(),
    fields: {
      state: 'ready',
      q: [0, 0, 0],
      tau,
      temps: temps.map((v) => ({ mosTemp: v, coilTemp: v - 4 })),
    },
  })
}

describe('LogsPage — records tab', () => {
  beforeEach(async () => {
    mock.state.entries = []
    mock.state.samples = []
    mock.state.status = {
      seq: 0, dropped: 0, clients: 0, missed: 0, metaAt: 0, buffered: 0, writeErrors: 0,
      logDir: null, historyAvailable: true, loadingHistory: false,
    }
    await import('@/i18n').then((m) => m.default.changeLanguage('en'))
  })

  it('renders a record with its level, event name and message', async () => {
    mock.state.entries = [record()]
    mock.state.status = { ...mock.state.status, seq: 1, metaAt: Date.now(), buffered: 1 }
    render(<LogsPage />)

    expect(await screen.findByText('arm.command.failed')).toBeTruthy()
    expect(screen.getByText('命令 movej 失败: MotionBusyError')).toBeTruthy()
    expect(screen.getByText('ERROR')).toBeTruthy()
  })

  it('shows the details, including the exception, when a row is expanded', async () => {
    mock.state.entries = [
      record({
        fields: {
          method: 'movej',
          outcome: 'error',
          exception: { type: 'MotionBusyError', message: 'busy', stacktrace: 'MotionBusyError: busy' },
        },
      }),
    ]
    mock.state.status = { ...mock.state.status, metaAt: Date.now() }
    render(<LogsPage />)

    fireEvent.click(await screen.findByText('arm.command.failed'))
    // 异常栈单独成块: 排障时第一样要看的就是它。
    expect(await screen.findByText(/--- exception ---/)).toBeTruthy()
    expect(screen.getByText(/MotionBusyError: busy/)).toBeTruthy()
  })

  it('shows the readings around an event when its row is expanded', async () => {
    // ⚠ 这是方案 2 的判据: 展开一条事件就要看到它那一刻的数值, 而不是切到另一个 tab
    // 手动对齐时间。事件与采样同源, 所以这里只是把同一份数据取一小段。
    const eventTs = 1_778_152_382_123_456_000
    const second = 1_000_000_000
    mock.state.entries = [record({ tsNs: eventTs })]
    mock.state.samples = [
      sample(eventTs - 2 * second, [30, 70, 31], [0.1, 0.2, 2.5]),
      sample(eventTs - second, [31, 76, 32], [0.2, 0.3, 2.9]),
      sample(eventTs + second, [32, 78, 33], [0.3, 0.2, 3.0]),
      // 窗口之外 —— 不该出现在折叠区里 (那会让"那一刻"这个说法失真)。
      sample(eventTs + 600 * second, [99, 99, 99], [9, 9, 9]),
    ]
    mock.state.status = { ...mock.state.status, metaAt: Date.now() }
    render(<LogsPage />)

    fireEvent.click(await screen.findByText('arm.command.failed'))
    expect(await screen.findByText(/Readings around this moment/)).toBeTruthy()
    expect(screen.getByText('3 samples')).toBeTruthy()
    // 最热那一轴与力矩最大那一轴各一条折线, 加上"整机最高温"。
    const plot = document.querySelector('polyline')
    expect(plot).not.toBeNull()
    // 窗口里那 4 条采样只画 3 条, 且极值取自它们而不是窗口外那条 99。
    const points = plot!.getAttribute('points') ?? ''
    expect(points.split(' ')).toHaveLength(3)
    // 读数按"整数不带小数"给 (见 `Sparkline.nice`), 所以区间是 70–78。
    // 最热那一轴与"整机最高温"在这个例子里是同一条曲线 (其余轴只到 30 出头),
    // 所以它会出现多次 —— 断言"至少一次", 而不是"恰好一次"。
    expect(screen.getAllByText('70–78').length).toBeGreaterThanOrEqual(1)
    // 窗口外那条 99°C 不该被算进来。
    expect(screen.queryByText(/99/)).toBeNull()
  })

  it('says so when the daemon recorded no samples', async () => {
    // INFO 级别下不落采样, 这是正常状态, 不是错误 —— 界面要说清, 而不是画一张空白图。
    mock.state.entries = [record()]
    mock.state.samples = []
    mock.state.status = { ...mock.state.status, metaAt: Date.now() }
    render(<LogsPage />)

    fireEvent.click(await screen.findByText('arm.command.failed'))
    expect(await screen.findByText(/No state samples around this moment/)).toBeTruthy()
  })

  it('does not draw a context chart for a sample record itself', async () => {
    // 采样记录自己就是数值, 再给它画一段上下文是多余的。
    const eventTs = 1_778_152_382_123_456_000
    mock.state.entries = [sample(eventTs, [40, 50, 60], [1, 2, 3])]
    mock.state.samples = [sample(eventTs, [40, 50, 60], [1, 2, 3])]
    mock.state.status = { ...mock.state.status, metaAt: Date.now() }
    render(<LogsPage />)

    fireEvent.click(await screen.findByText('state.sample'))
    expect(await screen.findByText(/"state": "ready"/)).toBeTruthy()
    expect(screen.queryByText(/Readings around this moment/)).toBeNull()
  })

  it('filters by text without touching the stream', async () => {
    mock.state.entries = [
      // 第一条的 fields.method 也必须是 enable: 搜索命中方法是刻意的行为, 留一个
      // 默认的 `movej` 会让这条用例无论过滤对不对都为真。
      record({
        seq: 1, event: 'arm.command.succeeded', body: '命令 enable 完成', severity: 'INFO',
        fields: { method: 'enable', outcome: 'ok' },
      }),
      record({ seq: 2, event: 'arm.command.failed', body: '命令 movej 失败' }),
    ]
    mock.state.status = { ...mock.state.status, seq: 2, metaAt: Date.now() }
    render(<LogsPage />)

    await screen.findByText('arm.command.succeeded')
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'movej' } })

    await waitFor(() => {
      expect(screen.queryByText('arm.command.succeeded')).toBeNull()
    })
    expect(screen.getByText('arm.command.failed')).toBeTruthy()
  })

  it('says so when there is nothing yet, instead of showing an empty box', async () => {
    render(<LogsPage />)
    expect(await screen.findByText(/No log records yet/)).toBeTruthy()
  })

  it('offers both tabs', async () => {
    render(<LogsPage />)
    expect(await screen.findByRole('tab', { name: 'Log Records' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Samples' })).toBeTruthy()
  })
})

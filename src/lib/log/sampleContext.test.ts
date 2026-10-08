import { describe, expect, it } from 'vitest'
import { DEFAULT_WINDOW_NS, sampleContextFor } from './sampleContext'
import type { LogEntry } from './schema'

/** 一条采样记录: 只有 `timestamp` 与几轴数值是这条路径关心的。 */
function sample(tsNs: number, opts: { temps?: number[]; tau?: number[] } = {}): LogEntry {
  const temps = opts.temps ?? [30, 31, 32]
  const tau = opts.tau ?? [0.1, -0.2, 0.3]
  return {
    seq: 0,
    event: 'state.sample',
    kind: 'sample',
    body: 'state=ready',
    severity: 'DEBUG',
    severityNumber: 5,
    tsNs,
    ts: new Date(tsNs / 1e6).toISOString(),
    traceId: null,
    spanId: null,
    service: 'litearm-studio-daemon',
    version: 't',
    host: 'h',
    pid: 1,
    thread: 'litearm-state-poll',
    source: 'litearm_studio_daemon.session',
    fields: {
      state: 'ready',
      q: [0, 0, 0],
      tau,
      temps: temps.map((t) => ({ mosTemp: t, coilTemp: t - 4 })),
    },
  }
}

function event(tsNs: number): LogEntry {
  return {
    seq: 7,
    event: 'session.link.lost',
    kind: 'session',
    body: '链路已断开',
    severity: 'WARN',
    severityNumber: 13,
    tsNs,
    ts: new Date(tsNs / 1e6).toISOString(),
    traceId: null,
    spanId: null,
    service: 'litearm-studio-daemon',
    version: 't',
    host: 'h',
    pid: 1,
    thread: 't',
    source: 'litearm_studio_daemon.session',
    fields: {},
  }
}

const SECOND = 1_000_000_000
const T0 = 1_778_152_382_000_000_000

describe('sampleContextFor', () => {
  it('takes the samples around the event, not the whole series', () => {
    // 事件前后各 60s 都有采样; 默认窗口只取 ±10s。
    const samples = Array.from({ length: 121 }, (_, i) => sample(T0 - 60 * SECOND + i * SECOND))
    const context = sampleContextFor(event(T0), samples)
    expect(context.windowNs).toBe(DEFAULT_WINDOW_NS)
    // ±10s 含边界 ⇒ 21 条。
    expect(context.samples).toHaveLength(21)
    expect(context.samples[0].tsNs).toBe(T0 - 10 * SECOND)
    expect(context.samples[context.samples.length - 1].tsNs).toBe(T0 + 10 * SECOND)
  })

  it('returns the window in time order, aligned with the plotted values', () => {
    const samples = Array.from({ length: 41 }, (_, i) => sample(T0 - 20 * SECOND + i * SECOND))
    const context = sampleContextFor(event(T0), samples)
    expect(context.times).toEqual(context.samples.map((s) => s.tsNs))
    for (const series of context.series) {
      expect(series.values).toHaveLength(context.times.length)
    }
    // 时间正序 —— 折线画反了会把趋势读成相反的方向。
    expect([...context.times].sort((a, b) => a - b)).toEqual(context.times)
  })

  it('plots the hottest joint and the strongest joint', () => {
    const samples = [
      sample(T0 - SECOND, { temps: [30, 70, 31], tau: [0.1, 0.2, 2.5] }),
      sample(T0, { temps: [31, 78, 32], tau: [0.2, 0.3, 3.0] }),
      sample(T0 + SECOND, { temps: [32, 75, 33], tau: [0.3, 0.2, 2.0] }),
    ]
    const context = sampleContextFor(event(T0), samples)
    const [heat, torque, max] = context.series
    expect(heat.label).toBe('J2')          // 78°C 那一轴
    expect(heat.values).toEqual([70, 78, 75])
    expect(torque.label).toBe('J3')        // |3.0| 那一轴
    expect(torque.values).toEqual([2.5, 3.0, 2.0])
    expect(max.label).toBe('max')          // 每一条都给出"整机最高温"
    expect(max.values).toEqual([70, 78, 75])
  })

  it('caps the plotted series instead of drawing every joint', () => {
    const samples = [sample(T0, { temps: [40, 50, 60], tau: [1, 2, 3] })]
    const context = sampleContextFor(event(T0), samples)
    // 最多 3 条: 最热一轴 + 力矩最大一轴 + 整体最高温, 再多就挤成一团。
    expect(context.series.length).toBeLessThanOrEqual(3)
    expect(context.series.map((s) => s.unit)).toContain('°C')
  })

  it('says so when there are no samples at all', () => {
    // daemon 以 INFO 级别跑时不落采样 —— 这是正常状态, 不是错误。
    const context = sampleContextFor(event(T0), [])
    expect(context.samples).toEqual([])
    expect(context.series).toEqual([])
    expect(context.hasValues).toBe(false)
  })

  it('says so when the samples are all outside the window', () => {
    const far = [sample(T0 - 600 * SECOND), sample(T0 + 600 * SECOND)]
    const context = sampleContextFor(event(T0), far)
    expect(context.samples).toEqual([])
    expect(context.hasValues).toBe(false)
  })

  it('tolerates a sample record with missing fields', () => {
    const odd: LogEntry = { ...sample(T0), fields: {} }
    const context = sampleContextFor(event(T0), [odd])
    expect(context.samples).toHaveLength(1)
    // 画不出来就不画, 但窗口本身仍然如实给出 ("这一刻有采样, 只是没有数值")。
    expect(context.series.every((s) => s.values.every((v) => v === 0))).toBe(true)
  })

  it('honours a caller-supplied window', () => {
    const samples = Array.from({ length: 21 }, (_, i) => sample(T0 - 10 * SECOND + i * SECOND))
    const narrow = sampleContextFor(event(T0), samples, 2 * SECOND)
    expect(narrow.samples).toHaveLength(5)   // ±2s
    expect(narrow.windowNs).toBe(2 * SECOND)
  })
})

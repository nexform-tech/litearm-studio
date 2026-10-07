import { describe, expect, it } from 'vitest'
import {
  estimateRecordBytes,
  isAtLeast,
  matchesFilters,
  normalizeRecord,
  normalizeSeverity,
  recordToWire,
  severityNumber,
  type LogRecord,
} from './schema'

/** 一条 daemon 会真正写出来的记录 (字段名与 `obs/schema.py` 逐字对应)。 */
function wire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: '2026-05-07T13:53:02.123456Z',
    ts_ns: 1778152382123456000,
    observed_ts_ns: 1778152382123999000,
    severity: 'ERROR',
    severity_number: 17,
    event: 'arm.command.failed',
    body: '命令 movej 失败: MotionBusyError: 机械臂正在运动',
    trace_id: 'b7c1f0e2a4d94e51b7c1f0e2a4d94e51',
    span_id: '9f3a21c4d8e74b02',
    service: 'litearm-studio-daemon',
    version: '1.4.2',
    host: 'bench-01',
    pid: 41233,
    thread: 'litearm-cmd',
    source: 'litearm_studio_daemon.session',
    kind: 'command',
    fields: { method: 'movej', outcome: 'error', duration_ms: 12.4 },
    ...overrides,
  }
}

describe('severity normalization', () => {
  it('accepts every spelling the three languages use', () => {
    expect(normalizeSeverity('WARN')).toBe('WARN')
    expect(normalizeSeverity('warning')).toBe('WARN')
    expect(normalizeSeverity('WARNING')).toBe('WARN')
    expect(normalizeSeverity('critical')).toBe('FATAL')
    expect(normalizeSeverity('err')).toBe('ERROR')
    expect(normalizeSeverity('info')).toBe('INFO')
  })

  it('accepts OTLP numbers in their four-wide buckets', () => {
    expect(normalizeSeverity(5)).toBe('DEBUG')
    expect(normalizeSeverity(9)).toBe('INFO')
    expect(normalizeSeverity(12)).toBe('INFO')     // INFO 覆盖 9–12
    expect(normalizeSeverity(13)).toBe('WARN')
    expect(normalizeSeverity(21)).toBe('FATAL')
  })

  it('falls back instead of throwing on nonsense', () => {
    // 一条级别认不出的记录也必须能显示出来 —— 显示不出来正是最需要日志的那一刻。
    expect(normalizeSeverity('verbose')).toBe('INFO')
    expect(normalizeSeverity(null)).toBe('INFO')
    expect(normalizeSeverity(undefined, 'DEBUG')).toBe('DEBUG')
  })

  it('orders levels by the OTLP numbers', () => {
    expect(severityNumber('TRACE')).toBeLessThan(severityNumber('DEBUG'))
    expect(severityNumber('WARN')).toBeLessThan(severityNumber('ERROR'))
    expect(isAtLeast('ERROR', 'WARN')).toBe(true)
    expect(isAtLeast('DEBUG', 'INFO')).toBe(false)
    expect(isAtLeast('INFO', 'INFO')).toBe(true)
  })
})

describe('record normalization', () => {
  it('maps a daemon record onto the page model', () => {
    const record = normalizeRecord(wire())
    expect(record).not.toBeNull()
    expect(record).toMatchObject({
      event: 'arm.command.failed',
      kind: 'command',
      severity: 'ERROR',
      severityNumber: 17,
      tsNs: 1778152382123456000,
      traceId: 'b7c1f0e2a4d94e51b7c1f0e2a4d94e51',
      spanId: '9f3a21c4d8e74b02',
      source: 'litearm_studio_daemon.session',
      host: 'bench-01',
      pid: 41233,
      thread: 'litearm-cmd',
    })
    expect(record!.fields.method).toBe('movej')
    expect(record!.fields.exception).toBeUndefined()
  })

  it('keeps a record whose fields are missing rather than dropping it', () => {
    const record = normalizeRecord({ event: 'session.link.lost', body: '链路断开' })
    expect(record).not.toBeNull()
    expect(record!.severity).toBe('INFO')          // 缺失 ⇒ 安全默认值
    expect(record!.kind).toBe('')
    expect(record!.fields).toEqual({})
    expect(record!.tsNs).toBeGreaterThan(0)        // 兜底成"现在", 而不是 0 (排到最前面)
  })

  it('ignores anything that is not a record', () => {
    expect(normalizeRecord(null)).toBeNull()
    expect(normalizeRecord('a string')).toBeNull()
    expect(normalizeRecord([])).toBeNull()
    expect(normalizeRecord({ foo: 'bar' })).toBeNull()
  })

  it('ignores an unknown kind but keeps the event', () => {
    const record = normalizeRecord(wire({ kind: 'something-new' }))
    expect(record!.kind).toBe('')
    expect(record!.event).toBe('arm.command.failed')
  })

  it('round-trips back to the wire shape the daemon writes', () => {
    const record = normalizeRecord(wire()) as LogRecord
    const back = recordToWire(record)
    // 逐字相同 —— 导出的 JSONL 与 daemon 写的那个文件必须是同一种东西。
    const original = wire()
    for (const key of ['ts', 'ts_ns', 'severity', 'severity_number', 'event', 'body',
                       'trace_id', 'span_id', 'service', 'version', 'host', 'pid',
                       'thread', 'source', 'kind']) {
      expect(back[key], key).toEqual(original[key])
    }
    expect(back.fields).toEqual(original.fields)
  })

  it('filters on the three conditions together', () => {
    const failed = normalizeRecord(wire()) as LogRecord
    // ⚠ body 里刻意**不含** "movej": 文本过滤的判据是"事件/内容/方法名任一命中",
    // 若这里留着 wire() 默认那句含 movej 的 body, 这条用例就永远为真而失去意义。
    const info = normalizeRecord(wire({
      event: 'arm.command.succeeded', severity: 'INFO', severity_number: 9,
      kind: 'command', body: '命令 enable 完成',
      fields: { method: 'enable', outcome: 'ok' },
    })) as LogRecord
    const linkLost = normalizeRecord(wire({
      event: 'session.link.lost', severity: 'WARN', severity_number: 13,
      kind: 'session', body: '链路已断开', fields: {},
    })) as LogRecord

    expect(matchesFilters(failed, { level: 'ALL', kind: 'ALL', query: '' })).toBe(true)
    // 级别: 只看 WARN 及以上 ⇒ INFO 那条被挡掉。
    expect(matchesFilters(info, { level: 'WARN', kind: 'ALL', query: '' })).toBe(false)
    expect(matchesFilters(linkLost, { level: 'WARN', kind: 'ALL', query: '' })).toBe(true)
    // 类别: 只看连接 ⇒ 命令那条被挡掉。
    expect(matchesFilters(failed, { level: 'ALL', kind: 'session', query: '' })).toBe(false)
    expect(matchesFilters(linkLost, { level: 'ALL', kind: 'session', query: '' })).toBe(true)
    // 文本: 方法名也要能搜到 —— "哪条命令失败了"是最高频的问题。
    expect(matchesFilters(failed, { level: 'ALL', kind: 'ALL', query: 'movej' })).toBe(true)
    expect(matchesFilters(failed, { level: 'ALL', kind: 'ALL', query: 'MOV' })).toBe(true)
    expect(matchesFilters(info, { level: 'ALL', kind: 'ALL', query: 'movej' })).toBe(false)
  })

  it('estimates a plausible size for a record', () => {
    const record = normalizeRecord(wire()) as LogRecord
    const bytes = estimateRecordBytes(record)
    expect(bytes).toBeGreaterThan(200)
    expect(bytes).toBeLessThan(2000)
  })
})

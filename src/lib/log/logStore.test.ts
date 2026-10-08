import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { logDb, MAX_STORED_RECORDS } from './logDb'
import { logStore } from './logStore'
import type { LogEntry } from './schema'

function entry(seq: number, tsNs: number): LogEntry {
  return {
    seq,
    event: 'arm.command.succeeded',
    kind: 'command',
    body: `命令 set_speed 完成 (seq=${seq})`,
    severity: 'DEBUG',
    severityNumber: 5,
    tsNs,
    ts: new Date(tsNs / 1e6).toISOString(),
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    service: 'litearm-studio-daemon',
    version: '1.0.0',
    host: 'bench-01',
    pid: 1,
    thread: 'litearm-cmd',
    source: 'litearm_studio_daemon.session',
    fields: { method: 'set_speed', outcome: 'ok' },
  }
}

describe('logDb', () => {
  beforeEach(async () => {
    await logDb.clear()
  })

  it('stores records and reads them back in time order', async () => {
    await logDb.add([entry(1, 1_000), entry(2, 2_000), entry(3, 3_000)])
    const rows = await logDb.recent(10)
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3])
    expect(await logDb.count()).toBe(3)
  })

  it('returns the newest records when asked for fewer than it holds', async () => {
    await logDb.add([entry(1, 1_000), entry(2, 2_000), entry(3, 3_000)])
    const rows = await logDb.recent(2)
    expect(rows.map((r) => r.seq)).toEqual([2, 3])
  })

  it('estimates a non-zero size once it holds records', async () => {
    await logDb.add([entry(1, 1_000)])
    expect(await logDb.estimatedBytes()).toBeGreaterThan(100)
  })

  it('is tolerant of an empty write', async () => {
    await logDb.add([])
    expect(await logDb.count()).toBe(0)
  })

  it('prunes down to the stored cap', async () => {
    // 只写 cap + 5 条: 这条用例要钉的是"淘汰最旧的", 不是性能。
    const rows: LogEntry[] = []
    for (let n = 0; n < MAX_STORED_RECORDS + 5; n++) rows.push(entry(n, 1_000 + n))
    await logDb.add(rows)
    const count = await logDb.count()
    expect(count).toBeLessThanOrEqual(MAX_STORED_RECORDS)
    const oldest = (await logDb.recent(1))[0]
    expect(oldest.seq).toBeGreaterThan(0)   // 最旧的几条已经被丢掉
  }, 30_000)
})

describe('logStore', () => {
  beforeEach(async () => {
    logStore.reset()
    await logDb.clear()
  })

  /** 一个假 socket: 记下注册的处理器, 让用例自己投帧。 */
  function fakeSocket() {
    const handlers = new Map<string, (msg: Record<string, unknown>) => void>()
    return {
      handlers,
      socket: {
        onFrame(tag: string, handler: (msg: Record<string, unknown>) => void) {
          handlers.set(tag, handler)
          return () => handlers.delete(tag)
        },
      },
    }
  }

  const frame = (seq: number, tsNs: number) => ({
    t: 'log',
    seq,
    record: {
      event: 'arm.command.succeeded',
      body: `seq=${seq}`,
      severity: 'INFO',
      severity_number: 9,
      ts_ns: tsNs,
      ts: new Date(tsNs / 1e6).toISOString(),
      service: 'litearm-studio-daemon',
      fields: { method: 'enable' },
      kind: 'command',
    },
  })

  it('collects records from the stream in order', () => {
    const { socket, handlers } = fakeSocket()
    logStore.start(socket as never)
    try {
      handlers.get('log')!(frame(1, 1_000_000_000))
      handlers.get('log')!(frame(2, 2_000_000_000))
      const entries = logStore.getEntries()
      expect(entries.map((e) => e.seq)).toEqual([1, 2])
      expect(entries[0].fields.method).toBe('enable')
      expect(logStore.getStatus().buffered).toBe(2)
    } finally {
      logStore.stop()
    }
  })

  it('counts the missing records when the sequence jumps', () => {
    // ⚠ 这是页面唯一能区分"断了一段"与"什么都没发生"的依据。
    const { socket, handlers } = fakeSocket()
    logStore.start(socket as never)
    try {
      handlers.get('log')!(frame(1, 1_000_000_000))
      handlers.get('log')!(frame(5, 2_000_000_000))
      // 1 与 5 之间是 2、3、4 三条。
      expect(logStore.getStatus().missed).toBe(3)
    } finally {
      logStore.stop()
    }
  })

  it('does not count a gap for consecutive frames', () => {
    const { socket, handlers } = fakeSocket()
    logStore.start(socket as never)
    try {
      for (let seq = 1; seq <= 10; seq++) handlers.get('log')!(frame(seq, seq * 1_000_000))
      handlers.get('log_meta')!({ t: 'log_meta', seq: 10, dropped: 0, clients: 1 })
      expect(logStore.getStatus().missed).toBe(0)
    } finally {
      logStore.stop()
    }
  })

  it('reports what daemon says about the stream and detects a gap from meta', () => {
    const { socket, handlers } = fakeSocket()
    logStore.start(socket as never)
    try {
      handlers.get('log')!(frame(1, 1_000_000_000))
      handlers.get('log_meta')!({ t: 'log_meta', seq: 4, dropped: 2, clients: 1 })
      const status = logStore.getStatus()
      expect(status.seq).toBe(4)
      expect(status.dropped).toBe(2)
      expect(status.clients).toBe(1)
      // 收到 1 之后 meta 说"已广播到 4" ⇒ 2、3、4 三条都没收到。
      expect(status.missed).toBe(3)
      expect(status.metaAt).toBeGreaterThan(0)
    } finally {
      logStore.stop()
    }
  })

  it('never counts a gap before the stream has told us where it is', () => {
    // 首次接入时 `seq` 从任意值开始 (daemon 可能已经广播过很多条), 那不是缺口。
    const { socket, handlers } = fakeSocket()
    logStore.start(socket as never)
    try {
      handlers.get('log')!(frame(1000, 1_000_000_000))
      expect(logStore.getStatus().missed).toBe(0)
    } finally {
      logStore.stop()
    }
  })

  it('caps memory instead of growing without bound', () => {
    const { socket, handlers } = fakeSocket()
    logStore.start(socket as never)
    try {
      for (let n = 1; n <= 5200; n++) handlers.get('log')!(frame(n, n * 1_000_000))
      const entries = logStore.getEntries()
      expect(entries.length).toBeLessThanOrEqual(5000)
      // 留下的必须是**最近**的那一批 —— 淘汰的是最旧的一端。
      expect(entries[entries.length - 1].seq).toBe(5200)
    } finally {
      logStore.stop()
    }
  })

  it('ignores a malformed log frame instead of breaking the stream', () => {
    const { socket, handlers } = fakeSocket()
    logStore.start(socket as never)
    try {
      handlers.get('log')!({ t: 'log', seq: 1, record: null })
      handlers.get('log')!({ t: 'log', seq: 2 })
      expect(logStore.getEntries()).toHaveLength(0)
    } finally {
      logStore.stop()
    }
  })

  it('hydrates memory from the cache when it is empty', async () => {
    await logDb.add([entry(1, 1_000), entry(2, 2_000)])
    logStore.reset()
    await logStore.hydrate()
    expect(logStore.getEntries().map((e) => e.seq)).toEqual([1, 2])
  })

  it('does not overwrite a live stream with the cache', async () => {
    const { socket, handlers } = fakeSocket()
    logStore.start(socket as never)
    try {
      handlers.get('log')!(frame(50, 5_000_000_000))
      await logDb.add([entry(1, 1_000)])
      await logStore.hydrate()
      // 实时记录必须留在原位, 不能被缓存里的旧数据挤到后面。
      expect(logStore.getEntries().map((e) => e.seq)).toEqual([50])
    } finally {
      logStore.stop()
    }
  })

  it('clear empties both memory and the cache', async () => {
    await logDb.add([entry(1, 1_000)])
    logStore.reset()
    await logStore.hydrate()
    await logStore.clear()
    expect(logStore.getEntries()).toHaveLength(0)
    expect(await logDb.count()).toBe(0)
  })
})

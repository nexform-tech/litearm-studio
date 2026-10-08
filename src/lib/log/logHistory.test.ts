import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { logDb } from './logDb'

/**
 * 历史回读这一半 (issue #80): 页面能不能靠 daemon 的文件把更早的记录接回来。
 *
 * ⚠ `fetchLogHistory` 被换成可控的桩: 这一份要钉的是**接法** (接在哪一端、去重、
 * 失败降级、什么时候触发), 而不是 HTTP 本身。
 */
const mock = vi.hoisted(() => ({
  pages: [] as unknown[],
  calls: [] as unknown[],
  fail: false,
}))

vi.mock('./logHistory', () => ({
  HISTORY_PAGE_SIZE: 200,
  fetchLogHistory: (query: unknown) => {
    mock.calls.push(query)
    if (mock.fail) return Promise.reject(new Error('boom'))
    return Promise.resolve(mock.pages.shift() ?? {
      records: [], cursor: null, more: false, dir: null, fileCount: 0,
    })
  },
  emptyHistoryPage: () => ({ records: [], cursor: null, more: false, dir: null, fileCount: 0 }),
}))

const { logStore } = await import('./logStore')

function record(event: string, tsNs: number) {
  return {
    event,
    kind: 'command' as const,
    body: event,
    severity: 'INFO' as const,
    severityNumber: 9,
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

/** 等 store 自己的回读链跑完 —— 比 RTL 的轮询确定, 也不会被 microtask 时序骗到. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('logStore history backfill', () => {
  beforeEach(async () => {
    logStore.reset()
    await logDb.clear()
    mock.pages = []
    mock.calls = []
    mock.fail = false
  })

  it('prepends an earlier page when the stream starts', async () => {
    mock.pages = [{
      records: [record('older-1', 1_000), record('older-2', 2_000)],
      cursor: '1000-0', more: true, dir: '/tmp/logs', fileCount: 2,
    }]
    logStore.start(fakeSocket().socket as never)
    await vi.waitFor(() => {
      expect(logStore.getEntries().map((e) => e.event)).toEqual(['older-1', 'older-2'])
    })
    expect(logStore.getStatus().logDir).toBe('/tmp/logs')
    expect(logStore.getStatus().historyAvailable).toBe(true)
    logStore.stop()
  })

  it('never puts an older record after a live one', async () => {
    const { socket, handlers } = fakeSocket()
    mock.pages = [{
      records: [record('older', 1_000)],
      cursor: '1000-0', more: true, dir: '/tmp/logs', fileCount: 1,
    }]
    logStore.start(socket as never)
    handlers.get('log')!({
      t: 'log', seq: 1,
      record: { event: 'live', body: 'live', severity: 'INFO', ts_ns: 9_000, fields: {} },
    })
    await vi.waitFor(() => {
      // ⚠ 历史接在**前面** —— 顺序错了表格就变成"先新后旧"。
      expect(logStore.getEntries().map((e) => e.event)).toEqual(['older', 'live'])
    })
    logStore.stop()
  })

  it('drops a record the live stream already delivered', async () => {
    const { socket, handlers } = fakeSocket()
    // 回读在当前文件里也能看到刚广播过的那几条 —— 不能因此出现两份。
    mock.pages = [{
      records: [record('same', 5_000)],
      cursor: null, more: false, dir: '/tmp/logs', fileCount: 1,
    }]
    logStore.start(socket as never)
    handlers.get('log')!({
      t: 'log', seq: 1,
      record: { event: 'same', body: 'same', severity: 'INFO', ts_ns: 5_000, fields: {} },
    })
    await vi.waitFor(() => {
      expect(logStore.getEntries()).toHaveLength(1)
    })
    logStore.stop()
  })

  it('says there is no more history when the daemon returns no cursor', async () => {
    mock.pages = [{
      records: [record('only', 1_000)],
      cursor: null, more: false, dir: '/tmp/logs', fileCount: 1,
    }]
    logStore.start(fakeSocket().socket as never)
    await settle()
    // "还有更早的" = 拿到了下一页的起点。没有游标 ⇒ 界面上那个按钮该暗下去。
    expect(logStore.getStatus().historyAvailable).toBe(false)
    logStore.stop()
  })

  it('can still read history again after an empty first attempt', async () => {
    // 第一次读到头不等于以后永远没有 —— 后续记录会继续写进文件。
    // ⚠ 若把 `historyAvailable === false` 当成锁, 页面从此再也补不上缺口: 每隔几秒
    // 就有新记录落盘, 而按钮永远是灰的。
    mock.pages = [
      { records: [], cursor: null, more: false, dir: '/tmp/logs', fileCount: 1 },
      { records: [record('appeared-later', 5_000)], cursor: null, more: false,
        dir: '/tmp/logs', fileCount: 1 },
    ]
    logStore.start(fakeSocket().socket as never)
    await settle()
    expect(logStore.getStatus().historyAvailable).toBe(false)

    expect(await logStore.loadEarlier()).toBe(1)
    expect(logStore.getEntries().map((e) => e.event)).toEqual(['appeared-later'])
    logStore.stop()
  })

  it('degrades to "history unavailable" instead of throwing when the read fails', async () => {
    mock.fail = true
    logStore.start(fakeSocket().socket as never)
    await vi.waitFor(() => {
      expect(logStore.getStatus().historyAvailable).toBe(false)
    })
    expect(logStore.getStatus().loadingHistory).toBe(false)
    // 实时流不受影响: 回读失败不该让页面变成一片错误。
    const { socket } = fakeSocket()
    logStore.stop()
    logStore.start(socket as never)
    expect(logStore.getEntries()).toEqual([])
    logStore.stop()
  })

  it('backfills the gap as soon as the sequence shows one', async () => {
    const { socket, handlers } = fakeSocket()
    mock.pages = [
      // 开局那一次: 什么都没有 (页面刚起来, 文件里也确实空)。
      { records: [], cursor: null, more: false, dir: '/tmp/logs', fileCount: 1 },
      // 缺口那一次: 把漏掉的那段接回来。
      { records: [record('missed-1', 2_000), record('missed-2', 3_000)],
        cursor: '2000-0', more: true, dir: '/tmp/logs', fileCount: 1 },
    ]
    logStore.start(socket as never)
    await vi.waitFor(() => expect(mock.calls.length).toBeGreaterThanOrEqual(1))
    handlers.get('log')!({
      t: 'log', seq: 1,
      record: { event: 'first', body: 'first', severity: 'INFO', ts_ns: 1_000, fields: {} },
    })
    handlers.get('log')!({
      t: 'log', seq: 9,
      record: { event: 'after-gap', body: 'after-gap', severity: 'INFO', ts_ns: 9_000, fields: {} },
    })
    await vi.waitFor(() => {
      const events = logStore.getEntries().map((e) => e.event)
      expect(events).toContain('missed-1')
      expect(events).toContain('missed-2')
    })
    expect(logStore.getStatus().missed).toBe(7)
    logStore.stop()
  })

  it('persists the history it read back, not only the live stream', async () => {
    mock.pages = [{
      records: [record('older-1', 1_000)],
      cursor: null, more: false, dir: '/tmp/logs', fileCount: 1,
    }]
    logStore.start(fakeSocket().socket as never)
    await vi.waitFor(() => expect(logStore.getEntries()).toHaveLength(1))
    logStore.stop()          // stop() flushes the pending batch
    await vi.waitFor(async () => {
      expect(await logDb.count()).toBeGreaterThanOrEqual(1)
    })
  })
})

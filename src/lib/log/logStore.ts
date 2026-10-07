/**
 * 页面侧的日志流 —— 一份内存环形缓冲 + 一份 IndexedDB 缓存。
 *
 * 谁读这个文件: 要理解"日志从哪来、刷新之后为什么还在、什么时候会丢"的人。
 *
 * 数据来源只有一条: daemon 的 `log` 帧 (`{t:"log", seq, record}`)。没有第二条通道,
 * 所以"实时看到的"与"文件里写的"不会有第二种解释。`log_meta` 帧带来三个数 ——
 * `seq`(流的位置)、`dropped`(队列满被丢的条数)、`clients` —— 它们是页面判断
 * "我是不是漏了一段"的**唯一**依据: 空白与"什么都没发生"在界面上长得一模一样, 只有
 * 序号能区分。
 *
 * 内存里保留最近若干条供渲染, 同时异步落一份缓存到 IndexedDB。**磁盘上的权威历史在
 * daemon 状态目录的 JSONL 文件里** (见 issue #80): 换端口、换浏览器 profile、清站点
 * 数据都不会动它。
 */
import { armClient } from '@/lib/arm/client'
import { DaemonSocket } from '@/lib/arm/socket'
import { logDb, MAX_MEMORY_RECORDS } from './logDb'
import { normalizeRecord, type LogEntry } from './schema'

/** 落缓存的批量间隔 (毫秒)。1s 与遥测采样的节拍一致。 */
const FLUSH_INTERVAL_MS = 1000
/** 未落盘的记录达到这个数就立刻落, 不等定时器 (突发时不让内存翻倍)。 */
const MAX_PENDING = 200

export type LogStreamStatus = {
  /** 服务端流的位置 (最后一条已广播的 `seq`)。 */
  seq: number
  /** daemon 累计因队列满丢掉的条数。 */
  dropped: number
  /** daemon 当前连着的客户端数。 */
  clients: number
  /** 页面自己发现的缺口: 收到的 `seq` 跳过了多少条。 */
  missed: number
  /** 上一次收到 `log_meta` 的时刻 (毫秒), 0 = 还没收到过。 */
  metaAt: number
  /** 缓存里有多少条 (含未落盘的)。 */
  buffered: number
  /** 缓存写入失败的次数 —— 写不进去不致命, 但要如实显示。 */
  writeErrors: number
}

type Listener = () => void

class LogStore {
  private entries: LogEntry[] = []
  private pending: LogEntry[] = []
  private listeners = new Set<Listener>()
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private unsubs: Array<() => void> = []
  private started = false
  private status: LogStreamStatus = {
    seq: 0,
    dropped: 0,
    clients: 0,
    missed: 0,
    metaAt: 0,
    buffered: 0,
    writeErrors: 0,
  }

  /**
   * 接上日志流。
   *
   * `socket` 可注入 (与遥测记录器同形的理由): 测试不必开一条真 WebSocket。默认用
   * `armClient` 那条 —— 全应用只有一条 socket, 日志不该另开一条 (见 `DaemonSocket`)。
   */
  start(socket: DaemonSocket = armClient.socket) {
    if (this.started) return
    this.started = true
    this.unsubs.push(socket.onFrame('log', (msg) => this.onLogFrame(msg)))
    this.unsubs.push(socket.onFrame('log_meta', (msg) => this.onMetaFrame(msg)))
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS)
    // 缓存只是缓存: 申请持久化是廉价的加固, 失败也不改变"权威历史在 daemon"这件事。
    void requestPersistentStorage()
  }

  stop() {
    if (!this.started) return
    this.started = false
    for (const unsub of this.unsubs) unsub()
    this.unsubs = []
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    void this.flush()
  }

  subscribe = (cb: Listener) => {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  getStatus(): LogStreamStatus {
    return { ...this.status }
  }

  /** 内存里的记录, **时间正序** (最新在最后)。 */
  getEntries(): LogEntry[] {
    return this.entries
  }

  /** 用缓存里的旧记录填充内存 (页面刚打开、实时流还没补上的那几秒)。 */
  async hydrate(limit = MAX_MEMORY_RECORDS): Promise<void> {
    if (this.entries.length > 0) return
    try {
      const rows = await logDb.recent(limit)
      if (rows.length === 0) return
      // ⚠ 只在实时流还没带来任何记录时填充: 否则会把刚收到的实时记录挤到后面,
      // 表格里出现"先新后旧"的错序。
      if (this.entries.length === 0) {
        this.entries = rows
        this.status = { ...this.status, buffered: rows.length }
        this.notify()
      }
    } catch {
      // 缓存读不出来不影响实时流; 不打扰操作员 (他在别的页面上也可能看到这条)。
    }
  }

  async clear(): Promise<void> {
    this.entries = []
    this.pending = []
    this.status = { ...this.status, buffered: 0 }
    this.notify()
    await logDb.clear().catch(() => undefined)
  }

  /** 仅供测试: 把单例恢复到未启动状态。 */
  reset() {
    this.stop()
    this.entries = []
    this.pending = []
    this.status = {
      seq: 0, dropped: 0, clients: 0, missed: 0, metaAt: 0, buffered: 0, writeErrors: 0,
    }
  }

  private onLogFrame(msg: Record<string, unknown>) {
    const record = normalizeRecord(msg.record)
    if (!record) return
    const seq = typeof msg.seq === 'number' ? msg.seq : 0
    // 这条 `seq` 我们**收到了**: 相对水位最多漏掉 (seq - 水位) - 1 条 (水位与它本身除外)。
    this.advanceWatermark(seq, { holdsSeq: true })
    const entry: LogEntry = { ...record, seq }
    this.entries.push(entry)
    if (this.entries.length > MAX_MEMORY_RECORDS) {
      // 环形缓冲: 从最旧的一端裁掉。内存里留全量会把 WebView 拖垮。
      this.entries.splice(0, this.entries.length - MAX_MEMORY_RECORDS)
    }
    this.pending.push(entry)
    this.status = { ...this.status, buffered: this.entries.length }
    if (this.pending.length >= MAX_PENDING) void this.flush()
    this.notify()
  }

  private onMetaFrame(msg: Record<string, unknown>) {
    const seq = typeof msg.seq === 'number' ? msg.seq : this.status.seq
    const dropped = typeof msg.dropped === 'number' ? msg.dropped : this.status.dropped
    const clients = typeof msg.clients === 'number' ? msg.clients : this.status.clients
    // 序号对不上 ⇒ 我们漏了。这比 "dropped" 更准: dropped 只统计 daemon 侧的队列溢出,
    // 而页面自己断线重连丢掉的, daemon 根本不知道。
    // ⚠ meta 的 `seq` 是"已广播到哪", 而**这一条我们没有收到** ⇒ 漏掉的数目正好是
    // 差值本身 (`holdsSeq=False`)。两个帧类型在这里必须分开算, 否则少算一条。
    this.advanceWatermark(seq, { holdsSeq: false })
    this.status = { ...this.status, dropped, clients, metaAt: Date.now() }
    this.notify()
  }

  /**
   * 推进"已见到哪一号"的水位线, 并累加中间漏掉的条数。
   *
   * ⚠ 水位线**只有这一条**, `log` 帧与 `log_meta` 共用它, 但两者"是否持有该号"不同:
   * `log` 帧的 `seq` 是它自己的 (持有), `log_meta` 的 `seq` 是"已广播到哪" (不持有)。
   * 若各用各的水位, 一次真实的缺口会被数两遍: log 帧报一次, 紧接着的 meta 拿一个更大
   * 的序号再报一次 —— "漏收"这个数会被放大成谎言。
   */
  private advanceWatermark(seq: number, { holdsSeq }: { holdsSeq: boolean }) {
    if (!Number.isFinite(seq) || seq <= 0) return
    const watermark = this.status.seq
    if (watermark > 0 && seq > watermark) {
      const missing = seq - watermark - (holdsSeq ? 1 : 0)
      if (missing > 0) {
        this.status = { ...this.status, missed: this.status.missed + missing }
      }
    }
    if (seq > watermark) this.status = { ...this.status, seq }
  }

  private async flush() {
    if (this.pending.length === 0) return
    const batch = this.pending.splice(0, this.pending.length)
    try {
      await logDb.add(batch)
    } catch {
      // 缓存写失败 (配额不足/隐私模式) 只计数, 不抛: 权威历史在 daemon 的文件里,
      // 这里丢的是一份副本。界面会显示这个计数, 而不是假装没事。
      this.status = { ...this.status, writeErrors: this.status.writeErrors + 1 }
      this.notify()
    }
  }

  private notify() {
    for (const cb of this.listeners) cb()
  }
}

/**
 * 申请持久化存储, 并**不**因此改变什么: IndexedDB 只是缓存。
 *
 * 为什么仍然要做: 浏览器在配额压力下可以清掉"best-effort"来源的数据, 而一句
 * `persist()` 就能把这份缓存升级成"不会被自动清掉"。它不修 issue #80 —— 换 origin
 * 照样换库 —— 只是让缓存这一层更耐用。
 */
async function requestPersistentStorage(): Promise<void> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return
    await navigator.storage.persist()
  } catch {
    // 用户拒绝或被策略拦下都无所谓 —— 缓存而已。
  }
}

export const logStore = new LogStore()

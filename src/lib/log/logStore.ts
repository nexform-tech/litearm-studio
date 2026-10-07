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
import { fetchLogHistory } from './logHistory'
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
  /** daemon 正在写的日志目录 (`/api/logs` 报的) —— 权威历史就在那儿。 */
  logDir: string | null
  /**
   * 还能不能往回读 (还有下一页的起点, 或 daemon 说还有)。
   *
   * ⚠ 它**不是**"历史上没有更早的了"的证明, 只是"这次读到头了"。文件还在被写, 所以
   * 界面把它当成"按钮的可用性", 而不是"历史到此为止"。
   */
  historyAvailable: boolean
  /** 正在回读历史。 */
  loadingHistory: boolean
}

type Listener = () => void

class LogStore {
  private entries: LogEntry[] = []
  /** `entries` 里 `kind === 'sample'` 的那一部分 (见 `getSamples`)。 */
  private sampleEntries: LogEntry[] = []
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
    logDir: null,
    historyAvailable: true,
    loadingHistory: false,
  }
  /** 往更早翻的游标; `null` 且 `historyAvailable` 为 false 表示读到头了。 */
  private historyCursor: string | null = null
  /** 开局补历史只做一次 —— 每次重连都重来一遍是没必要的往返。 */
  private backfilled = false
  /**
   * 序号报出过一个还没补的缺口。
   *
   * ⚠ 不能只靠"开局补过了"这个标志: 缺口的**发生**在开局之后 (队列溢出、页面自己
   * 断线重连), 那时 `backfilled` 早已为 true, 只看它就会把真实缺口放过去。
   */
  private unfilledGap = false
  /** 串行化回读请求的链 (见 `backfill`)。 */
  private loading: Promise<void> = Promise.resolve()
  /** 开局那一次回读: 即使第一页读到头也要给缺口留出一次机会 (见 `backfill`)。 */
  private firstBackfill = true

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
    // 开局补一段历史 —— 页面刚打开时表格里不该是空的。
    void this.backfill()
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

  /**
   * 只取采样记录 (`kind === 'sample'`), 时间正序。
   *
   * 单独留一份而不是每次过滤: 采样 tab 每渲染一次都要它, 而在 5000 条的环里筛一遍
   * 是白花的。它与 `entries` 同步裁剪, 所以两者永远描述同一段时间。
   */
  getSamples(): LogEntry[] {
    return this.sampleEntries
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
    this.sampleEntries = []
    this.pending = []
    this.status = { ...this.status, buffered: 0 }
    this.notify()
    await logDb.clear().catch(() => undefined)
  }

  /** 仅供测试: 把单例恢复到未启动状态。 */
  reset() {
    this.stop()
    this.entries = []
    this.sampleEntries = []
    this.pending = []
    this.historyCursor = null
    this.backfilled = false
    this.unfilledGap = false
    this.loading = Promise.resolve()
    this.firstBackfill = true
    this.status = {
      seq: 0, dropped: 0, clients: 0, missed: 0, metaAt: 0, buffered: 0, writeErrors: 0,
      logDir: null, historyAvailable: true, loadingHistory: false,
    }
  }

  /**
   * 用 daemon 的文件补一段更早的历史 —— 接在内存里最旧那条**之前**。
   *
   * 调用的两个时机都是刻意的 (见 `logHistory.ts`): 开局一次, 以及发现序号出现缺口时
   * 一次。它不轮询。
   */
  /** 供界面调用的入口: 与自动回读排队, 不插队也不被丢掉。 */
  async loadEarlier(): Promise<number> {
    await this.loading
    return this.loadPage()
  }

  /**
   * 真正读一页。
   *
   * ⚠ **不要在这里用 `loadingHistory` 做门禁**: 那个标志是发给界面看的 ("正在读"),
   * 不是锁 —— 自动回读的循环会连着调它两次, 第二次会被自己刚设上的标志挡回去, 于是
   * `loadingHistory` 永远停在 true, 界面从此一直转圈。需要互斥的地方在调用方
   * (`backfill` 的串行链 / `loadEarlier` 的排队)。
   */
  private async loadPage(): Promise<number> {
    this.status = { ...this.status, loadingHistory: true }
    this.notify()
    try {
      const page = await fetchLogHistory({ before: this.historyCursor })
      const older = page.records
        .map((record) => ({ ...record, seq: 0 }))
        .filter((entry) => !this.hasEntry(entry))
      if (older.length > 0) {
        // ⚠ 拼在**前面**: 历史比内存里的都旧。实时流同时还在往后面追加, 两条路径
        // 各写各的一端, 谁也不覆盖谁。
        this.entries = [...older, ...this.entries]
        this.sampleEntries = [...older.filter((e) => e.kind === 'sample'), ...this.sampleEntries]
        if (this.entries.length > MAX_MEMORY_RECORDS) {
          const keep = new Set(this.entries.slice(-MAX_MEMORY_RECORDS))
          this.entries = this.entries.filter((e) => keep.has(e))
          this.sampleEntries = this.sampleEntries.filter((e) => keep.has(e))
        }
        void this.persist(older)
      }
      this.historyCursor = page.cursor
      this.status = {
        ...this.status,
        loadingHistory: false,
        // ⚠ "还有更早的" = "拿到了下一页的起点" **或** "daemon 说还有" —— 两者取或。
        // 只看游标会漏掉一种边界: 有序号缺口时, 缺的那些可能**都比当前最旧的还旧**,
        // 于是这一页返回 0 条且没有游标, 但缺口确实能被补上。
        historyAvailable: page.cursor !== null || page.more,
        logDir: page.dir ?? this.status.logDir,
        buffered: this.entries.length,
      }
      this.notify()
      return older.length
    } catch {
      // 回读失败不影响实时流; 让界面能如实说明"历史这次没读到", 而不是一直转圈。
      this.status = { ...this.status, loadingHistory: false, historyAvailable: false }
      this.notify()
      return 0
    }
  }

  private onLogFrame(msg: Record<string, unknown>) {
    const record = normalizeRecord(msg.record)
    if (!record) return
    const seq = typeof msg.seq === 'number' ? msg.seq : 0
    // 这条 `seq` 我们**收到了**: 相对水位最多漏掉 (seq - 水位) - 1 条 (水位与它本身除外)。
    // ⚠ 缺口在 **`log` 帧上一样会出现** (少收了一条, 下一条的序号就跳了), 不只是
    // `log_meta` 的事。所以这里也要把回读挂上 —— 只在 meta 那条路上做, 就有一半的
    // 缺口永远补不上 (而那一半恰恰是最常见的: 队列溢出丢的正是 log 帧本身)。
    const gap = this.advanceWatermark(seq, { holdsSeq: true })
    const entry: LogEntry = { ...record, seq }
    if (gap) this.armBackfill()
    this.entries.push(entry)
    if (entry.kind === 'sample') this.sampleEntries.push(entry)
    if (this.entries.length > MAX_MEMORY_RECORDS) {
      // 环形缓冲: 从最旧的一端裁掉。内存里留全量会把 WebView 拖垮。
      // ⚠ 采样那一份必须跟着裁到**同一个起点**, 否则它描述的就不是同一段时间了。
      const dropped = this.entries.length - MAX_MEMORY_RECORDS
      const droppedSamples = new Set(
        this.entries.slice(0, dropped).filter((e) => e.kind === 'sample'),
      )
      this.entries.splice(0, dropped)
      if (droppedSamples.size > 0) {
        this.sampleEntries = this.sampleEntries.filter((e) => !droppedSamples.has(e))
      }
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
    // meta 的 `seq` 是"已广播到哪", 而**这一条我们没有收到** ⇒ 漏掉的数目是差值本身。
    const gap = this.advanceWatermark(seq, { holdsSeq: false })
    this.status = { ...this.status, dropped, clients, metaAt: Date.now() }
    this.notify()
    if (gap) this.armBackfill()
  }

  /** 记下"有一个缺口要补", 并把回读挂上 —— 两条发现缺口的路径共用它。 */
  private armBackfill() {
    // 这是序号存在的**理由**: 空白与"什么都没发生"在界面上长得一样, 而文件里那段
    // 记录一直都在。
    this.unfilledGap = true
    void this.backfill()
  }

  /**
   * 补历史: 开局一次, 以及每次发现缺口之后一次。
   *
   * ⚠ 这里**串行化**而不是"正在读就返回": 缺口几乎总是出现在某次读还没结束的时候
   * (开局那次回读要几十毫秒, 而期间状态帧一直在跑), 一见到 `loadingHistory` 就退出
   * 等于把真正需要补的那一次丢掉 —— 页面上就留下一个永远填不上的洞。
   *
   * ⚠ 缺口标志只在**一次读真正结束之后**才复位, 且结束前会再看一眼: 读的过程中可能
   * 又发现新的缺口, 那时要接着读, 而不是把标志丢掉。
   */
  private backfill(): Promise<void> {
    if (this.backfilled && !this.unfilledGap) return this.loading
    this.backfilled = true
    this.loading = this.loading.then(async () => {
      // ⚠ 就算上一页读到头了 (`historyAvailable` 为 false) 也要**再试一次**: 报出缺口
      // 就意味着文件里确实有这段记录 (它刚被写下去), 而 `historyAvailable` 说的只是
      // "上一次那一页读到头了"。
      do {
        this.unfilledGap = false
        await this.loadPage()
      } while (this.unfilledGap && (this.status.historyAvailable || this.firstBackfill))
      this.firstBackfill = false
    })
    return this.loading
  }

  private hasEntry(entry: LogEntry): boolean {
    // 去重用 (tsNs, event): 实时流与回读可能拿到同一条记录 (回读在当前文件里也能
    // 看到刚刚广播过的那几条), 而两者的 `seq` 不同 (回读的是 0)。
    return this.entries.some(
      (existing) => existing.tsNs === entry.tsNs && existing.event === entry.event,
    )
  }

  private async persist(entries: LogEntry[]) {
    try {
      await logDb.add(entries)
    } catch {
      this.status = { ...this.status, writeErrors: this.status.writeErrors + 1 }
    }
  }

  /**
   * 推进"已见到哪一号"的水位线, 并累加中间漏掉的条数。
   *
   * ⚠ 水位线**只有这一条**, `log` 帧与 `log_meta` 共用它, 但两者"是否持有该号"不同:
   * `log` 帧的 `seq` 是它自己的 (持有), `log_meta` 的 `seq` 是"已广播到哪" (不持有)。
   * 若各用各的水位, 一次真实的缺口会被数两遍: log 帧报一次, 紧接着的 meta 拿一个更大
   * 的序号再报一次 —— "漏收"这个数会被放大成谎言。
   */
  private advanceWatermark(seq: number, { holdsSeq }: { holdsSeq: boolean }): boolean {
    if (!Number.isFinite(seq) || seq <= 0) return false
    const watermark = this.status.seq
    let sawGap = false
    if (watermark > 0 && seq > watermark) {
      const missing = seq - watermark - (holdsSeq ? 1 : 0)
      if (missing > 0) {
        sawGap = true
        this.status = { ...this.status, missed: this.status.missed + missing }
      }
    }
    if (seq > watermark) this.status = { ...this.status, seq }
    return sawGap
  }

  private async flush() {
    if (this.pending.length === 0) return
    const batch = this.pending.splice(0, this.pending.length)
    const before = this.status.writeErrors
    try {
      await logDb.add(batch)
    } catch {
      // 缓存写失败 (配额不足/隐私模式) 只计数, 不抛: 权威历史在 daemon 的文件里,
      // 这里丢的是一份副本。界面会显示这个计数, 而不是假装没事。
      this.status = { ...this.status, writeErrors: before + 1 }
    }
    if (this.status.writeErrors !== before) this.notify()
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

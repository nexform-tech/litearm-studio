/**
 * 页面侧的日志缓存 (IndexedDB) —— **只是缓存**, 权威历史在 daemon 的文件里。
 *
 * 谁读这个文件: 要理解"为什么刷新页面还能看到刚才的日志"的人, 以及将来接
 * `/api/logs` 回读的人。
 *
 * ⚠ 这一层的定位是刻意的, 也是 issue #80 的教训: daemon 每次启动可能拿到不同的端口,
 * 而页面 origin 跟着端口变 (`location.host`), 于是 IndexedDB 库也跟着换。**记录不
 * 丢在那里** —— 它们根本不在这里, 而在 daemon 的状态目录里。这里存一份, 只是为了:
 *
 * - 刷新页面之后, 实时流还没补上历史的那几秒里, 表格不是空的;
 * - daemon 短暂不可达时, 操作员仍能回看最近这一段;
 * - 页面自己 (浏览器侧) 也能按体积保留, 不至于把配额吃光。
 *
 * 所以这里的库名、容量、淘汰策略都**可以**变, 不许把任何"历史可靠性"的承诺压在上面。
 */
import { estimateRecordBytes, type LogEntry } from './schema'

const DB_NAME = 'litearm-studio-logs'
const DB_VERSION = 1
const STORE = 'logRecords'

/** 页面上保留多少条。内存里读 5000 条 × 约 400B ≈ 2MB, 对 WebView 是安全的。 */
export const MAX_MEMORY_RECORDS = 5000

/** 库里的上限 (条数, 不是字节): 缓存而已, 给手机/低配机留足配额余量。 */
export const MAX_STORED_RECORDS = 20000

class LogDb {
  private dbPromise: Promise<IDBDatabase> | null = null

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise
    if (typeof indexedDB === 'undefined') {
      this.dbPromise = Promise.reject(new Error('当前环境不支持 IndexedDB'))
      return this.dbPromise
    }
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true })
          // 按 (tsNs, seq) 取: 最新在后, 便于"取最近 N 条"。
          store.createIndex('byTs', ['tsNs', 'seq'])
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'))
    })
    return this.dbPromise
  }

  private request<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('IndexedDB 请求失败'))
    })
  }

  private done(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'))
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'))
    })
  }

  /** 写入一批记录, 并按条数淘汰最旧的。失败不抛 —— 缓存写不进去不该影响实时流。 */
  async add(entries: LogEntry[]): Promise<void> {
    if (entries.length === 0) return
    const db = await this.open()
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    for (const entry of entries) {
      // ⚠ 必须真的**不带** `id`, 而不是带一个 `id: undefined`: 后者的键路径求值结果
      // 不是有效 key, IndexedDB 直接抛 DataError, autoIncrement 也就永远不触发。
      const { id: _dropped, ...row } = entry
      void _dropped
      store.add(row)
    }
    await this.done(tx)
    await this.prune()
  }

  private async prune(): Promise<void> {
    const db = await this.open()
    const count = await this.request(db.transaction(STORE, 'readonly').objectStore(STORE).count())
    const excess = Number(count) - MAX_STORED_RECORDS
    if (excess <= 0) return
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    // 游标从最旧往前走: `id` 单调递增 (autoIncrement), 与写入顺序一致。
    let deleted = 0
    await new Promise<void>((resolve, reject) => {
      const req = store.openCursor()
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor || deleted >= excess) {
          resolve()
          return
        }
        cursor.delete()
        deleted += 1
        cursor.continue()
      }
      req.onerror = () => reject(req.error ?? new Error('裁剪日志缓存失败'))
    })
    await this.done(tx)
  }

  /** 最近 `limit` 条, **时间正序**返回 (最新在最后)。 */
  async recent(limit: number): Promise<LogEntry[]> {
    const db = await this.open()
    const tx = db.transaction(STORE, 'readonly')
    const index = tx.objectStore(STORE).index('byTs')
    const rows: LogEntry[] = []
    await new Promise<void>((resolve, reject) => {
      const req = index.openCursor(null, 'prev')
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor || rows.length >= limit) {
          resolve()
          return
        }
        rows.push(cursor.value as LogEntry)
        cursor.continue()
      }
      req.onerror = () => reject(req.error ?? new Error('读取日志缓存失败'))
    })
    return rows.reverse()
  }

  async count(): Promise<number> {
    const db = await this.open()
    const count = await this.request(db.transaction(STORE, 'readonly').objectStore(STORE).count())
    return Number(count)
  }

  async clear(): Promise<void> {
    const db = await this.open()
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).clear()
    await this.done(tx)
  }

  /** 缓存占用的估算字节数 (用于界面显示"这份缓存有多大")。 */
  async estimatedBytes(): Promise<number> {
    const rows = await this.recent(200)
    if (rows.length === 0) return 0
    const perRow = rows.reduce((sum, row) => sum + estimateRecordBytes(row), 0) / rows.length
    return Math.round(perRow * (await this.count()))
  }
}

export const logDb = new LogDb()

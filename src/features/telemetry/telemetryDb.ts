/**
 * 遥测日志本地存储（IndexedDB）。
 *
 * 数据完全留在本机（浏览器应用数据目录），不需要管理服务：
 * - sessions：一次臂连接（断线 30s 内重连则延续）对应一个会话
 * - samples：RobotState 采样（10Hz 降采样后的 q/dq/tau/temps/errs/faults）
 */

export type TelemetrySample = {
  id?: number
  sessionId: number
  ts: number
  state: string
  q: number[]
  dq: number[]
  tau: number[]
  temps: { mosTemp: number; coilTemp: number }[]
  errs: number[]
  faults: { joint: number; errCode: number }[]
}

export type NewTelemetrySample = Omit<TelemetrySample, 'id' | 'sessionId'>

type SessionRow = {
  id: number
  startedAt: number
  endedAt: number | null
  endpoint: string
  robotSerial: string
  estimatedBytes: number
}

export type TelemetrySession = SessionRow & {
  sampleCount: number
}

const DB_NAME = 'litearm-studio-telemetry'
const DB_VERSION = 3
const SESSION_STORE = 'sessions'
const SAMPLE_STORE = 'samples'

// 按体积（而非条数/时间）保留：上限由用户设置（默认 10MB，范围见
// retentionSettings.ts）。IndexedDB 不暴露单条记录大小，由 estimateSampleBytes
// 估算（校准自 V8 结构化克隆实测 + 索引项开销）。
export const MAX_SESSIONS = 200

/** 估算一条采样在 IndexedDB 中的体积（字节）。
 *  校准自 V8 structuredClone 序列化实测：7 关节样本约 550B（JSON 约 427B），
 *  另加索引项（主键 + sessionId + bySessionTsId）约 64B 的保守开销。
 *  该估算值同时用于写入时的会话累计与裁剪时的扣减，保证口径一致。 */
export function estimateSampleBytes(sample: NewTelemetrySample): number {
  const stateExtra = new TextEncoder().encode(sample.state).length - 'holding'.length
  return (
    70 + // 记录头 + id/sessionId/ts + 各数组头
    8 * (sample.q.length + sample.dq.length + sample.tau.length + sample.errs.length) +
    37 * sample.temps.length +
    22 * sample.faults.length +
    stateExtra +
    64 // 索引项开销
  )
}

class TelemetryDb {
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
        const tx = req.transaction
        if (!db.objectStoreNames.contains(SESSION_STORE)) {
          const store = db.createObjectStore(SESSION_STORE, { keyPath: 'id', autoIncrement: true })
          store.createIndex('startedAt', 'startedAt')
        }
        if (!db.objectStoreNames.contains(SAMPLE_STORE)) {
          const store = db.createObjectStore(SAMPLE_STORE, { keyPath: 'id', autoIncrement: true })
          store.createIndex('sessionId', 'sessionId')
        }
        const sampleStore = tx?.objectStore(SAMPLE_STORE)
        if (sampleStore) {
          // v2：会话内复合索引（sessionId, ts, id），替代按全局 ts 索引全量扫描
          if (!sampleStore.indexNames.contains('bySessionTsId')) {
            sampleStore.createIndex('bySessionTsId', ['sessionId', 'ts', 'id'])
          }
          if (sampleStore.indexNames.contains('ts')) {
            sampleStore.deleteIndex('ts')
          }
        }
        // v3：按体积上限保留，为旧数据回填 estimatedBytes（逐条估算，一次性迁移）
        const sessionStore = tx?.objectStore(SESSION_STORE)
        if (sampleStore && sessionStore) {
          const perSession = new Map<number, number>()
          const sampleCursor = sampleStore.openCursor()
          sampleCursor.onsuccess = () => {
            const cursor = sampleCursor.result
            if (!cursor) {
              const sessionCursor = sessionStore.openCursor()
              sessionCursor.onsuccess = () => {
                const sc = sessionCursor.result
                if (!sc) return
                const row = sc.value as SessionRow
                if (row.estimatedBytes === undefined) {
                  row.estimatedBytes = perSession.get(row.id) ?? 0
                  sc.update(row)
                }
                sc.continue()
              }
              return
            }
            const row = cursor.value as TelemetrySample
            perSession.set(row.sessionId, (perSession.get(row.sessionId) ?? 0) + estimateSampleBytes(row))
            cursor.continue()
          }
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

  async addSession(startedAt: number, endpoint: string, robotSerial: string): Promise<number> {
    const db = await this.open()
    const tx = db.transaction(SESSION_STORE, 'readwrite')
    const id = await this.request(
      tx.objectStore(SESSION_STORE).add({ startedAt, endedAt: null, endpoint, robotSerial, estimatedBytes: 0 }),
    )
    await this.done(tx)
    return id as number
  }

  async endSession(id: number, endedAt: number): Promise<void> {
    const db = await this.open()
    const tx = db.transaction(SESSION_STORE, 'readwrite')
    const store = tx.objectStore(SESSION_STORE)
    const row = (await this.request(store.get(id))) as SessionRow | undefined
    if (row) {
      row.endedAt = endedAt
      await this.request(store.put(row))
    }
    await this.done(tx)
  }

  /** 上次应用退出时未收尾的会话统一标记为已结束。 */
  async finalizeOpenSessions(): Promise<void> {
    const db = await this.open()
    const tx = db.transaction(SESSION_STORE, 'readwrite')
    const store = tx.objectStore(SESSION_STORE)
    const rows = (await this.request(store.getAll())) as SessionRow[]
    const now = Date.now() / 1000
    for (const row of rows) {
      if (row.endedAt === null) {
        row.endedAt = now
        await this.request(store.put(row))
      }
    }
    await this.done(tx)
  }

  async addSamples(sessionId: number, samples: NewTelemetrySample[]): Promise<void> {
    if (samples.length === 0) return
    const db = await this.open()
    const tx = db.transaction([SAMPLE_STORE, SESSION_STORE], 'readwrite')
    const store = tx.objectStore(SAMPLE_STORE)
    let batchBytes = 0
    for (const sample of samples) {
      store.add({ ...sample, sessionId })
      batchBytes += estimateSampleBytes(sample)
    }
    // 会话累计估算体积，供按字节上限裁剪
    const sessionStore = tx.objectStore(SESSION_STORE)
    const row = (await this.request(sessionStore.get(sessionId))) as SessionRow | undefined
    if (row) {
      row.estimatedBytes = (row.estimatedBytes ?? 0) + batchBytes
      await this.request(sessionStore.put(row))
    }
    await this.done(tx)
  }

  async listSessions(limit = 100): Promise<TelemetrySession[]> {
    const db = await this.open()
    const tx = db.transaction([SESSION_STORE, SAMPLE_STORE], 'readonly')
    const sessions = (await this.request(tx.objectStore(SESSION_STORE).getAll())) as SessionRow[]
    sessions.sort((a, b) => b.id - a.id)
    // 单个事务内批量统计 sampleCount，避免每个会话单独开事务
    const sampleIndex = tx.objectStore(SAMPLE_STORE).index('sessionId')
    const result: TelemetrySession[] = []
    for (const s of sessions.slice(0, limit)) {
      const count = Number(await this.request(sampleIndex.count(IDBKeyRange.only(s.id))))
      result.push({ ...s, sampleCount: count })
    }
    await this.done(tx)
    return result
  }

  async getSession(id: number): Promise<TelemetrySession | null> {
    const db = await this.open()
    const tx = db.transaction([SESSION_STORE, SAMPLE_STORE], 'readonly')
    const row = (await this.request(tx.objectStore(SESSION_STORE).get(id))) as SessionRow | undefined
    if (!row) return null
    const count = Number(await this.request(tx.objectStore(SAMPLE_STORE).index('sessionId').count(IDBKeyRange.only(id))))
    await this.done(tx)
    return { ...row, sampleCount: count }
  }

  async countSamples(sessionId: number): Promise<number> {
    const db = await this.open()
    const tx = db.transaction(SAMPLE_STORE, 'readonly')
    const index = tx.objectStore(SAMPLE_STORE).index('sessionId')
    const count = await this.request(index.count(IDBKeyRange.only(sessionId)))
    return Number(count)
  }

  async totalSamples(): Promise<number> {
    const db = await this.open()
    const tx = db.transaction(SAMPLE_STORE, 'readonly')
    const count = await this.request(tx.objectStore(SAMPLE_STORE).count())
    return Number(count)
  }

  async totalSessions(): Promise<number> {
    const db = await this.open()
    const tx = db.transaction(SESSION_STORE, 'readonly')
    const count = await this.request(tx.objectStore(SESSION_STORE).count())
    return Number(count)
  }

  /** 按会话内时间倒序取采样；beforeTs 用于向前翻页，afterTs 用于增量拉新。
   *  走会话内复合索引（sessionId, ts, id），不经过全局 ts 全量扫描。 */
  async getSamples(
    sessionId: number,
    opts: { limit?: number; beforeTs?: number; afterTs?: number } = {},
  ): Promise<TelemetrySample[]> {
    const { limit = 200, beforeTs, afterTs } = opts
    const db = await this.open()
    const tx = db.transaction(SAMPLE_STORE, 'readonly')
    const index = tx.objectStore(SAMPLE_STORE).index('bySessionTsId')
    const range =
      beforeTs !== undefined
        ? IDBKeyRange.bound([sessionId, -Infinity, -Infinity], [sessionId, beforeTs, Infinity])
        : afterTs !== undefined
          ? IDBKeyRange.bound([sessionId, afterTs, -Infinity], [sessionId, Infinity, Infinity])
          : IDBKeyRange.bound([sessionId, -Infinity, -Infinity], [sessionId, Infinity, Infinity])
    const rows: TelemetrySample[] = []
    await new Promise<void>((resolve, reject) => {
      const req = index.openCursor(range, 'prev')
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor || rows.length >= limit) {
          resolve()
          return
        }
        const row = cursor.value as TelemetrySample
        if ((beforeTs !== undefined && row.ts >= beforeTs) || (afterTs !== undefined && row.ts < afterTs)) {
          cursor.continue()
          return
        }
        rows.push(row)
        cursor.continue()
      }
      req.onerror = () => reject(req.error ?? new Error('查询采样失败'))
    })
    return rows
  }

  /** 按时间正序分页取某会话采样（CSV 导出流式读取用）。
   *  after 为上一页最后一条的 (ts, id)：id 唯一，以它做边界保证不重不漏，
   *  即使同一 ts 有多条采样也不会跨页丢数据。 */
  async getSamplesAsc(
    sessionId: number,
    opts: { limit?: number; after?: { ts: number; id: number } } = {},
  ): Promise<TelemetrySample[]> {
    const { limit = 5000, after } = opts
    const db = await this.open()
    const tx = db.transaction(SAMPLE_STORE, 'readonly')
    const index = tx.objectStore(SAMPLE_STORE).index('bySessionTsId')
    const range =
      after === undefined
        ? IDBKeyRange.bound([sessionId, -Infinity, -Infinity], [sessionId, Infinity, Infinity])
        : IDBKeyRange.bound([sessionId, after.ts, after.id], [sessionId, Infinity, Infinity], true)
    const rows: TelemetrySample[] = []
    await new Promise<void>((resolve, reject) => {
      const req = index.openCursor(range, 'next')
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor || rows.length >= limit) {
          resolve()
          return
        }
        rows.push(cursor.value as TelemetrySample)
        cursor.continue()
      }
      req.onerror = () => reject(req.error ?? new Error('读取采样失败'))
    })
    return rows
  }

  /** 硬性上限：总采样估算体积超过 maxBytes 时删除最旧数据；会话数超过
   *  maxSessions 时删旧会话；无采样的会话一并清理。 */
  async pruneToMaxBytes(maxBytes: number, maxSessions = MAX_SESSIONS): Promise<number> {
    const db = await this.open()
    const tx = db.transaction([SESSION_STORE, SAMPLE_STORE], 'readwrite')
    const sampleStore = tx.objectStore(SAMPLE_STORE)
    const sessionStore = tx.objectStore(SESSION_STORE)
    const sampleIndex = sampleStore.index('bySessionTsId')
    const countIndex = sampleStore.index('sessionId')

    const sessions = (await this.request(sessionStore.getAll())) as SessionRow[]
    sessions.sort((a, b) => a.id - b.id) // 最旧在前
    let totalBytes = sessions.reduce((sum, s) => sum + (s.estimatedBytes ?? 0), 0)
    let deleted = 0

    // 1) 优先整体淘汰最旧会话（数据按会话时间序写入，最旧会话必然是最早的数据）；
    //    保留最新一个会话，避免把全部数据清空
    for (let i = 0; i < sessions.length - 1 && totalBytes > maxBytes; i++) {
      const s = sessions[i]
      const sampleIds = (await this.request(
        sampleIndex.getAllKeys(IDBKeyRange.bound([s.id, -Infinity, -Infinity], [s.id, Infinity, Infinity])),
      )) as IDBValidKey[]
      deleted += sampleIds.length
      for (const key of sampleIds) sampleStore.delete(key)
      sessionStore.delete(s.id)
      totalBytes -= s.estimatedBytes ?? 0
    }

    // 2) 最新会话本身仍超限：从该会话最旧采样开始逐条裁剪
    const newest = sessions[sessions.length - 1]
    if (newest && totalBytes > maxBytes) {
      let trimmedBytes = 0
      await new Promise<void>((resolve, reject) => {
        const req = sampleIndex.openCursor(
          IDBKeyRange.bound([newest.id, -Infinity, -Infinity], [newest.id, Infinity, Infinity]),
          'next',
        )
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor || totalBytes <= maxBytes) {
            resolve()
            return
          }
          const row = cursor.value as TelemetrySample
          const rowBytes = estimateSampleBytes(row)
          trimmedBytes += rowBytes
          totalBytes -= rowBytes
          cursor.delete()
          deleted += 1
          cursor.continue()
        }
        req.onerror = () => reject(req.error ?? new Error('裁剪采样失败'))
      })
      if (trimmedBytes > 0) {
        newest.estimatedBytes = Math.max(0, (newest.estimatedBytes ?? 0) - trimmedBytes)
        await this.request(sessionStore.put(newest))
      }
    }

    // 3) 会话数上限 + 无采样会话清理
    sessions.sort((a, b) => b.id - a.id)
    for (const s of sessions.slice(maxSessions)) {
      sessionStore.delete(s.id)
    }
    for (const s of sessions) {
      // 仍在记录的会话可能刚建立、采样尚未落盘：不能当作空会话清理，
      // 否则保存/触发裁剪时会删掉正在记录的会话，选中状态被拽到旧会话；
      // 已结束的空会话（快速断开等遗留）仍正常清理
      if (s.endedAt === null) continue
      const count = Number(await this.request(countIndex.count(IDBKeyRange.only(s.id))))
      if (count === 0) sessionStore.delete(s.id)
    }

    await this.done(tx)
    return deleted
  }

  async clearAll(): Promise<void> {
    const db = await this.open()
    const tx = db.transaction([SESSION_STORE, SAMPLE_STORE], 'readwrite')
    tx.objectStore(SESSION_STORE).clear()
    tx.objectStore(SAMPLE_STORE).clear()
    await this.done(tx)
  }
}

export const telemetryDb = new TelemetryDb()

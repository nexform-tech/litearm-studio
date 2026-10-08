/**
 * 从 daemon 回读历史记录 —— `/api/logs` 的客户端。
 *
 * 谁读这个文件: 要理解"页面上更早的日志从哪来"的人。
 *
 * 为什么需要它 (issue #80): 页面自己那份 IndexedDB 缓存跟 origin 走, 而 origin 跟
 * daemon 的端口走。端口一变, 缓存里就什么都不剩 —— 但 daemon 的 JSONL 文件一直在。
 * 所以"历史"这件事只能由 daemon 回答, 页面负责把答案接上。
 *
 * ⚠ 这是**页面唯一会主动读文件的地方**, 调用时机是刻意的: 只有开局补一次, 以及发现
 * 序号出现缺口时补一次。它不做轮询 —— 实时的那条路是 WS, 回读只是为了把空白填上。
 */
import type { LogRecord } from './schema'
import { normalizeRecord } from './schema'

/** 一页多少条。与 daemon 的 `logread.DEFAULT_LIMIT` 一致。 */
export const HISTORY_PAGE_SIZE = 200

export type HistoryPage = {
  records: LogRecord[]
  /** 继续往更早翻的游标; `null` = 没有更早的了。 */
  cursor: string | null
  more: boolean
  /** daemon 正在写的日志目录 —— 界面上显示"权威历史在哪"。 */
  dir: string | null
  /** 这份日志一共轮转过几个文件 (含当前那个)。 */
  fileCount: number
}

const EMPTY: HistoryPage = { records: [], cursor: null, more: false, dir: null, fileCount: 0 }

export type HistoryQuery = {
  limit?: number
  before?: string | null
  level?: string
  kind?: string
  event?: string
  q?: string
}

/**
 * 取一页历史。
 *
 * 失败一律**降级成空页而不是抛**: 页面上的日志视图不该因为一次 HTTP 抖动就变成错误
 * 提示 —— 实时流还在跑, 操作员要看的记录就在那儿。`historyAvailable` 会变成 false,
 * 界面据此说"历史读不到, 但实时流还在"。
 */
export async function fetchLogHistory(query: HistoryQuery = {}): Promise<HistoryPage> {
  const params = new URLSearchParams()
  params.set('limit', String(query.limit ?? HISTORY_PAGE_SIZE))
  if (query.before) params.set('before', query.before)
  if (query.level) params.set('level', query.level)
  if (query.kind) params.set('kind', query.kind)
  if (query.event) params.set('event', query.event)
  if (query.q) params.set('q', query.q)

  const response = await fetch(`/api/logs?${params.toString()}`)
  if (!response.ok) throw new Error(`/api/logs 返回 ${response.status}`)
  const body = (await response.json()) as {
    records?: unknown
    cursor?: unknown
    more?: unknown
    dir?: unknown
    fileCount?: unknown
  }
  const records: LogRecord[] = []
  for (const raw of Array.isArray(body.records) ? body.records : []) {
    const record = normalizeRecord(raw)
    if (record) records.push(record)
  }
  return {
    records,
    cursor: typeof body.cursor === 'string' ? body.cursor : null,
    more: body.more === true,
    dir: typeof body.dir === 'string' ? body.dir : null,
    fileCount: typeof body.fileCount === 'number' ? body.fileCount : 0,
  }
}

/** 空页 —— 与 `fetchLogHistory` 的成功形状一致, 供降级路径使用。 */
export function emptyHistoryPage(): HistoryPage {
  return { ...EMPTY }
}

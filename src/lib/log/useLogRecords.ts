import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { logStore, type LogStreamStatus } from './logStore'
import { logDb } from './logDb'
import {
  matchesFilters,
  SEVERITIES,
  type LogEntry,
  type LogKind,
  type Severity,
} from './schema'

/** 一屏最多渲染多少条。5000 条全塞进 DOM 会让低配 WebView 卡死。 */
const VISIBLE_LIMIT = 500

/** `log_meta` 超过这个时间没来就算"流不动了"(daemon 的心跳是 2s)。 */
const STALE_AFTER_MS = 6000

export type LogFilters = {
  level: Severity | 'ALL'
  kind: LogKind | 'ALL'
  query: string
}

const EMPTY_FILTERS: LogFilters = { level: 'ALL', kind: 'ALL', query: '' }

/**
 * 日志页的视图模型 —— 数据只有两个来源: `logStore` (实时流 + 缓存) 与 `logDb` (缓存大小)。
 *
 * 过滤都在**内存里**做: 页面保留的是最近 5000 条, 这个量级下每次 render 扫一遍比往返
 * 一次 IndexedDB 便宜得多, 而且拖动搜索框时不会有异步空窗。
 */
export function useLogRecords() {
  const { t, i18n } = useTranslation('logs')
  const [entries, setEntries] = useState<LogEntry[]>(() => logStore.getEntries())
  const [samples, setSamples] = useState<LogEntry[]>(() => logStore.getSamples())
  const [status, setStatus] = useState<LogStreamStatus>(() => logStore.getStatus())
  const [filters, setFilters] = useState<LogFilters>(EMPTY_FILTERS)
  const [cacheCount, setCacheCount] = useState(0)
  const [cacheBytes, setCacheBytes] = useState(0)
  const [cacheError, setCacheError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // 实时流: 订阅一次, 每次落一条记录就同步一次快照。
  useEffect(
    () =>
      logStore.subscribe(() => {
        setEntries([...logStore.getEntries()])
        setSamples([...logStore.getSamples()])
        setStatus(logStore.getStatus())
      }),
    [],
  )

  // 首次打开: 先把缓存里的记录填进来, 再数一下缓存有多大。
  useEffect(() => {
    void logStore.hydrate().then(() => {
      setEntries([...logStore.getEntries()])
      setSamples([...logStore.getSamples()])
      setStatus(logStore.getStatus())
    })
    let cancelled = false
    void (async () => {
      try {
        const [count, bytes] = await Promise.all([logDb.count(), logDb.estimatedBytes()])
        if (!cancelled) {
          setCacheCount(count)
          setCacheBytes(bytes)
        }
      } catch (err) {
        if (!cancelled) setCacheError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 让"多久没有更新了"能自己往前走, 而不是等下一帧才刷新。
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const filtered = useMemo(
    () => entries.filter((entry) => matchesFilters(entry, filters)),
    [entries, filters],
  )
  const visible = useMemo(
    () => filtered.slice(Math.max(0, filtered.length - VISIBLE_LIMIT)),
    [filtered],
  )

  const setLevel = useCallback((level: LogFilters['level']) => {
    setFilters((prev) => ({ ...prev, level }))
  }, [])
  const setKind = useCallback((kind: LogFilters['kind']) => {
    setFilters((prev) => ({ ...prev, kind }))
  }, [])
  const setQuery = useCallback((query: string) => {
    setFilters((prev) => ({ ...prev, query }))
  }, [])
  const clearFilters = useCallback(() => setFilters(EMPTY_FILTERS), [])

  const loadEarlier = useCallback(() => {
    void logStore.loadEarlier()
  }, [])

  const clearCache = useCallback(async () => {
    try {
      await logStore.clear()
      setCacheCount(0)
      setCacheBytes(0)
      setCacheError(null)
    } catch (err) {
      setCacheError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const staleSeconds = status.metaAt === 0 ? 0 : Math.floor((now - status.metaAt) / 1000)
  const stale = status.metaAt > 0 && now - status.metaAt > STALE_AFTER_MS

  return {
    t,
    locale: i18n.language,
    entries,
    samples,
    visible,
    total: filtered.length,
    truncated: filtered.length > visible.length,
    filters,
    setLevel,
    setKind,
    setQuery,
    clearFilters,
    loadEarlier,
    filteredActive:
      filters.level !== 'ALL' || filters.kind !== 'ALL' || filters.query.trim() !== '',
    status,
    stale,
    staleSeconds,
    cacheCount,
    cacheBytes,
    cacheError,
    clearCache,
  }
}

export { SEVERITIES, VISIBLE_LIMIT }
export type { LogEntry, Severity, LogKind }

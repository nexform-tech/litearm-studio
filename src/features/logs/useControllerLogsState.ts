import { useCallback, useEffect, useState } from 'react'
import { armClient, formatArmError } from '@/lib/arm'

export type ControllerLogEntry = {
  timestamp: string
  level: string
  logger?: string
  message: string
}

const PAGE_SIZE = 50
const AUTO_REFRESH_MS = 5000

/** 把 get_logs 的响应规整成条目列表（上游返回格式未知，防御性兼容）。 */
export function normalizeControllerLogs(raw: unknown): { items: ControllerLogEntry[]; total: number } {
  const obj = (raw ?? {}) as Record<string, unknown>
  const arr = Array.isArray(obj.items) ? obj.items : Array.isArray(obj.logs) ? obj.logs : Array.isArray(raw) ? raw : []
  const items = (arr as unknown[]).map((x) => {
    const r = (x ?? {}) as Record<string, unknown>
    return {
      timestamp: String(r.timestamp ?? r.ts ?? r.time ?? r.created_at ?? ''),
      level: String(r.level ?? r.severity ?? 'INFO').toUpperCase(),
      logger: r.logger || r.module ? String(r.logger ?? r.module ?? '') : undefined,
      message: String(r.message ?? r.msg ?? ''),
    }
  })
  const total = Number(obj.total ?? items.length)
  return { items, total: Number.isFinite(total) ? total : items.length }
}

/** 控制器日志查询状态：通过机械臂 WebSocket 的 get_logs RPC 读取 litearm-server 日志。 */
export function useControllerLogsState() {
  const connected = armClient.status === 'connected'
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [entries, setEntries] = useState<ControllerLogEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const [autoRefresh, setAutoRefresh] = useState(true)

  useEffect(() => {
    const id = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(id)
  }, [search])

  useEffect(() => {
    let cancelled = false
    if (!connected) {
      setEntries([])
      setTotal(0)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    armClient
      .withArm((a) => a.getLogs(page, PAGE_SIZE, debounced))
      .then((raw) => {
        if (cancelled) return
        const { items, total: t } = normalizeControllerLogs(raw)
        setEntries(items)
        setTotal(t)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setEntries([])
        setTotal(0)
        setError(formatArmError(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [page, debounced, refreshTick, connected])

  // 停留在控制器日志页签时每 5s 自动刷新；可暂停
  useEffect(() => {
    if (!autoRefresh) return
    const timer = setInterval(() => setRefreshTick((n) => n + 1), AUTO_REFRESH_MS)
    return () => clearInterval(timer)
  }, [autoRefresh])

  const refresh = useCallback(() => setRefreshTick((n) => n + 1), [])

  return {
    connected,
    entries,
    total,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    page,
    pageSize: PAGE_SIZE,
    loading,
    error,
    search,
    autoRefresh,
    setSearch: (v: string) => {
      setPage(1)
      setSearch(v)
    },
    setPage,
    refresh,
    toggleAutoRefresh: () => setAutoRefresh((v) => !v),
  }
}

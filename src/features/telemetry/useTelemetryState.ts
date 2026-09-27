import { useCallback, useEffect, useRef, useState } from 'react'
import { useArmConnection } from '@/lib/arm/useArmConnection'
import { telemetryDb, type TelemetrySample, type TelemetrySession } from './telemetryDb'
import { telemetryRecorder } from './telemetryRecorder'
import { telemetryCsvHeader, telemetryCsvRow } from './csv'
import { RETENTION_MAX_MB, RETENTION_MIN_MB } from './retentionSettings'

const SAMPLES_LIMIT = 200
const MAX_LIVE_SAMPLES = 500
const MAX_VIEW_SAMPLES = 2000
const AUTO_REFRESH_MS = 3000
const EXPORT_PAGE_SIZE = 5000

export function useTelemetryState() {
  const { status: armStatus, conn } = useArmConnection()
  const [sessions, setSessions] = useState<TelemetrySession[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [session, setSession] = useState<TelemetrySession | null>(null)
  const [samples, setSamples] = useState<TelemetrySample[]>([])
  const [loading, setLoading] = useState(true)
  const [samplesLoading, setSamplesLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const [pagedBack, setPagedBack] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [exporting, setExporting] = useState<number | null>(null)
  const [recorderStatus, setRecorderStatus] = useState(telemetryRecorder.getStatus())
  const [totalSamples, setTotalSamples] = useState(0)
  const [totalSessions, setTotalSessions] = useState(0)
  const [followLatest, setFollowLatest] = useState(true)
  const followLatestRef = useRef(true)
  const sessionsRef = useRef<TelemetrySession[]>([])
  const samplesRef = useRef<TelemetrySample[]>([])
  const newestTsRef = useRef<number | null>(null)

  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  useEffect(() => {
    samplesRef.current = samples
  }, [samples])

  // 记录器开/停会话时立即刷新状态（否则等下一个 3s 周期）
  useEffect(
    () => telemetryRecorder.subscribe(() => setRecorderStatus(telemetryRecorder.getStatus())),
    [],
  )

  // 会话列表 + 累计统计：停留本页时每 3s 刷新
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([telemetryDb.listSessions(100), telemetryDb.totalSamples(), telemetryDb.totalSessions()])
      .then(([sess, totalS, totalN]) => {
        if (cancelled) return
        setSessions(sess)
        setTotalSamples(totalS)
        setTotalSessions(totalN)
        setRecorderStatus(telemetryRecorder.getStatus())
        // 默认选中最新会话；新会话出现时自动跟随（未手动选旧会话时）
        if (sess.length > 0) {
          const latestId = sess[0].id
          setSelectedId((prev) => {
            if (prev === null || prev === undefined) return latestId
            if (followLatestRef.current && latestId !== prev) return latestId
            return prev
          })
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [refreshTick])

  useEffect(() => {
    const timer = setInterval(() => setRefreshTick((n) => n + 1), AUTO_REFRESH_MS)
    return () => clearInterval(timer)
  }, [])

  // 切换会话时重置采样视图（清掉历史浏览状态、旧采样与最新时间戳）
  const prevSelectedRef = useRef<number | null>(null)
  useEffect(() => {
    if (selectedId !== prevSelectedRef.current) {
      prevSelectedRef.current = selectedId
      if (selectedId !== null) {
        setPagedBack(false)
        newestTsRef.current = null
        setSamples([])
        setSession(null)
        setHasMore(false)
      }
    }
  }, [selectedId])

  // 选中会话的采样：每 3s 刷新一次。
  // - 还没有任何采样（新会话刚建立/记录器刚启动）：整页重取最新 200 条，直到有数据；
  // - 已有采样：增量拉取比当前最新更新的数据拼到顶部；
  // - 翻到历史后暂停自动刷新，避免打扰浏览。
  useEffect(() => {
    if (selectedId === null || pagedBack) return
    const newest = newestTsRef.current
    let cancelled = false
    if (newest === null) {
      setSamplesLoading(true)
      Promise.all([telemetryDb.getSession(selectedId), telemetryDb.getSamples(selectedId, { limit: SAMPLES_LIMIT })])
        .then(([sess, items]) => {
          if (cancelled) return
          setSession(sess)
          setSamples(items)
          newestTsRef.current = items.length > 0 ? items[0].ts : null
          setHasMore(items.length >= SAMPLES_LIMIT)
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err))
        })
        .finally(() => {
          if (!cancelled) setSamplesLoading(false)
        })
    } else {
      telemetryDb
        .getSamples(selectedId, { afterTs: newest, limit: 500 })
        .then((fresh) => {
          if (cancelled) return
          const existing = new Set(samplesRef.current.map((s) => s.id))
          const newItems = fresh.filter((s) => s.id !== undefined && !existing.has(s.id))
          if (newItems.length > 0) {
            setSamples((prev) => [...newItems, ...prev].slice(0, MAX_LIVE_SAMPLES))
            newestTsRef.current = Math.max(newestTsRef.current ?? 0, newItems[0].ts)
          }
        })
        .catch(() => {
          // 轮询失败静默跳过，下个周期重试
        })
    }
    return () => {
      cancelled = true
    }
  }, [refreshTick, selectedId, pagedBack])

  const selectSession = useCallback((id: number) => {
    setSelectedId(id)
    setPagedBack(false)
    setFollowLatest(id === sessionsRef.current[0]?.id)
  }, [])

  useEffect(() => {
    followLatestRef.current = followLatest
  }, [followLatest])

  const loadOlder = useCallback(() => {
    if (selectedId === null || samples.length === 0) return
    const oldest = samples[samples.length - 1].ts
    setSamplesLoading(true)
    telemetryDb
      .getSamples(selectedId, { limit: SAMPLES_LIMIT, beforeTs: oldest })
      .then((older) => {
        setSamples((prev) => {
          const merged = [...prev, ...older]
          // 数组顺序为「最新在前」：翻页浏览历史时保留已加载的最旧窗口，
          // 超过视图上限从头部（最新）裁掉，保证「加载更早数据」能持续前进。
          return merged.length > MAX_VIEW_SAMPLES ? merged.slice(-MAX_VIEW_SAMPLES) : merged
        })
        setHasMore(older.length >= SAMPLES_LIMIT)
        setPagedBack(true)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSamplesLoading(false))
  }, [selectedId, samples])

  const refresh = useCallback(() => setRefreshTick((n) => n + 1), [])

  const exportSession = useCallback(async (id: number) => {
    setExporting(id)
    try {
      const sess = await telemetryDb.getSession(id)
      if (!sess) throw new Error('会话不存在')
      // 分页流式写入 Blob：每页只保留一页对象与已序列化字符串，
      // 避免大会话一次性载入内存导致 WebView 卡死
      const parts: BlobPart[] = []
      let cursor: { ts: number; id: number } | undefined
      let exported = 0
      for (;;) {
        const page = await telemetryDb.getSamplesAsc(id, { limit: EXPORT_PAGE_SIZE, after: cursor })
        if (page.length === 0) break
        if (exported === 0) parts.push(`${telemetryCsvHeader().join(',')}\n`)
        const last = page[page.length - 1]
        cursor = { ts: last.ts, id: last.id as number }
        exported += page.length
        parts.push(`${page.map((s) => telemetryCsvRow(s).join(',')).join('\n')}\n`)
        if (page.length < EXPORT_PAGE_SIZE) break
      }
      const blob = new Blob(parts, { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `telemetry-session-${id}.csv`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(null)
    }
  }, [])

  const connected = armStatus === 'connected'

  return {
    connected,
    recording: recorderStatus.recording,
    port: recorderStatus.port || conn?.port || '',
    sampleHz: recorderStatus.sampleHz,
    retentionMb: recorderStatus.maxBytes / 1048576,
    retentionMinMb: RETENTION_MIN_MB,
    retentionMaxMb: RETENTION_MAX_MB,
    setRetentionMb: telemetryRecorder.setRetentionMb,
    sessionSamples: recorderStatus.samplesRecorded,
    lastSampleAt: recorderStatus.lastSampleAt,
    robotSerial: recorderStatus.robotSerial,
    totalSamples,
    totalSessions,
    sessions,
    selectedId,
    session,
    samples,
    samplesLoading,
    loading,
    error,
    hasMore,
    exporting,
    selectSession,
    loadOlder,
    refresh,
    exportSession,
  }
}

export type TelemetryStateReturn = ReturnType<typeof useTelemetryState>

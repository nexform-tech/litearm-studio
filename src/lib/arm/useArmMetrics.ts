import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { jointColor } from '../colors'
import { DEFAULT_JOINT_COUNT, jointIndexes, useJointCount } from './axes'
import { useArmConnection } from './useArmConnection'
import { useArmState } from './useArmState'

export type SeriesSample = {
  t: number
  temp: number[]
  dq: number[]
  tau: number[]
  err: number[]
}

export type MetricType = 'temp' | 'dq' | 'tau' | 'err'

export type MetricTab = {
  key: string
  name: string
  active: boolean
  onClick: () => void
}

export type MetricChip = {
  key: string
  k: string
  t: string
  /** 该关节在图表曲线上的颜色（与芯片色块同源）。 */
  color: string
  bg: string
  box: string
  text: string
  valFg: string
  unitFg: string
  toggle: () => void
}

export const METRIC_DEFS = [
  { id: 'temp', name: '温度', unit: '°C', axis: 'T (°C)', amp: 0.35 },
  { id: 'dq', name: '速度', unit: 'rad/s', axis: 'dq (rad/s)', amp: 1.0 },
  { id: 'tau', name: '力矩', unit: 'Nm', axis: 'tau (Nm)', amp: 0.78 },
  { id: 'err', name: '跟踪误差', unit: 'rad', axis: 'e (rad)', amp: 0.52 },
] as const

const SERIES_INTERVAL_MS = 100
const SERIES_MAX_LEN = 100

// 仿真波形每条通道的基准值；通道数由 jointCount 决定，基准值不够长时按 0 起算。
const SIM_TEMP_SEED = [40, 41, 39, 42, 38, 37, 39]
const SIM_ERR_SEED = [0.002, 0.004, 0.001, 0.006, 0.002, 0.003, 0.001]

function generateSimSample(t: number, jointCount: number): SeriesSample {
  const phase = t / 1000
  return {
    t,
    temp: jointIndexes(jointCount).map((i) => (SIM_TEMP_SEED[i] ?? 40) + Math.sin(phase + i) * 1.5),
    dq: jointIndexes(jointCount).map((i) => Math.sin(phase * 1.5 + i) * 0.8),
    tau: jointIndexes(jointCount).map((i) => Math.cos(phase * 1.2 + i) * 1.2),
    err: jointIndexes(jointCount).map((i) => (SIM_ERR_SEED[i] ?? 0.002) + Math.sin(phase * 2 + i) * 0.0005),
  }
}

export type UseArmMetricsOptions = {
  /** 仿真模式传 false，实机模式传 true（默认 true） */
  real?: boolean
}

export function useArmMetrics(options: UseArmMetricsOptions = {}) {
  const { t } = useTranslation(['common'])
  const { real = true } = options
  const { status: connStatus } = useArmConnection()
  const armState = useArmState()
  const connected = connStatus === 'connected'
  // 画几个轴由 daemon 报告的 `n` 决定，不再是写死的 7（issue #37）。
  const jointCount = useJointCount(real)

  const [metric, setMetric] = useState<MetricType>('temp')
  const [shown, setShown] = useState<number[]>(() => jointIndexes(DEFAULT_JOINT_COUNT))
  const [paused, setPaused] = useState(false)

  const armStateRef = useRef(armState)
  armStateRef.current = armState

  const seriesRef = useRef<SeriesSample[]>([])
  const [series, setSeries] = useState<SeriesSample[]>([])
  const wasLiveRef = useRef(false)

  // 故意不依赖 armState：广播每帧都会换新引用，若把它放进依赖，定时器会被
  // 反复重建；interval 内部通过 armStateRef 读取最新状态，无需重跑 effect。
  useEffect(() => {
    // 实机未连接时清空历史数据，不推送虚假数据
    if (real && (!connected || !armStateRef.current)) {
      if (wasLiveRef.current || seriesRef.current.length > 0) {
        wasLiveRef.current = false
        seriesRef.current = []
        setSeries([])
      }
      return
    }

    const id = setInterval(() => {
      if (paused) return
      const arm = armStateRef.current
      if (real && !arm) return

      if (real && !wasLiveRef.current) {
        wasLiveRef.current = true
        seriesRef.current = []
        setSeries([])
      }

      let next: SeriesSample
      if (real && arm) {
        next = {
          t: Date.now(),
          temp: (arm.temps ?? []).slice(0, jointCount).map((x) => (typeof x?.mosTemp === 'number' && !isNaN(x.mosTemp) ? x.mosTemp : 0)),
          dq: (arm.dq ?? []).slice(0, jointCount).map((v) => (typeof v === 'number' && !isNaN(v) ? v : 0)),
          tau: (arm.tau ?? []).slice(0, jointCount).map((v) => (typeof v === 'number' && !isNaN(v) ? v : 0)),
          // 广播里没有跟踪误差字段：实机不伪造数据，图表留空并提示"暂无数据"。
          err: [],
        }
      } else {
        next = generateSimSample(Date.now(), jointCount)
      }

      const buf = [...seriesRef.current, next]
      if (buf.length > SERIES_MAX_LEN) buf.splice(0, buf.length - SERIES_MAX_LEN)
      seriesRef.current = buf
      setSeries(buf)
    }, SERIES_INTERVAL_MS)
    return () => clearInterval(id)
  }, [paused, real, connected, jointCount])

  const curDef = useMemo(() => METRIC_DEFS.find((m) => m.id === metric) ?? METRIC_DEFS[0], [metric])

  const metrics: MetricTab[] = useMemo(
    () =>
      METRIC_DEFS.map((m) => ({
        key: m.id,
        name: t('common:metrics.' + m.id, { defaultValue: m.name }),
        active: metric === m.id,
        onClick: () => setMetric(m.id as MetricType),
      })),
    [metric, t],
  )

  const liveVals: string[] | null = useMemo(() => {
    if (real) {
      if (!connected || !armState) return null
      if (metric === 'temp')
        return (armState.temps ?? [])
          .slice(0, jointCount)
          .map((tVal) => (typeof tVal?.mosTemp === 'number' && !isNaN(tVal.mosTemp) ? tVal.mosTemp : 0).toFixed(0))
      if (metric === 'dq')
        return (armState.dq ?? [])
          .slice(0, jointCount)
          .map((v) => (typeof v === 'number' && !isNaN(v) ? v : 0).toFixed(2))
      if (metric === 'tau')
        return (armState.tau ?? [])
          .slice(0, jointCount)
          .map((v) => (typeof v === 'number' && !isNaN(v) ? v : 0).toFixed(1))
      return null // 跟踪误差在实机广播中不存在，不做展示
    } else {
      const last = series[series.length - 1]
      if (!last) return null
      if (metric === 'temp') return (last.temp ?? []).map((v) => (typeof v === 'number' && !isNaN(v) ? v : 0).toFixed(0))
      if (metric === 'dq') return (last.dq ?? []).map((v) => (typeof v === 'number' && !isNaN(v) ? v : 0).toFixed(2))
      if (metric === 'tau') return (last.tau ?? []).map((v) => (typeof v === 'number' && !isNaN(v) ? v : 0).toFixed(1))
      return (last.err ?? []).map((v) => (typeof v === 'number' && !isNaN(v) ? v : 0).toFixed(3))
    }
  }, [real, connected, armState, metric, series, jointCount])

  const chips: MetricChip[] = useMemo(
    () =>
      jointIndexes(jointCount).map((i) => {
        const c = jointColor(i)
        const on = shown.includes(i)
        return {
          key: 'J' + (i + 1),
          k: 'J' + (i + 1),
          t: liveVals ? (liveVals[i] ?? '—') : '—',
          color: c,
          bd: on ? c : 'var(--line)',
          bg: on ? 'var(--muted)' : 'transparent',
          box: on ? c : 'var(--line-strong)',
          text: on ? 'var(--ink)' : 'var(--ink-ghost)',
          valFg: on ? 'var(--ink-muted)' : 'var(--line-strong)',
          unitFg: on ? 'var(--ink-faint)' : 'var(--ink-ghost)',
          toggle: () =>
            setShown((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i].sort())),
        }
      }),
    [shown, liveVals, jointCount],
  )

  const selectAll = useCallback(() => setShown(jointIndexes(jointCount)), [jointCount])
  const selectNone = useCallback(() => setShown([]), [])
  const togglePause = useCallback(() => setPaused((p) => !p), [])

  return {
    metrics,
    metricUnit: curDef.unit,
    metricAxis: curDef.axis,
    pauseLabel: paused ? t('common:metrics.resume') : t('common:metrics.pause'),
    togglePause,
    selectAll,
    selectNone,
    chips,
    series,
    shown,
    liveData: real && connected,
    errNoData: real && metric === 'err',
    simMode: !real,
  }
}

export type ArmMetricsReturn = ReturnType<typeof useArmMetrics>

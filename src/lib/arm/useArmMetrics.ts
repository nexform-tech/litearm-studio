import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { jointColor } from '../colors'
import { DEFAULT_JOINT_COUNT, jointIndexes, useJointCount } from './axes'
import { readStoredMetric, storeMetric } from './metricSelection'
import { useArmConnection } from './useArmConnection'
import { useArmState } from './useArmState'

export type SeriesSample = {
  t: number
  temp: number[]
  dq: number[]
  tau: number[]
}

export type MetricType = 'temp' | 'dq' | 'tau'

/**
 * 一张图对应一个指标：名称/单位/轴标签，外加**该指标下逐关节的当前读数**。
 *
 * ⚠ 读数按指标分开，不再只留"当前指标"那一份：面板切换指标时每张图都要显示自己的读数。
 */
export type MetricSeries = {
  id: MetricType
  name: string
  unit: string
  axis: string
  /** 逐关节当前读数（已格式化）；该指标在实机广播中不存在时为 null。 */
  live: string[] | null
}

/** 关节开关。数值不在这里——它跟着各自的指标走（见 `MetricSeries.live`）。
 *  皮肤也不在这里：面板把它画成复选框，颜色直接取自 `color`。 */
export type MetricChip = {
  key: string
  k: string
  /** 该关节在图表曲线上的颜色（复选框的强调色同源）。 */
  color: string
  on: boolean
  toggle: () => void
}

/** 图的堆叠顺序即面板里的切换顺序，第一项是默认指标（温度）。 */
export const METRIC_DEFS = [
  { id: 'temp', name: '温度', unit: '°C', axis: 'T (°C)', amp: 0.35 },
  { id: 'dq', name: '速度', unit: 'rad/s', axis: 'dq (rad/s)', amp: 1.0 },
  { id: 'tau', name: '力矩', unit: 'Nm', axis: 'tau (Nm)', amp: 0.78 },
] as const

const SERIES_INTERVAL_MS = 100
const SERIES_MAX_LEN = 100

// 仿真波形每条通道的基准值；通道数由 jointCount 决定，基准值不够长时按 0 起算。
const SIM_TEMP_SEED = [40, 41, 39, 42, 38, 37, 39]

function generateSimSample(t: number, jointCount: number): SeriesSample {
  const phase = t / 1000
  return {
    t,
    temp: jointIndexes(jointCount).map((i) => (SIM_TEMP_SEED[i] ?? 40) + Math.sin(phase + i) * 1.5),
    dq: jointIndexes(jointCount).map((i) => Math.sin(phase * 1.5 + i) * 0.8),
    tau: jointIndexes(jointCount).map((i) => Math.cos(phase * 1.2 + i) * 1.2),
  }
}

const num = (v: unknown): number => (typeof v === 'number' && !isNaN(v) ? v : 0)

/** 逐指标的小数位：温度是整数、速度两位、力矩一位。 */
const DECIMALS: Record<MetricType, number> = { temp: 0, dq: 2, tau: 1 }

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

  const [shown, setShown] = useState<number[]>(() => jointIndexes(DEFAULT_JOINT_COUNT))
  const [paused, setPaused] = useState(false)
  // 右列高度只够一张图，所以指标由用户切换；选择记在 localStorage 里跨刷新保留。
  const [activeMetric, setActiveMetric] = useState<MetricType>(() => readStoredMetric())

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
          temp: (arm.temps ?? []).slice(0, jointCount).map((x) => num(x?.mosTemp)),
          dq: (arm.dq ?? []).slice(0, jointCount).map(num),
          tau: (arm.tau ?? []).slice(0, jointCount).map(num),
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

  /** 逐指标的逐关节读数。实机取自当前广播帧，仿真取自最新一个采样点。 */
  const liveByMetric = useMemo((): Record<MetricType, string[] | null> => {
    const none: Record<MetricType, string[] | null> = { temp: null, dq: null, tau: null }
    if (real) {
      if (!connected || !armState) return none
      const fmt = (m: MetricType, values: unknown[]) =>
        values.slice(0, jointCount).map((v) => num(v).toFixed(DECIMALS[m]))
      return {
        // `temps` 是 {mosTemp, coilTemp} 对象，不能直接 num()。
        temp: (armState.temps ?? []).slice(0, jointCount).map((x) => num(x?.mosTemp).toFixed(DECIMALS.temp)),
        dq: fmt('dq', armState.dq ?? []),
        tau: fmt('tau', armState.tau ?? []),
      }
    }
    const last = series[series.length - 1]
    if (!last) return none
    return {
      temp: (last.temp ?? []).map((v) => num(v).toFixed(DECIMALS.temp)),
      dq: (last.dq ?? []).map((v) => num(v).toFixed(DECIMALS.dq)),
      tau: (last.tau ?? []).map((v) => num(v).toFixed(DECIMALS.tau)),
    }
  }, [real, connected, armState, series, jointCount])

  const metricSeries: MetricSeries[] = useMemo(
    () =>
      METRIC_DEFS.map((m) => ({
        id: m.id as MetricType,
        name: t('common:metrics.' + m.id, { defaultValue: m.name }),
        unit: m.unit,
        axis: m.axis,
        live: liveByMetric[m.id as MetricType],
      })),
    [t, liveByMetric],
  )

  const chips: MetricChip[] = useMemo(
    () =>
      jointIndexes(jointCount).map((i) => ({
        key: 'J' + (i + 1),
        k: 'J' + (i + 1),
        color: jointColor(i),
        on: shown.includes(i),
        toggle: () =>
          setShown((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i].sort())),
      })),
    [shown, jointCount],
  )

  const selectAll = useCallback(() => setShown(jointIndexes(jointCount)), [jointCount])
  const togglePause = useCallback(() => setPaused((p) => !p), [])
  const selectMetric = useCallback((id: MetricType) => {
    setActiveMetric(id)
    storeMetric(id)
  }, [])

  return {
    metricSeries,
    activeMetric,
    selectMetric,
    pauseLabel: paused ? t('common:metrics.resume') : t('common:metrics.pause'),
    togglePause,
    selectAll,
    chips,
    series,
    shown,
    liveData: real && connected,
    simMode: !real,
  }
}

export type ArmMetricsReturn = ReturnType<typeof useArmMetrics>

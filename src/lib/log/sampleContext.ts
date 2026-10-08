/**
 * 事件 → 它那一刻的采样 —— 把事件 tab 与采样数据在**需要它的地方**接起来。
 *
 * 谁读这个文件: 要改"展开一条事件时看到什么"的人。
 *
 * 为什么是这样, 而不是一张采样列表: 事件是稀疏的 (一次调试可能只有几条), 采样是
 * 1Hz 的——放进同一个列表里, 事件会被采样淹掉, 而"刚才发生了什么"正是操作员来找的
 * 东西。反过来, 完全分开 (两个互不相干的 tab) 又会切断因果: 看到 "J3 温度过高" 却
 * 要手动切页、记住时间、再去数里翻。
 *
 * 所以形状是: 事件列表是主视图, 采样在**展开某一条事件时**按它自己的时间戳取一小段
 * 上下文。数值与事件同源 (都是 `kind:"sample"` 的记录), 因此不需要第二条数据管道。
 */
import type { LogEntry } from './schema'

/** 折线序列: 一条名字 + 与 `times` 对齐的值。 */
export type ContextSeries = {
  label: string
  unit: string
  values: number[]
}

export type SampleContext = {
  /** 窗口内的采样记录, 时间正序。 */
  samples: LogEntry[]
  /** 每条采样对应的纳秒时间戳 (与 `series[].values` 对齐)。 */
  times: number[]
  series: ContextSeries[]
  /** 这条事件前后各取多少纳秒 —— 界面要如实说"这是一个多大的窗口"。 */
  windowNs: number
  /** 采样里有没有可用数值。没有就只显示"这一刻没有采样"。 */
  hasValues: boolean
}

/** 默认窗口: 事件前后各 10s。采样是 1Hz, 于是最多约 21 个点 —— 画得下, 也读得出趋势。 */
export const DEFAULT_WINDOW_NS = 10 * 1_000_000_000

/** 折线最多画几条。7 轴 × 2 类量会挤成一团, 取最大值那一条轴即可。 */
export const CONTEXT_SERIES_LIMIT = 3

function asNumberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.map((v) => (typeof v === 'number' ? v : 0)) : []
}

function maxOf(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values)
}

/** 一条采样记录里, 温度的最大值 (mos/coil 取大)。 */
function maxTemp(entry: LogEntry): number {
  const temps = entry.fields.temps
  if (!Array.isArray(temps)) return 0
  let best = 0
  for (const t of temps as { mosTemp?: number; coilTemp?: number }[]) {
    best = Math.max(best, t?.mosTemp ?? 0, t?.coilTemp ?? 0)
  }
  return best
}

/**
 * 从 `samples` (时间正序) 里取 `event` 前后 `windowNs` 的那一段。
 *
 * 用二分而不是 `filter`: 内存里最多 5000 条记录, 而展开一条事件只关心十几条。等价的
 * 语义, 但不必每次展开都扫一遍全表 (展开是高频交互, 表格本来就重)。
 *
 * ⚠ 采样可能**完全没有** (daemon 以 INFO 级别运行时不落采样): 那就返回空窗口, 由界面
 * 如实说"这一刻没有采样", 而不是画一张空白图 —— 空白图与"采样是 0"分不清。
 */
export function sampleContextFor(
  event: LogEntry,
  samples: LogEntry[],
  windowNs: number = DEFAULT_WINDOW_NS,
): SampleContext {
  const empty: SampleContext = {
    samples: [], times: [], series: [], windowNs, hasValues: false,
  }
  if (samples.length === 0) return empty

  const from = event.tsNs - windowNs
  const to = event.tsNs + windowNs
  // 二分找左边界: 第一条 tsNs >= from。
  let lo = 0
  let hi = samples.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (samples[mid].tsNs < from) lo = mid + 1
    else hi = mid
  }
  const window: LogEntry[] = []
  for (let i = lo; i < samples.length && samples[i].tsNs <= to; i++) window.push(samples[i])
  if (window.length === 0) return empty

  // 温度最高那一轴与力矩最大那一轴 —— "哪一轴不对"是展开一条事件时最想知道的事。
  const last = window[window.length - 1]
  const q = asNumberArray(last.fields.q)
  const series: ContextSeries[] = []

  const jointCount = Math.max(q.length, asNumberArray(last.fields.tau).length, 1)
  const tempPerJoint: number[][] = Array.from({ length: jointCount }, () => [])
  const tauPerJoint: number[][] = Array.from({ length: jointCount }, () => [])
  for (const entry of window) {
    const temps = Array.isArray(entry.fields.temps)
      ? (entry.fields.temps as { mosTemp?: number; coilTemp?: number }[])
      : []
    const tau = asNumberArray(entry.fields.tau)
    for (let j = 0; j < jointCount; j++) {
      const t = temps[j]
      tempPerJoint[j].push(t ? Math.max(t.mosTemp ?? 0, t.coilTemp ?? 0) : 0)
      tauPerJoint[j].push(Math.abs(tau[j] ?? 0))
    }
  }
  const hottest = tempPerJoint
    .map((values, index) => ({ index, peak: maxOf(values) }))
    .sort((a, b) => b.peak - a.peak)[0]
  const strongest = tauPerJoint
    .map((values, index) => ({ index, peak: maxOf(values) }))
    .sort((a, b) => b.peak - a.peak)[0]

  if (hottest && hottest.peak > 0) {
    series.push({ label: `J${hottest.index + 1}`, unit: '°C', values: tempPerJoint[hottest.index] })
  }
  if (strongest && strongest.peak > 0) {
    series.push({ label: `J${strongest.index + 1}`, unit: 'Nm', values: tauPerJoint[strongest.index] })
  }
  // 整体最高温度始终给出来: 它是"那一刻机器冷不冷"的一句话答案。
  series.push({ label: 'max', unit: '°C', values: window.map(maxTemp) })

  return {
    samples: window,
    times: window.map((entry) => entry.tsNs),
    series: series.slice(0, CONTEXT_SERIES_LIMIT),
    windowNs,
    hasValues: window.some((entry) => Object.keys(entry.fields).length > 0),
  }
}

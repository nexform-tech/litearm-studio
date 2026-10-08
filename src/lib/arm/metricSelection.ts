import type { MetricType } from './useArmMetrics'

/**
 * 实时曲线当前展示的指标（温度/速度/力矩）。
 *
 * 右列高度只够一张可读的图，所以指标改成**用户切换**而不是按高度堆叠：面板一次只画
 * 选中的那一个，选择本身记住上次的。这里只负责"记住"，与 React 无关，单独成文件是
 * 为了能直接测（含 localStorage 不可用的场景）。
 */
export const METRIC_STORAGE_KEY = 'litearm-studio:live-curve-metric'

/** 没有存过或存的值不合法时退回温度 —— 它是最常看、也最需要长时间观察的量。 */
export const DEFAULT_METRIC: MetricType = 'temp'

/** 面板能展示的全部指标；也用来判断存下来的字符串是不是一个真指标。 */
export const METRIC_IDS: readonly MetricType[] = ['temp', 'dq', 'tau']

export function isMetricType(value: unknown): value is MetricType {
  return typeof value === 'string' && (METRIC_IDS as readonly string[]).includes(value)
}

/** 读回上次展示的指标；没存过、值不合法或读不到 localStorage 时都是默认值。 */
export function readStoredMetric(): MetricType {
  try {
    const raw = window.localStorage.getItem(METRIC_STORAGE_KEY)
    return isMetricType(raw) ? raw : DEFAULT_METRIC
  } catch {
    return DEFAULT_METRIC
  }
}

export function storeMetric(metric: MetricType): void {
  if (!isMetricType(metric)) return
  try {
    window.localStorage.setItem(METRIC_STORAGE_KEY, metric)
  } catch {
    // 忽略写入失败（隐私模式/配额不足），仅本次生效
  }
}

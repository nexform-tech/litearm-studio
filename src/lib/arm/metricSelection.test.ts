import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_METRIC,
  METRIC_STORAGE_KEY,
  isMetricType,
  readStoredMetric,
  storeMetric,
} from './metricSelection'

// 右列只能画一张图，指标改由用户切换。选择要跨刷新记住，且**坏值必须退回默认**：
// 一个写坏的 localStorage 不该让曲线面板空白。
describe('live curve metric selection', () => {
  afterEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  it('defaults to temperature when nothing was stored', () => {
    expect(readStoredMetric()).toBe(DEFAULT_METRIC)
    expect(DEFAULT_METRIC).toBe('temp')
  })

  it('round-trips every metric the panel can show', () => {
    for (const id of ['temp', 'dq', 'tau', 'err'] as const) {
      storeMetric(id)
      expect(readStoredMetric()).toBe(id)
      expect(window.localStorage.getItem(METRIC_STORAGE_KEY)).toBe(id)
    }
  })

  it('falls back to the default for a value that is not a metric', () => {
    window.localStorage.setItem(METRIC_STORAGE_KEY, 'position')
    expect(readStoredMetric()).toBe(DEFAULT_METRIC)

    window.localStorage.setItem(METRIC_STORAGE_KEY, '')
    expect(readStoredMetric()).toBe(DEFAULT_METRIC)
  })

  it('rejects anything that is not a metric id before writing', () => {
    storeMetric('temp')
    storeMetric('nope' as never)
    expect(window.localStorage.getItem(METRIC_STORAGE_KEY)).toBe('temp')
    expect(isMetricType('nope')).toBe(false)
    expect(isMetricType('tau')).toBe(true)
  })

  it('keeps working when localStorage throws (private mode / quota)', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(readStoredMetric()).toBe(DEFAULT_METRIC)

    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(() => storeMetric('dq')).not.toThrow()
  })

  it('ignores non-string storage values', () => {
    // localStorage 只存字符串，但 getItem 被 polyfill 或测试替身时可能给出别的类型。
    vi.spyOn(window.localStorage, 'getItem').mockReturnValue(null as unknown as string)
    expect(readStoredMetric()).toBe(DEFAULT_METRIC)
  })
})

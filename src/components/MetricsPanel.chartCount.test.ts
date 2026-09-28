import { describe, expect, it } from 'vitest'
import { MIN_CHART_REM, chartCountFor } from './metricChartCount'

// 右列要按可用高度决定画几张图：够就 4 张，不够依次 3、2、1。判据本身是纯函数，
// 直接在数字上钉住——DOM 里量高度在 jsdom 里做不到。
describe('chartCountFor', () => {
  const root = 16 // 16px 根字号 ⇒ 一张图至少 MIN_CHART_REM * 16 px

  it('draws all four metrics when the column is tall enough', () => {
    expect(chartCountFor(4 * MIN_CHART_REM * root + 40, root, 4)).toBe(4)
  })

  it('steps down to three, two and one as the column shrinks', () => {
    expect(chartCountFor(3.5 * MIN_CHART_REM * root, root, 4)).toBe(3)
    expect(chartCountFor(2.5 * MIN_CHART_REM * root, root, 4)).toBe(2)
    expect(chartCountFor(1.5 * MIN_CHART_REM * root, root, 4)).toBe(1)
  })

  it('never returns zero, even when nothing fits or the height is unmeasurable', () => {
    expect(chartCountFor(0, root, 4)).toBe(1)
    expect(chartCountFor(-100, root, 4)).toBe(1)
    expect(chartCountFor(Number.NaN, root, 4)).toBe(1)
  })

  it('never returns more than the number of metrics on offer', () => {
    expect(chartCountFor(9999, root, 4)).toBe(4)
    expect(chartCountFor(9999, root, 1)).toBe(1)
  })

  it('scales the minimum with the root font, so a zoomed UI does not over-pack', () => {
    // 同样的像素高度，根字号大一倍时能塞下的图少一半。
    const px = 3.5 * MIN_CHART_REM * 16
    expect(chartCountFor(px, 16, 4)).toBe(3)
    expect(chartCountFor(px, 32, 4)).toBe(1)
  })

  it('falls back to a 16px root when the computed font size is unusable', () => {
    expect(chartCountFor(MIN_CHART_REM * 16, Number.NaN, 4)).toBe(1)
    expect(chartCountFor(4 * MIN_CHART_REM * 16, 0, 4)).toBe(4)
  })
})

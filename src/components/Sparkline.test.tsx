import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { Sparkline } from './Sparkline'
import i18n from '@/i18n'

/**
 * 这一份钉的是**折线不会静默地画错**。
 *
 * SVG 的失效方式很隐蔽: 坐标算成 `NaN` 就不画任何东西, 而"什么都没画"与"数据是 0"
 * 在屏幕上一模一样。所以这里断言的是 `points` 的具体内容 —— 数值、点数、以及恒定序列
 * 必须落在中间那条线上。
 */
const NS = 1_000_000_000

function series(label: string, unit: string, values: number[]) {
  return { label, unit, values }
}

function times(count: number): number[] {
  return Array.from({ length: count }, (_, i) => 1_778_152_382_000_000_000 + i * NS)
}

function points(): string {
  const el = document.querySelector('polyline')
  expect(el).not.toBeNull()
  return el!.getAttribute('points') ?? ''
}

describe('Sparkline', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('plots one point per value', () => {
    render(<Sparkline series={series('J2', '°C', [10, 20, 30, 40])} times={times(4)} locale="en" />)
    expect(points().split(' ')).toHaveLength(4)
    // 每一个坐标都必须是有限数 —— `NaN` 会让整条折线消失。
    for (const pair of points().split(' ')) {
      const [x, y] = pair.split(',').map(Number)
      expect(Number.isFinite(x)).toBe(true)
      expect(Number.isFinite(y)).toBe(true)
    }
  })

  it('draws a flat series as a centred line instead of nothing', () => {
    // ⚠ span === 0 是最容易踩的一处: 除以零得到 NaN, SVG 会静默什么都不画,
    // 于是"一直是 0 Nm"看起来跟"没有数据"一样。
    render(<Sparkline series={series('J3', 'Nm', [0, 0, 0, 0])} times={times(4)} locale="en" />)
    const ys = points().split(' ').map((pair) => Number(pair.split(',')[1]))
    expect(ys.every((y) => Number.isFinite(y))).toBe(true)
    expect(new Set(ys).size).toBe(1)
    expect(ys[0]).toBe(24)          // 视图中线 (VIEW_H 48 / 2)
  })

  it('handles a single point without dividing by zero', () => {
    render(<Sparkline series={series('J1', '°C', [42])} times={times(1)} locale="en" />)
    const [[x, y]] = points().split(' ').map((pair) => pair.split(',').map(Number))
    expect(Number.isFinite(x)).toBe(true)
    expect(Number.isFinite(y)).toBe(true)
  })

  it('shows the range and the units as text, not only as a line', () => {
    // 纯文本环境 (测试、导出的截图) 里也必须读得出数。
    render(<Sparkline series={series('J2', '°C', [70, 74, 78])} times={times(3)} locale="en" />)
    expect(screen.getByText('J2')).toBeTruthy()
    expect(screen.getByText('°C')).toBeTruthy()
    expect(screen.getByText('70–78')).toBeTruthy()   // 整数不带小数
  })

  it('keeps one decimal for values that are not whole numbers', () => {
    render(<Sparkline series={series('J3', 'Nm', [2.5, 2.9, 3.0])} times={times(3)} locale="en" />)
    expect(screen.getByText('2.5–3.0')).toBeTruthy()
  })

  it('labels both ends of the time axis', () => {
    render(<Sparkline series={series('J2', '°C', [1, 2])} times={[0, 0]} locale="en" />)
    // 时间戳为 0 时标注退化成空串, 而不是 "Invalid Date" —— 损坏的记录也要能画。
    expect(screen.queryByText(/Invalid/)).toBeNull()
  })

  it('says there are no samples rather than rendering an empty plot', () => {
    render(<Sparkline series={series('J2', '°C', [])} times={[]} locale="en" />)
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText(/No state samples/)).toBeTruthy()
  })
})

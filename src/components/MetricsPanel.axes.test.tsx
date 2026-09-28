import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { MetricChip, MetricSeries, MetricType } from '@/lib/arm'

// `MetricsPanel` 一渲染就要 canvas（chart.js），jsdom 里画不出来。这里替掉 chart.js 与
// react-chartjs-2，只把**交给图表的 datasets** 抓出来断言：曲线条数必须等于芯片条数
// （而芯片条数 = daemon 报告的轴数）。少了这一层，`{1J}` 台架仍会画 7 条曲线（#37）。
const captured = vi.hoisted(() => ({ data: null as { datasets: { label?: string; borderColor?: unknown; hidden?: boolean }[] } | null }))

vi.mock('chart.js', () => ({
  Chart: { register: vi.fn(), defaults: { font: {} } },
  CategoryScale: {},
  LinearScale: {},
  PointElement: {},
  LineElement: {},
  Tooltip: {},
}))

vi.mock('react-chartjs-2', () => ({
  Line: (props: { data: never }) => {
    captured.data = props.data
    return null
  },
}))

const { MetricsPanel } = await import('./MetricsPanel')

/** 芯片现在是纯开关：只有颜色与开关状态，读数跟着各自的指标走。 */
function chip(i: number, on = true): MetricChip {
  return {
    key: `J${i + 1}`,
    k: `J${i + 1}`,
    color: `#00000${i}`,
    on,
    bg: 'transparent',
    box: 'var(--line-strong)',
    text: 'var(--ink)',
    toggle: vi.fn(),
  }
}

const DEFS: Record<MetricType, { name: string; unit: string; axis: string }> = {
  temp: { name: '温度', unit: '°C', axis: 'T (°C)' },
  dq: { name: '速度', unit: 'rad/s', axis: 'dq (rad/s)' },
  tau: { name: '力矩', unit: 'Nm', axis: 'tau (Nm)' },
  err: { name: '跟踪误差', unit: 'rad', axis: 'e (rad)' },
}

/** 四个指标，顺序即优先级（与 `METRIC_DEFS` 一致）。 */
function allMetrics(axisCount: number): MetricSeries[] {
  return (['temp', 'dq', 'tau', 'err'] as MetricType[]).map((id) => ({
    id,
    ...DEFS[id],
    live: Array.from({ length: axisCount }, () => '1'),
    noData: id === 'err',
  }))
}

function renderPanel(axisCount: number, shown = [0]) {
  const chips = Array.from({ length: axisCount }, (_, i) => chip(i, shown.includes(i)))
  render(
    <MetricsPanel
      metrics={allMetrics(axisCount)}
      pauseLabel="暂停"
      togglePause={vi.fn()}
      series={[{ t: 1, temp: Array.from({ length: axisCount }, (_, i) => i), dq: [], tau: [], err: [] }]}
      shown={shown}
      liveData
      simMode={false}
      chips={chips}
      selectAll={vi.fn()}
      selectNone={vi.fn()}
    />,
  )
  return chips
}

afterEach(() => {
  cleanup()
  captured.data = null
})

describe('MetricsPanel chart follows the chip count', () => {
  it('draws a single curve for a single-axis arm', () => {
    const chips = renderPanel(1)

    expect(screen.getAllByText(/^J\d+$/)).toHaveLength(1)
    expect(captured.data?.datasets).toHaveLength(1)
    expect(captured.data?.datasets[0].label).toBe('J1')
    expect(captured.data?.datasets[0].borderColor).toBe(chips[0].color)
  })

  it('draws one curve per axis on a seven-axis arm', () => {
    const chips = renderPanel(7, [0, 1, 2, 3, 4, 5, 6])

    expect(screen.getAllByText(/^J\d+$/)).toHaveLength(7)
    expect(captured.data?.datasets.map((d) => d.label)).toEqual([
      'J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'J7',
    ])
    expect(captured.data?.datasets.map((d) => d.hidden)).toEqual(Array(7).fill(false))
    expect(captured.data?.datasets[6].borderColor).toBe(chips[6].color)
  })

  it('hides the curves the operator deselected', () => {
    renderPanel(3, [1])

    expect(captured.data?.datasets.map((d) => d.hidden)).toEqual([true, false, true])
  })

  it('draws the highest-priority metric when only one chart fits', () => {
    // jsdom 量不到高度 ⇒ 只画一张；必须是优先级最高的温度，而不是随便一张。
    renderPanel(3)

    expect(screen.getByText('温度')).toBeTruthy()
    expect(screen.getByText('°C')).toBeTruthy()
    expect(screen.queryByText('速度')).toBeNull()
    expect(screen.queryByText('力矩')).toBeNull()
    expect(screen.queryByText('跟踪误差')).toBeNull()
  })

  it('shows each joint current reading for the metric on screen', () => {
    renderPanel(3)

    // 温度图给出 J1/J2/J3 三个读数（值都是 '1'），而不是只给一个汇总数字。
    expect(screen.getByText('J1 1')).toBeTruthy()
    expect(screen.getByText('J2 1')).toBeTruthy()
    expect(screen.getByText('J3 1')).toBeTruthy()
  })
})

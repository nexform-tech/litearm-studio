import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { MetricChip } from '@/lib/arm'

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

function chip(i: number): MetricChip {
  return {
    key: `J${i + 1}`,
    k: `J${i + 1}`,
    t: '1',
    color: `#00000${i}`,
    bg: 'transparent',
    box: 'var(--line-strong)',
    text: 'var(--ink)',
    valFg: 'var(--ink-muted)',
    unitFg: 'var(--ink-faint)',
    toggle: vi.fn(),
  }
}

function renderPanel(count: number, shown = [0]) {
  const chips = Array.from({ length: count }, (_, i) => chip(i))
  render(
    <MetricsPanel
      metrics={[{ key: 'temp', name: '温度', active: true, onClick: vi.fn() }]}
      metricUnit="°C"
      metricAxis="T (°C)"
      pauseLabel="暂停"
      togglePause={vi.fn()}
      series={[{ t: 1, temp: Array.from({ length: count }, (_, i) => i), dq: [], tau: [], err: [] }]}
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
})

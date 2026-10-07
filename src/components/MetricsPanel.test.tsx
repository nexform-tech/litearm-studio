import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import type { MetricChip, MetricSeries, MetricType } from '@/lib/arm'

// `MetricsPanel` 一渲染就要 canvas（chart.js），jsdom 里画不出来。这里替掉 chart.js 与
// react-chartjs-2，只把**交给图表的 datasets** 抓出来断言：曲线条数必须等于芯片条数
// （而芯片条数 = daemon 报告的轴数），并且必须跟着选中的指标换数据。
const captured = vi.hoisted(() => ({
  data: null as {
    datasets: { label?: string; borderColor?: unknown; hidden?: boolean; data?: unknown[] }[]
  } | null,
  renders: 0,
}))

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
    captured.renders += 1
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

/** 四个指标，顺序即面板里的标签顺序（与 `METRIC_DEFS` 一致）。 */
function allMetrics(axisCount: number): MetricSeries[] {
  return (['temp', 'dq', 'tau', 'err'] as MetricType[]).map((id) => ({
    id,
    ...DEFS[id],
    live: Array.from({ length: axisCount }, () => '1'),
    noData: id === 'err',
  }))
}

/** 四个指标各给一组互不相同的值，用来证明切换标签后画的是另一个指标的曲线。 */
function sample(axisCount: number) {
  return {
    t: 1,
    temp: Array.from({ length: axisCount }, () => 100),
    dq: Array.from({ length: axisCount }, () => 200),
    tau: Array.from({ length: axisCount }, () => 300),
    err: [],
  }
}

function renderPanel(
  axisCount: number,
  {
    activeMetric = 'temp' as MetricType,
    shown = [0],
    liveData = true,
    simMode = false,
    compact = false,
  } = {},
) {
  const chips = Array.from({ length: axisCount }, (_, i) => chip(i, shown.includes(i)))
  const selectMetric = vi.fn()
  render(
    <MetricsPanel
      metrics={allMetrics(axisCount)}
      activeMetric={activeMetric}
      selectMetric={selectMetric}
      pauseLabel="暂停"
      togglePause={vi.fn()}
      series={[sample(axisCount)]}
      shown={shown}
      liveData={liveData}
      simMode={simMode}
      chips={chips}
      selectAll={vi.fn()}
      selectNone={vi.fn()}
      compact={compact}
    />,
  )
  return { chips, selectMetric }
}

afterEach(() => {
  cleanup()
  captured.data = null
  captured.renders = 0
})

describe('MetricsPanel chart follows the chip count', () => {
  it('draws a single curve for a single-axis arm', () => {
    const { chips } = renderPanel(1)

    expect(screen.getAllByText(/^J\d+$/)).toHaveLength(1)
    expect(captured.data?.datasets).toHaveLength(1)
    expect(captured.data?.datasets[0].label).toBe('J1')
    expect(captured.data?.datasets[0].borderColor).toBe(chips[0].color)
  })

  it('draws one curve per axis on a seven-axis arm', () => {
    const { chips } = renderPanel(7, { shown: [0, 1, 2, 3, 4, 5, 6] })

    expect(screen.getAllByText(/^J\d+$/)).toHaveLength(7)
    expect(captured.data?.datasets.map((d) => d.label)).toEqual([
      'J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'J7',
    ])
    expect(captured.data?.datasets.map((d) => d.hidden)).toEqual(Array(7).fill(false))
    expect(captured.data?.datasets[6].borderColor).toBe(chips[6].color)
  })

  it('hides the curves the operator deselected', () => {
    renderPanel(3, { shown: [1] })

    expect(captured.data?.datasets.map((d) => d.hidden)).toEqual([true, false, true])
  })
})

describe('MetricsPanel metric switcher', () => {
  it('offers every metric as a tab and marks the selected one', () => {
    renderPanel(3)

    const tabs = screen.getAllByRole('radio')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['温度', '速度', '力矩', '跟踪误差'])
    expect(screen.getByRole('radio', { name: '温度' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: '速度' }).getAttribute('aria-checked')).toBe('false')
  })

  it('renders exactly one chart, no matter how little height there is', () => {
    // 旧实现按高度决定画几张图，右列只放得下温度；现在永远只有一张，靠标签切换。
    renderPanel(4)

    expect(screen.getAllByTestId('metric-chart')).toHaveLength(1)
    expect(captured.renders).toBe(1)
  })

  it('asks for the clicked metric instead of dropping the ones that do not fit', () => {
    const { selectMetric } = renderPanel(3)

    fireEvent.click(screen.getByRole('radio', { name: '力矩' }))

    expect(selectMetric).toHaveBeenCalledTimes(1)
    expect(selectMetric).toHaveBeenCalledWith('tau')
  })

  it('plots the selected metric, not always the first one', () => {
    renderPanel(3, { activeMetric: 'dq' })

    expect(screen.getByRole('radio', { name: '速度' }).getAttribute('aria-checked')).toBe('true')
    expect(captured.data?.datasets.map((d) => d.data)).toEqual([[200], [200], [200]])
    expect(screen.getByText('rad/s')).toBeTruthy()
    expect(screen.getByText('dq (rad/s)')).toBeTruthy()
  })

  it('shows each joint current reading for the metric on screen', () => {
    renderPanel(3)

    // 温度图给出 J1/J2/J3 三个读数（值都是 '1'），而不是只给一个汇总数字。
    expect(screen.getByText('J1 1')).toBeTruthy()
    expect(screen.getByText('J2 1')).toBeTruthy()
    expect(screen.getByText('J3 1')).toBeTruthy()
  })

  it('explains a metric the real broadcast does not carry', () => {
    renderPanel(3, { activeMetric: 'err' })

    expect(screen.getByText(i18n.t('common:metrics.errUnavailable'))).toBeTruthy()
  })

  it('keeps the chart frame with a no-data notice while disconnected', () => {
    renderPanel(3, { liveData: false })

    expect(screen.getByText(i18n.t('common:metrics.noLiveData'))).toBeTruthy()
    expect(screen.getAllByTestId('metric-chart')).toHaveLength(1)
  })
})

describe('MetricsPanel compact layout', () => {
  it('drops the duplicated metric name while keeping every reading', () => {
    renderPanel(3, { compact: true })

    // 压扁形态仍然只有一张图，每个关节的当前读数也还在。
    expect(screen.getAllByTestId('metric-chart')).toHaveLength(1)
    expect(screen.getByText('J1 1')).toBeTruthy()
    expect(screen.getByText('J3 1')).toBeTruthy()
    // 指标名与单位已经写在页签上，不再在图里重复一遍。
    expect(screen.queryByText('T (°C)')).toBeNull()
    expect(screen.queryByText('°C')).toBeNull()
  })
})

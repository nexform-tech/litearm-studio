import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import type { MetricChip, MetricSeries, MetricType } from '@/lib/arm'

// `MetricsPanel` 一渲染就要 canvas（chart.js），jsdom 里画不出来。这里替掉 chart.js 与
// react-chartjs-2，只把**交给图表的 datasets** 抓出来断言：曲线条数必须等于芯片条数
// （而芯片条数 = daemon 报告的轴数），并且必须跟着选中的指标换数据。
// `options` 也要抓：悬停提示走的是 `plugins.tooltip.external`，用例直接把它调起来。
const captured = vi.hoisted(() => ({
  data: null as {
    datasets: { label?: string; borderColor?: unknown; hidden?: boolean; data?: unknown[] }[]
  } | null,
  options: null as { plugins?: { tooltip?: { external?: (ctx: unknown) => void } } } | null,
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
  Line: (props: { data: never; options: never }) => {
    captured.data = props.data
    captured.options = props.options
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
    toggle: vi.fn(),
  }
}

const DEFS: Record<MetricType, { name: string; unit: string; axis: string }> = {
  temp: { name: '温度', unit: '°C', axis: 'T (°C)' },
  dq: { name: '速度', unit: 'rad/s', axis: 'dq (rad/s)' },
  tau: { name: '力矩', unit: 'Nm', axis: 'tau (Nm)' },
}

/** 三个指标，顺序即面板里的标签顺序（与 `METRIC_DEFS` 一致）。 */
function allMetrics(axisCount: number): MetricSeries[] {
  return (['temp', 'dq', 'tau'] as MetricType[]).map((id) => ({
    id,
    ...DEFS[id],
    live: Array.from({ length: axisCount }, () => '1'),
  }))
}

/** 三个指标各给一组互不相同的值，用来证明切换标签后画的是另一个指标的曲线。 */
function sample(axisCount: number) {
  return {
    t: 1,
    temp: Array.from({ length: axisCount }, () => 100),
    dq: Array.from({ length: axisCount }, () => 200),
    tau: Array.from({ length: axisCount }, () => 300),
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
  const selectAll = vi.fn()
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
      selectAll={selectAll}
      compact={compact}
    />,
  )
  return { chips, selectMetric, selectAll }
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
    // 跟踪误差已从面板删除，只剩三个指标。
    expect(tabs.map((tab) => tab.textContent)).toEqual(['温度', '速度', '力矩'])
    expect(screen.getByRole('radio', { name: '温度' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: '速度' }).getAttribute('aria-checked')).toBe('false')
  })

  it('renders exactly one chart, no matter how little height there is', () => {
    // 旧实现按高度决定画几张图，右列只放得下温度；现在永远只有一张，靠标签切换。
    renderPanel(4)

    expect(screen.getAllByTestId('metric-chart')).toHaveLength(1)
    expect(captured.renders).toBe(1)
  })

  it('keeps the metric tabs on the title row and select all on the joint row', () => {
    renderPanel(3)

    const header = screen.getByText(i18n.t('common:metrics.title')).parentElement!
    const list = screen.getByTestId('metric-joint-list')
    const selectAll = screen.getByRole('button', { name: i18n.t('common:metrics.selectAll') })

    // 页签不再独占一行，它和标题、暂停同在标题行。
    expect(header.contains(screen.getByRole('radio', { name: '温度' }))).toBe(true)
    expect(header.contains(list)).toBe(false)
    // 「全选」管的是关节，所以跟着关节那一行走，且靠右收尾，不在标题行。
    expect(list.contains(selectAll)).toBe(true)
    expect(header.contains(selectAll)).toBe(false)
    expect(list.lastElementChild).toBe(selectAll)
    // 「清空」已删除：整个面板只剩标题行的暂停和关节行的全选两颗按钮。
    expect(within(header).getAllByRole('button').map((b) => b.textContent)).toEqual(['暂停'])
    expect(within(list).getAllByRole('button').map((b) => b.textContent)).toEqual([
      i18n.t('common:metrics.selectAll'),
    ])
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

  it('explains a missing live stream while disconnected', () => {
    renderPanel(3, { liveData: false })

    expect(screen.getByText(i18n.t('common:metrics.noLiveData'))).toBeTruthy()
    expect(screen.getAllByTestId('metric-chart')).toHaveLength(1)
  })
})

describe('MetricsPanel joint list', () => {
  it('puts the joint list on its own row under the header, not inside it', () => {
    renderPanel(7, { shown: [0, 1, 2, 3, 4, 5, 6] })

    const header = screen.getByText(i18n.t('common:metrics.title')).parentElement!
    const list = screen.getByTestId('metric-joint-list')

    // 七个关节挤在标题那一行时会把标题和按钮顶到下一行；现在整份列表独占紧随其后的一行。
    expect(header.contains(list)).toBe(false)
    expect(header.nextElementSibling).toBe(list)
    expect(within(header).queryAllByRole('checkbox')).toHaveLength(0)
    expect(within(list).getAllByRole('checkbox')).toHaveLength(7)
  })

  it('draws every joint as a checkbox instead of a colour swatch', () => {
    const { chips } = renderPanel(3, { shown: [0, 2] })

    // jsdom 把 `accent-color` 归一成 rgb()，所以两边都要先化成同一种写法再比。
    const rgb = (hex: string) =>
      `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes.map((b) => b.closest('label')?.textContent)).toEqual(['J1', 'J2', 'J3'])
    // 复选框的勾选状态就是"这条曲线画不画"，颜色仍然取该关节的曲线色。
    expect(boxes.map((b) => b.checked)).toEqual([true, false, true])
    expect(boxes[0].style.accentColor).toBe(rgb(chips[0].color))
    expect(boxes[2].style.accentColor).toBe(rgb(chips[2].color))
  })

  it('toggles one joint from its checkbox', () => {
    const { chips } = renderPanel(3)

    fireEvent.click(screen.getByRole('checkbox', { name: 'J2' }))

    expect(chips[1].toggle).toHaveBeenCalledTimes(1)
    expect(chips[0].toggle).not.toHaveBeenCalled()
  })

  it('selects every joint from the button on the joint row', () => {
    const { selectAll } = renderPanel(3)

    fireEvent.click(screen.getByRole('button', { name: i18n.t('common:metrics.selectAll') }))

    expect(selectAll).toHaveBeenCalledTimes(1)
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

  it('gives the chart enough height to be readable', () => {
    renderPanel(3, { compact: true })

    // 6rem 的绘图区只剩三行文字高，曲线挤成一条直线；这里钉住放宽后的高度。
    expect(screen.getByTestId('metric-chart').className).toContain('h-[10rem]')
  })
})

describe('MetricsPanel hover tooltip', () => {
  /** 光标停在图表里，chart.js 会调 `external`；用例把那个回调照原样调起来。 */
  function hover(joints: number, { opacity = 1, caretX = 5, caretY = 6 } = {}) {
    act(() => {
      captured.options?.plugins?.tooltip?.external?.({
        chart: { canvas: { getBoundingClientRect: () => ({ left: 10, top: 20 }) } },
        tooltip: {
          opacity,
          caretX,
          caretY,
          title: ['11:45:58'],
          dataPoints: Array.from({ length: joints }, (_, i) => ({
            dataset: { label: `J${i + 1}`, borderColor: '#123456' },
            parsed: { y: i + 0.5 },
          })),
        },
      })
    })
  }

  it('draws the readout in the DOM instead of the canvas so it cannot be clipped', () => {
    renderPanel(7, { shown: [0, 1, 2, 3, 4, 5, 6] })

    hover(7)

    const tip = screen.getByTestId('metric-tooltip')
    // 挂在 body 上、位置 fixed：卡片的 overflow-hidden 和左列的滚动都裁不到它。
    expect(tip.parentElement).toBe(document.body)
    expect(tip.closest('[data-slot="card"]')).toBeNull()
    expect(tip.className).toContain('fixed')
    // 七颗关节一个不少，两列排开；数值与单位都带上。
    expect(within(tip).getByText('11:45:58')).toBeTruthy()
    expect(within(tip).getAllByText(/^J\d$/)).toHaveLength(7)
    expect(within(tip).getByText('6.500')).toBeTruthy()
    expect(within(tip).getByText('°C')).toBeTruthy()
  })

  it('flips the readout to the other side of the caret near the window edge', () => {
    renderPanel(3)

    // 光标已经越过窗口中线（jsdom 视口宽 1024）：提示框向左上翻，不会顶出视口。
    hover(3, { caretX: 900, caretY: 800 })

    const transform = screen.getByTestId('metric-tooltip').style.transform
    expect(transform.match(/calc\(-100%/g)).toHaveLength(2)
  })

  it('takes the readout away when the pointer leaves the chart', () => {
    renderPanel(3)

    hover(3)
    expect(screen.queryByTestId('metric-tooltip')).not.toBeNull()

    hover(3, { opacity: 0 })
    expect(screen.queryByTestId('metric-tooltip')).toBeNull()
  })
})

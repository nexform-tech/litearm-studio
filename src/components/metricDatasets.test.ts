import { describe, expect, it } from 'vitest'
import { buildMetricDatasets } from './metricDatasets'
import type { MetricChip, SeriesSample } from '@/lib/arm'

// 曲线条数必须等于芯片条数（= daemon 报告的轴数），否则 `{1J}` 台架上仍会画出 7 条
// 曲线、其中 6 条永远为空（issue #37）。
function chip(i: number): MetricChip {
  return {
    key: `J${i + 1}`,
    k: `J${i + 1}`,
    t: '—',
    color: `#00000${i}`,
    bg: 'transparent',
    box: 'var(--line-strong)',
    text: 'var(--ink)',
    valFg: 'var(--ink-muted)',
    unitFg: 'var(--ink-faint)',
    toggle: () => {},
  }
}

const chips = (n: number) => Array.from({ length: n }, (_, i) => chip(i))

function sample(t: number, temp: number[]): SeriesSample {
  return { t, temp, dq: temp.map((v) => v / 10), tau: temp.map((v) => v / 100), err: [] }
}

const series = [sample(1, [10, 20, 30]), sample(2, [11, 21, 31])]

describe('buildMetricDatasets', () => {
  it('builds one curve per chip', () => {
    expect(buildMetricDatasets({ series, chips: chips(1), shown: [0], activeKey: 'temp' })).toHaveLength(1)
    expect(buildMetricDatasets({ series, chips: chips(7), shown: [], activeKey: 'temp' })).toHaveLength(7)
  })

  it('labels and colours each curve from its chip', () => {
    const sets = buildMetricDatasets({ series, chips: chips(3), shown: [], activeKey: 'temp' })

    expect(sets.map((d) => d.label)).toEqual(['J1', 'J2', 'J3'])
    expect(sets.map((d) => d.borderColor)).toEqual(['#000000', '#000001', '#000002'])
  })

  it('reads the selected metric channel and leaves missing axes empty', () => {
    const sets = buildMetricDatasets({ series, chips: chips(2), shown: [], activeKey: 'temp' })

    expect(sets[0].data).toEqual([10, 11])
    expect(sets[1].data).toEqual([20, 21])
    // 只有一个通道的数据时，第二个关节补 null 而不是伪造读数。
    const single = buildMetricDatasets({ series: [sample(1, [10])], chips: chips(2), shown: [], activeKey: 'dq' })
    expect(single[0].data).toEqual([1])
    expect(single[1].data).toEqual([null])
  })

  it('hides the curves the operator deselected', () => {
    const sets = buildMetricDatasets({ series, chips: chips(3), shown: [1], activeKey: 'temp' })

    expect(sets.map((d) => d.hidden)).toEqual([true, false, true])
  })

  it('has no data before the first sample', () => {
    const sets = buildMetricDatasets({ series: [], chips: chips(1), shown: [0], activeKey: 'temp' })

    expect(sets[0].data).toEqual([])
  })
})

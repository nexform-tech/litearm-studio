import type { ChartDataset } from 'chart.js'
import type { MetricChip, MetricType, SeriesSample } from '@/lib/arm'

function pick(s: SeriesSample, metric: MetricType | undefined): number[] {
  return metric === 'temp' ? s.temp : metric === 'dq' ? s.dq : metric === 'tau' ? s.tau : s.err
}

/**
 * 图表曲线。
 *
 * ⚠ **曲线条数与指标芯片同源**（都以 `chips` 为准，而 `chips` 的长度是 daemon 在
 * `conn` 帧里报告的轴数 `n`）。以前这里各自按写死的 7 色 `JOINT_COLORS` 建 dataset，
 * 于是一台 `{1J}` 台架依然画 7 条曲线，其中 6 条永远没有数据（issue #37）。
 * 单独抽成纯函数也是为了能直接测：`MetricsPanel` 一渲染就要 WebGL/canvas，
 * 在 jsdom 里测不动。
 */
export function buildMetricDatasets({
  series,
  chips,
  shown,
  activeKey,
}: {
  series: SeriesSample[]
  chips: MetricChip[]
  shown: number[]
  activeKey: MetricType | undefined
}): ChartDataset<'line'>[] {
  return chips.map((chip, i) => ({
    label: chip.k,
    data: series.map((s) => pick(s, activeKey)[i] ?? null),
    borderColor: chip.color,
    tension: 0.3,
    pointRadius: 0,
    borderWidth: 1.5,
    hidden: !shown.includes(i),
  }))
}

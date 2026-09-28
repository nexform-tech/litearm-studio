import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  type ChartData,
  type ChartOptions,
  type TooltipItem,
} from 'chart.js'
import { Line } from 'react-chartjs-2'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { buildMetricDatasets } from '@/components/metricDatasets'
import { chartCountFor } from '@/components/metricChartCount'
import type { SeriesSample, MetricSeries, MetricChip } from '@/lib/arm'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip)
ChartJS.defaults.font.family = "'JetBrains Mono', ui-monospace, monospace"

export type MetricsPanelProps = {
  /** 按优先级排列的指标；高度不够时从后往前少画。 */
  metrics: MetricSeries[]
  pauseLabel: string
  togglePause: () => void
  series: SeriesSample[]
  shown: number[]
  liveData: boolean
  simMode: boolean
  chips: MetricChip[]
  selectAll: () => void
  selectNone: () => void
}

export function MetricsPanel({
  metrics,
  pauseLabel,
  togglePause,
  series,
  shown,
  liveData,
  simMode,
  chips,
  selectAll,
  selectNone,
}: MetricsPanelProps) {
  const { t, i18n } = useTranslation(['common'])
  const chartsRef = useRef<HTMLDivElement | null>(null)
  // 先按 1 张渲染，挂载后立刻按真实高度重算；量不到高度时停在 1。
  const [count, setCount] = useState(1)

  useEffect(() => {
    const el = chartsRef.current
    if (!el) return
    const measure = () => {
      const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize)
      setCount(chartCountFor(el.clientHeight, rootPx, metrics.length))
    }
    measure()
    // jsdom 没有 ResizeObserver —— 那里量不到高度，停在 1 张即可，不影响渲染断言。
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [metrics.length])

  // 标签对所有图一致：同一个 10s 滚动窗口。
  const labels = useMemo(
    () =>
      series.map((s) =>
        new Date(s.t).toLocaleTimeString(i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US', {
          hour12: false,
        }),
      ),
    [series, i18n.language],
  )

  // 每张图一条曲线/关节 —— 条数跟着 chips（= daemon 报告的轴数）走，不固定 7（issue #37）。
  const charts = useMemo(() => metrics.slice(0, count), [metrics, count])

  const dataFor = (m: MetricSeries): ChartData<'line'> => ({
    labels,
    datasets: buildMetricDatasets({ series, chips, shown, activeKey: m.id }),
  })

  const optionsFor = (m: MetricSeries): ChartOptions<'line'> => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(23,33,47,0.92)',
        titleColor: '#ffffff',
        bodyColor: '#dfe6ee',
        padding: 8,
        cornerRadius: 6,
        boxPadding: 4,
        callbacks: {
          label: (item: TooltipItem<'line'>) =>
            ` J${item.datasetIndex + 1}: ${Number(item.parsed.y).toFixed(3)} ${m.unit}`,
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        border: { color: 'rgba(128,138,150,0.3)' },
        ticks: { color: '#9aa6b6', font: { size: 10 }, maxTicksLimit: 4, maxRotation: 0 },
      },
      y: {
        suggestedMin: m.id === 'temp' ? 0 : undefined,
        grid: { color: 'rgba(128,138,150,0.16)' },
        border: { display: false },
        ticks: { color: '#9aa6b6', font: { size: 10 }, maxTicksLimit: 3 },
      },
    },
  })

  return (
    <Card className="min-h-[15rem] flex-1 gap-2 rounded-[0.875rem] px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b pb-1.5">
        <div className="text-[0.90625rem] font-semibold text-foreground">
          {t('common:metrics.title')}
        </div>
        {chips.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={c.toggle}
            title={c.k}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-[var(--hover)]"
            style={{ background: c.bg }}
          >
            <div className="h-[0.15625rem] w-3 rounded-sm" style={{ background: c.box }} />
            <div className="font-mono text-[0.6875rem] font-semibold" style={{ color: c.text }}>
              {c.k}
            </div>
          </button>
        ))}
        <Button
          type="button"
          variant="outline"
          onClick={selectAll}
          className="h-auto rounded-md px-1.5 py-0.5 text-[0.65625rem] text-ink-muted"
        >
          {t('common:metrics.selectAll')}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={selectNone}
          className="h-auto rounded-md px-1.5 py-0.5 text-[0.65625rem] text-ink-muted"
        >
          {t('common:metrics.clearAll')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={togglePause}
          className="ml-auto h-auto px-1.5 py-0.5 text-[0.71875rem] text-muted-foreground"
        >
          {pauseLabel}
        </Button>
      </div>

      <div ref={chartsRef} className="flex min-h-0 flex-1 flex-col gap-2">
        {charts.map((m) => (
          <div
            key={m.id}
            className="flex min-h-0 flex-1 flex-col rounded-[0.625rem] border bg-muted/30 px-2 py-1.5"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <div className="flex items-baseline gap-1.5">
                <span className="text-[0.78125rem] font-semibold text-foreground">{m.name}</span>
                <span className="font-mono text-[0.625rem] text-muted-foreground">{m.unit}</span>
                <span className="font-mono text-[0.5625rem] text-muted-foreground/70">{m.axis}</span>
              </div>
              {/* 每个关节在这个指标下的当前读数；被关掉的曲线压暗但仍然显示数值。 */}
              <div className="flex flex-wrap items-baseline gap-x-2">
                {chips.map((c, i) => (
                  <span
                    key={c.key}
                    className="font-mono text-[0.625rem] whitespace-nowrap"
                    style={{ color: c.on ? 'var(--ink-muted)' : 'var(--line-strong)' }}
                  >
                    {c.k} {m.live?.[i] ?? '—'}
                  </span>
                ))}
              </div>
            </div>
            <div className="relative min-h-0 flex-1">
              {(!liveData || m.noData) && (
                <div className="absolute inset-0 z-10 flex items-center justify-center px-2 text-center font-mono text-[0.6875rem] text-muted-foreground/80">
                  {m.noData
                    ? t('common:metrics.errUnavailable')
                    : simMode
                      ? t('common:metrics.simData')
                      : t('common:metrics.noLiveData')}
                </div>
              )}
              <div className="absolute inset-0 px-1 pt-1 pb-0.5">
                <Line data={dataFor(m)} options={optionsFor(m)} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

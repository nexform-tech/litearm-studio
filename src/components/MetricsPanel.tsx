import { useMemo } from 'react'
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { JOINT_COLORS } from '@/lib/colors'
import type { SeriesSample, MetricTab, MetricChip } from '@/lib/arm'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip)
ChartJS.defaults.font.family = "'JetBrains Mono', ui-monospace, monospace"

export type MetricsPanelProps = {
  metrics: MetricTab[]
  metricUnit: string
  metricAxis: string
  pauseLabel: string
  togglePause: () => void
  series: SeriesSample[]
  shown: number[]
  liveData: boolean
  simMode: boolean
  chips: MetricChip[]
  selectAll: () => void
  selectNone: () => void
  /** 当前指标在实机广播中不存在时置 true（如跟踪误差），图表区显示"暂无数据"。 */
  noData?: boolean
}

export function MetricsPanel({
  metrics,
  metricUnit,
  metricAxis,
  pauseLabel,
  togglePause,
  series,
  shown,
  liveData,
  simMode,
  chips,
  selectAll,
  selectNone,
  noData = false,
}: MetricsPanelProps) {
  const { t, i18n } = useTranslation(['common'])
  const activeKey = metrics.find((m) => m.active)?.key

  // 按当前指标取通道，构建 Chart.js 数据（近 10s 滚动窗口，每条曲线一个关节）。
  const chartData: ChartData<'line'> = useMemo(() => {
    const pick = (s: SeriesSample): number[] =>
      activeKey === 'temp' ? s.temp : activeKey === 'dq' ? s.dq : activeKey === 'tau' ? s.tau : s.err
    return {
      labels: series.map((s) =>
        new Date(s.t).toLocaleTimeString(i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US', { hour12: false }),
      ),
      datasets: JOINT_COLORS.map((c, i) => ({
        label: `J${i + 1}`,
        data: series.map((s) => pick(s)[i] ?? null),
        borderColor: c,
        tension: 0.3,
        pointRadius: 0,
        borderWidth: 1.5,
        hidden: !shown.includes(i),
      })),
    }
  }, [series, shown, activeKey, i18n.language])

  const chartOptions: ChartOptions<'line'> = {
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
            ` J${item.datasetIndex + 1}: ${Number(item.parsed.y).toFixed(3)} ${metricUnit}`,
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        border: { color: 'rgba(128,138,150,0.3)' },
        ticks: { color: '#9aa6b6', font: { size: 10 }, maxTicksLimit: 6, maxRotation: 0 },
      },
      y: {
        suggestedMin: activeKey === 'temp' ? 0 : undefined,
        grid: { color: 'rgba(128,138,150,0.16)' },
        border: { display: false },
        ticks: { color: '#9aa6b6', font: { size: 10 } },
      },
    },
  }

  return (
    <Card className="min-h-[15rem] flex-1 gap-2.5 rounded-[0.875rem] px-3.5 py-3">
      <div className="flex items-end justify-between border-b">
        <Tabs
          value={activeKey}
          onValueChange={(key) => metrics.find((m) => m.key === key)?.onClick()}
        >
          <TabsList variant="line" className="h-auto p-0">
            {metrics.map((m) => (
              <TabsTrigger key={m.key} value={m.key} className="rounded-none px-0 pb-2 text-[0.84375rem] font-semibold">
                {m.name}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-[0.5625rem] pb-[0.4375rem]">
          <div className="font-mono text-[0.6875rem] text-muted-foreground">{metricUnit}</div>
          <Button type="button" variant="ghost" size="sm" onClick={togglePause} className="h-auto px-1.5 py-0.5 text-[0.71875rem] text-muted-foreground">
            {pauseLabel}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-2.5">
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-[0.625rem] border bg-muted/30">
          <div className="absolute top-1 left-2 z-10 font-mono text-[0.625rem] text-muted-foreground/70">{metricAxis}</div>
          <div className="absolute top-1 right-2 z-10 font-mono text-[0.625rem] text-muted-foreground/70">{t('common:metrics.recent10s')}</div>
          {(!liveData || noData) && (
            <div className="absolute inset-0 z-10 flex items-center justify-center font-mono text-[0.6875rem] text-muted-foreground/80">
              {noData
                ? t('common:metrics.errUnavailable')
                : simMode
                  ? t('common:metrics.simData')
                  : t('common:metrics.noLiveData')}
            </div>
          )}
          <div className="absolute inset-0 px-1 pt-4 pb-0.5">
            <Line data={chartData} options={chartOptions} />
          </div>
        </div>
        <div className="flex w-[9.125rem] flex-none flex-col gap-[0.1875rem]">
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={c.toggle}
              className="flex flex-1 items-center gap-[0.4375rem] rounded-md px-[0.4375rem] transition-colors hover:bg-[var(--hover)]"
              style={{ background: c.bg }}
            >
              <div className="h-[0.15625rem] w-3 rounded-sm" style={{ background: c.box }} />
              <div className="font-mono text-[0.6875rem] font-semibold" style={{ color: c.text }}>{c.k}</div>
              <div className="flex-1" />
              <div className="flex items-baseline gap-0.5">
                <div className="font-mono text-[0.71875rem] font-semibold" style={{ color: c.valFg }}>{c.t}</div>
                <div className="font-mono text-[0.5625rem]" style={{ color: c.unitFg }}>{metricUnit}</div>
              </div>
            </button>
          ))}
          <div className="flex gap-1 pt-0.5">
            <Button type="button" variant="outline" onClick={selectAll} className="h-auto flex-1 rounded-md py-[0.1875rem] text-[0.65625rem] text-ink-muted">
              {t('common:metrics.selectAll')}
            </Button>
            <Button type="button" variant="outline" onClick={selectNone} className="h-auto flex-1 rounded-md py-[0.1875rem] text-[0.65625rem] text-ink-muted">
              {t('common:metrics.clearAll')}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  )
}

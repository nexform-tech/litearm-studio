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
import { SegmentedControl, type SegItem } from '@/components/SegmentedControl'
import { buildMetricDatasets } from '@/components/metricDatasets'
import type { SeriesSample, MetricSeries, MetricChip, MetricType } from '@/lib/arm'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip)
ChartJS.defaults.font.family = "'JetBrains Mono', ui-monospace, monospace"

export type MetricsPanelProps = {
  /** 可切换的指标，顺序即标签顺序。 */
  metrics: MetricSeries[]
  /** 当前展示的指标（由选择记忆决定，见 `lib/arm/metricSelection`）。 */
  activeMetric: MetricType
  selectMetric: (id: MetricType) => void
  pauseLabel: string
  togglePause: () => void
  series: SeriesSample[]
  shown: number[]
  liveData: boolean
  simMode: boolean
  chips: MetricChip[]
  selectAll: () => void
  selectNone: () => void
  /**
   * 压扁形态：卡片不再抢高度、图表固定 6rem，并省掉与指标页签重复的
   * 「指标名 / 单位 / 轴」那一行。控制页把曲线垫在「当前位姿」底下时用它。
   */
  compact?: boolean
}

export function MetricsPanel({
  metrics,
  activeMetric,
  selectMetric,
  pauseLabel,
  togglePause,
  series,
  shown,
  liveData,
  simMode,
  chips,
  selectAll,
  selectNone,
  compact = false,
}: MetricsPanelProps) {
  const { t, i18n } = useTranslation(['common'])

  // 一次只画一张：右列高度只够一张能读的图，其余指标靠上面的标签切换，而不是挤在一起。
  const active = metrics.find((m) => m.id === activeMetric) ?? metrics[0]

  const tabs: SegItem[] = useMemo(
    () =>
      metrics.map((m) => ({
        key: m.id,
        label: m.name,
        active: m.id === active?.id,
        onClick: () => selectMetric(m.id),
      })),
    [metrics, active?.id, selectMetric],
  )

  // 标签对所有指标一致：同一个 10s 滚动窗口。
  const labels = useMemo(
    () =>
      series.map((s) =>
        new Date(s.t).toLocaleTimeString(i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US', {
          hour12: false,
        }),
      ),
    [series, i18n.language],
  )

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
        // 整块面板现在只有一张图，横轴放得下比原来多一倍的时间刻度。
        ticks: { color: '#9aa6b6', font: { size: 10 }, maxTicksLimit: 6, maxRotation: 0 },
      },
      y: {
        suggestedMin: m.id === 'temp' ? 0 : undefined,
        grid: { color: 'rgba(128,138,150,0.16)' },
        border: { display: false },
        ticks: { color: '#9aa6b6', font: { size: 10 }, maxTicksLimit: 5 },
      },
    },
  })

  return (
    <Card
      className={
        compact
          ? 'flex-none gap-2 rounded-[0.875rem] px-3.5 py-3'
          : 'min-h-[15rem] flex-1 gap-2 rounded-[0.875rem] px-3.5 py-3'
      }
    >
      {/* 第一行：标题、全选/清空、指标页签与暂停，全部挤在一行里 —— 关节列表从这里搬走，
          腾出的正是这一行需要的宽度：一台七轴臂的七个关节曾把标题和按钮顶到下一行。 */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b pb-1.5">
        <div className="text-[0.90625rem] font-semibold text-foreground">
          {t('common:metrics.title')}
        </div>
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
        {/* 指标切换：高度不足时不再从后往前丢图，而是让用户自己选看哪一个。
            页签和全选/清空同在标题行，图表那一片就只剩图本身。 */}
        <SegmentedControl
          items={tabs}
          ariaLabel={t('common:metrics.selectMetric')}
          containerStyle={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.1875rem',
            background: 'var(--line-soft)',
            borderRadius: '0.5625rem',
            padding: '0.1875rem',
          }}
          itemStyle={{
            padding: '0.3125rem 0.5rem',
            borderRadius: '0.4375rem',
            fontSize: '0.71875rem',
            color: 'var(--ink-subtle)',
            fontWeight: 500,
            whiteSpace: 'nowrap',
          }}
          activeItemStyle={{
            background: 'var(--seg-active)',
            color: 'var(--ink)',
            fontWeight: 650,
            boxShadow: '0 0.0625rem 0.125rem rgba(16,24,40,.1)',
          }}
        />
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

      {/* 第二行：关节列表独占一行，一颗关节一个复选框 —— 原来的颜色线段只是图例，
          勾选才是"这条曲线画不画"这个动作本身，复选框把它变成可点的控件。
          复选框的强调色仍取该关节的曲线色，勾上时颜色与图上的曲线一一对应。
          紧跟在「全选 / 清空」下面：那两颗按钮管的就是这一行。 */}
      <div
        data-testid="metric-joint-list"
        className="flex flex-wrap items-center gap-x-1 gap-y-1 rounded-[0.5625rem] bg-muted/30 px-1 py-1"
      >
        {chips.map((c) => (
          <label
            key={c.key}
            className="flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-[var(--hover)]"
          >
            <input
              type="checkbox"
              checked={c.on}
              onChange={c.toggle}
              className="size-3 flex-none cursor-pointer"
              style={{ accentColor: c.color }}
            />
            <span
              className="font-mono text-[0.6875rem] font-semibold"
              style={{ color: c.on ? 'var(--ink)' : 'var(--ink-ghost)' }}
            >
              {c.k}
            </span>
          </label>
        ))}
      </div>

      {active ? (
        <div
          data-testid="metric-chart"
          className={
            compact
              ? 'flex h-[6rem] flex-none flex-col rounded-[0.625rem] border bg-muted/30 px-2 py-1.5'
              : 'flex min-h-0 flex-1 flex-col rounded-[0.625rem] border bg-muted/30 px-2 py-1.5'
          }
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            {compact ? null : (
              <div className="flex items-baseline gap-1.5">
                <span className="text-[0.78125rem] font-semibold text-foreground">{active.name}</span>
                <span className="font-mono text-[0.625rem] text-muted-foreground">{active.unit}</span>
                <span className="font-mono text-[0.5625rem] text-muted-foreground/70">
                  {active.axis}
                </span>
              </div>
            )}
            {/* 每个关节在当前指标下的读数；被关掉的曲线压暗但仍然显示数值。 */}
            <div className="flex flex-wrap items-baseline gap-x-2">
              {chips.map((c, i) => (
                <span
                  key={c.key}
                  className="font-mono text-[0.625rem] whitespace-nowrap"
                  style={{ color: c.on ? 'var(--ink-muted)' : 'var(--line-strong)' }}
                >
                  {c.k} {active.live?.[i] ?? '—'}
                </span>
              ))}
            </div>
          </div>
          <div className="relative min-h-0 flex-1">
            {!liveData && (
              <div className="absolute inset-0 z-10 flex items-center justify-center px-2 text-center font-mono text-[0.6875rem] text-muted-foreground/80">
                {simMode ? t('common:metrics.simData') : t('common:metrics.noLiveData')}
              </div>
            )}
            <div className="absolute inset-0 px-1 pt-1 pb-0.5">
              <Line data={dataFor(active)} options={optionsFor(active)} />
            </div>
          </div>
        </div>
      ) : null}
    </Card>
  )
}

import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
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
} from 'chart.js'
import { Line } from 'react-chartjs-2'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { SegmentedControl, type SegItem } from '@/components/SegmentedControl'
import { buildMetricDatasets } from '@/components/metricDatasets'
import type { SeriesSample, MetricSeries, MetricChip, MetricType } from '@/lib/arm'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip)
ChartJS.defaults.font.family = "'JetBrains Mono', ui-monospace, monospace"

/** 悬停提示的内容与落点：坐标相对视口（fixed），读数两列排开，七颗关节只占四行。 */
type HoverTip = {
  left: number
  top: number
  /** 光标过了窗口中/下线就翻到另一侧，贴边时不会把提示框顶出视口。 */
  flipX: boolean
  flipY: boolean
  title: string
  rows: { k: string; v: string; color: string }[]
}

function buildChartData({
  labels,
  series,
  chips,
  shown,
  activeKey,
}: {
  labels: string[]
  series: SeriesSample[]
  chips: MetricChip[]
  shown: number[]
  activeKey: MetricType
}): ChartData<'line'> {
  return { labels, datasets: buildMetricDatasets({ series, chips, shown, activeKey }) }
}

/**
 * 图表配置。提示框交给 `onHover` 画成 DOM，见下面 `plugins.tooltip` 的注释。
 *
 * 放在组件外面是为了能安全 memo：鼠标一动就会 setState，闭包一旦在里面重建，
 * `options` 的引用每次都变，chart.js 会跟着重画整张图。
 */
function buildChartOptions(
  m: MetricSeries,
  onHover: (tip: HoverTip | null) => void,
): ChartOptions<'line'> {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      // ⚠ 别把提示框交回 canvas：七颗关节一起报数时它比绘图区还高，底部几行会被图框
      // （以及卡片的 overflow-hidden）裁掉，只剩 J1–J5 看得到。改成 DOM 画在 body 上，
      // 位置 fixed、两列排布，图再矮也不会切掉最后一行。
      tooltip: {
        enabled: false,
        external: (ctx) => {
          const { chart, tooltip } = ctx
          if (!tooltip.opacity || !tooltip.dataPoints?.length) {
            onHover(null)
            return
          }
          const rect = chart.canvas.getBoundingClientRect()
          const left = rect.left + tooltip.caretX
          const top = rect.top + tooltip.caretY
          onHover({
            left,
            top,
            // 光标过了窗口中线就翻到另一侧，提示框不会顶出视口。
            flipX: left > window.innerWidth / 2,
            flipY: top > window.innerHeight / 2,
            title: String(tooltip.title?.[0] ?? ''),
            rows: tooltip.dataPoints.map((p) => ({
              k: String(p.dataset.label ?? ''),
              v: Number(p.parsed.y).toFixed(3),
              color: String(p.dataset.borderColor ?? 'var(--line-strong)'),
            })),
          })
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
  }
}

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
  /** 勾选全部关节曲线。它是关节那一行的动作，所以画在那一行里。 */
  selectAll: () => void
  /**
   * 压扁形态：卡片不再抢高度、图表固定 10rem，并省掉与指标页签重复的
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
  compact = false,
}: MetricsPanelProps) {
  const { t, i18n } = useTranslation(['common'])

  /** 悬停提示：由 chart.js 的 external 回调写入，画在 body 上而不是 canvas 里。 */
  const [hover, setHover] = useState<HoverTip | null>(null)

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

  // ⚠ 提示框的状态只喂给下面那个浮层：`data` / `options` 必须 memo 住，否则鼠标每移动
  // 一像素都会造出一对新对象，chart.js 跟着重画一次整张图。
  const chartData = useMemo(
    () => (active ? buildChartData({ labels, series, chips, shown, activeKey: active.id }) : null),
    [active, labels, series, chips, shown],
  )
  const chartOptions = useMemo(
    () => (active ? buildChartOptions(active, setHover) : null),
    [active],
  )

  return (
    <Card
      className={
        compact
          ? 'flex-none gap-2 rounded-[0.875rem] px-3.5 py-3'
          : 'min-h-[15rem] flex-1 gap-2 rounded-[0.875rem] px-3.5 py-3'
      }
    >
      {/* 第一行：标题、指标页签与暂停 —— 关节列表搬走以后，这一行只放这三样。 */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b pb-1.5">
        <div className="text-[0.90625rem] font-semibold text-foreground">
          {t('common:metrics.title')}
        </div>
        {/* 指标切换：高度不足时不再从后往前丢图，而是让用户自己选看哪一个。
            页签和标题、暂停同在标题行，图表那一片就只剩图本身。 */}
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

      {/* 第二行：关节列表独占一行，一颗关节一个复选框，行尾是「全选」—— 原来的颜色线段
          只是图例，勾选才是"这条曲线画不画"这个动作本身，复选框把它变成可点的控件。
          复选框的强调色仍取该关节的曲线色，勾上时颜色与图上的曲线一一对应。
          「全选」靠右：它是这一行的批量动作，不该插在 J1 前面冒充第一颗关节。
          没有「清空」：逐个取消勾选就够了，多一颗按钮只会挤这一行。 */}
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
        <Button
          type="button"
          variant="outline"
          onClick={selectAll}
          className="ml-auto h-auto flex-none rounded-md px-1.5 py-0.5 text-[0.65625rem] text-ink-muted"
        >
          {t('common:metrics.selectAll')}
        </Button>
      </div>

      {active && chartData && chartOptions ? (
        // ⚠ 压扁形态的 6rem 是画不出东西的：读数行和横轴标签各吃掉一行之后，绘图区只剩
        // 三行文字高，7 条曲线挤成一条直线。10rem 才留得出能看的绘图区。
        <div
          data-testid="metric-chart"
          className={
            compact
              ? 'flex h-[10rem] flex-none flex-col rounded-[0.625rem] border bg-muted/30 px-2 py-1.5'
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
              <Line data={chartData} options={chartOptions} />
            </div>
          </div>
        </div>
      ) : null}

      {/* 提示框挂在 body 上：卡片的 overflow-hidden 和左列的滚动容器都裁不到它。 */}
      {hover
        ? createPortal(
            <div
              data-testid="metric-tooltip"
              className="pointer-events-none fixed z-50 grid gap-y-0.5 rounded-md bg-[rgba(23,33,47,0.96)] px-2 py-1.5 font-mono text-[0.6875rem] leading-[1.3] text-[#dfe6ee] shadow-lg ring-1 ring-white/10"
              style={{
                left: hover.left,
                top: hover.top,
                transform: hover.flipX
                  ? `translate(calc(-100% - 0.75rem), ${hover.flipY ? 'calc(-100% - 0.75rem)' : '0.75rem'})`
                  : `translate(0.75rem, ${hover.flipY ? 'calc(-100% - 0.75rem)' : '0.75rem'})`,
              }}
            >
              <div className="text-[0.625rem] font-semibold text-white">
                {hover.title}
                {active ? (
                  <span className="ml-1 font-normal text-[#9aa6b6]">{active.unit}</span>
                ) : null}
              </div>
              {/* 两列：七颗关节只占四行，面板再矮也不会把最后一行挤出去。 */}
              <div className="grid grid-cols-2 gap-x-3">
                {hover.rows.map((r) => (
                  <div key={r.k} className="flex items-center gap-1 whitespace-nowrap">
                    <span
                      className="size-1.5 flex-none rounded-[0.125rem]"
                      style={{ background: r.color }}
                    />
                    <span>{r.k}</span>
                    <span className="ml-auto font-semibold text-white">{r.v}</span>
                  </div>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </Card>
  )
}

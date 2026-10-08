import { useTranslation } from 'react-i18next'
import type { ContextSeries } from '@/lib/log/sampleContext'

/**
 * 极简折线 —— 只够画"事件附近那一小段采样"。
 *
 * 谁读这个文件: 要改事件折叠区里那张图的人。
 *
 * ⚠ 这里**刻意不用 chart.js**。采样 tab 那张趋势图用的是它, 但它是另一种东西: 可切换
 * 指标、可暂停、可勾选轴、几十秒的窗口。事件折叠区要的只是一条约 20 点的形状, 而把
 * chart.js 拖进 `/log` 这个路由, 会为了一个小折线让最常用的页面多加载一份 150KB 的
 * 图形栈。手写 SVG 的代价是**做不了**交互 (没有 tooltip/缩放), 那是刻意的取舍: 需要
 * 交互时, 采样 tab 就在旁边。
 *
 * 数值仍然以**文字**给出 (起止/极值), 因为一眼读数是操作员最常用的一步, 也让这张图在
 * 纯文本环境 (测试、导出的截图) 里仍然有信息。
 */

const VIEW_W = 240
const VIEW_H = 48
const PAD = 3

export type SparklineProps = {
  series: ContextSeries
  /** 与 `series.values` 对齐的纳秒时间戳, 用于把横轴两端标成时间。 */
  times: number[]
  locale: string
}

function formatClock(tsNs: number, locale: string): string {
  if (!Number.isFinite(tsNs) || tsNs <= 0) return ''
  const date = new Date(tsNs / 1e6)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString(locale.startsWith('en') ? 'en-US' : 'zh-CN', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

/**
 * 一个区间的小数位数 —— **两端共用**。
 *
 * ⚠ 精度必须对两端一起定, 不能各算各的。逐值判断会把 [2.5, 3.0] 渲染成
 * "2.5–3" —— 两个端点看着像不同量级的数, 而实际上只差 0.5。整数区间 (温度几乎总是
 * 整数) 则一位小数都不写: "70–78" 比 "70.0–78.0" 少两个纯噪音字符。
 */
function decimalsFor(min: number, max: number): number {
  if (Number.isInteger(min) && Number.isInteger(max)) return 0
  return Math.abs(max) >= 100 || Math.abs(min) >= 100 ? 0 : 1
}

function formatValue(value: number, decimals: number): string {
  return Number.isFinite(value) ? value.toFixed(decimals) : '0'
}

export function Sparkline({ series, times, locale }: SparklineProps) {
  const { t } = useTranslation('logs')
  const values = series.values
  if (values.length === 0) {
    return <div className="text-[0.6875rem] text-muted-foreground">{t('contextNoSamples')}</div>
  }

  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min
  // ⚠ 恒定的一条线 (span=0, 例如所有轴都是 0.0Nm) 必须画成**中间一条水平线**:
  // 除以 0 会得到 NaN, `points` 就成了 `NaN,NaN` —— SVG 会静默什么都不画, 于是
  // "一直是 0"看起来跟"没有数据"一模一样。
  const x = (index: number) =>
    values.length === 1
      ? VIEW_W / 2
      : PAD + (index / (values.length - 1)) * (VIEW_W - PAD * 2)
  const y = (value: number) =>
    span === 0 ? VIEW_H / 2 : PAD + (1 - (value - min) / span) * (VIEW_H - PAD * 2)

  const decimals = decimalsFor(min, max)
  const points = values.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(' ')

  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex items-baseline justify-between gap-2 text-[0.6875rem]">
        <span className="font-mono font-semibold text-foreground">
          {series.label}
          <span className="ml-1 font-normal text-muted-foreground">{series.unit}</span>
        </span>
        <span className="font-mono text-muted-foreground">
          {formatValue(min, decimals)}–{formatValue(max, decimals)}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-label={`${series.label} ${series.unit} ${formatValue(min, decimals)}–${formatValue(max, decimals)}`}
        className="h-12 w-full text-foreground/70"
        preserveAspectRatio="none"
      >
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.25"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="flex justify-between font-mono text-[0.625rem] text-muted-foreground">
        <span>{formatClock(times[0] ?? 0, locale)}</span>
        <span>{formatClock(times[times.length - 1] ?? 0, locale)}</span>
      </div>
    </div>
  )
}

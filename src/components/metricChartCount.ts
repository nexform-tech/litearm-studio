/**
 * 右侧曲线面板的排版判据 —— 单独成文件，因为组件文件只允许导出组件
 * （`react/only-export-components`：混着导出会让 Fast Refresh 失效）。
 */

/**
 * 一张图至少要占的 rem 高度。低于这个高度坐标轴和曲线都读不出来，所以宁可少画一张。
 *
 * ⚠ 11rem 是按右侧栏的实测高度定的：在 1920x1080 上栏内可用约 810px、根字号 16.44px，
 * 得 4.5 张 ⇒ 画满 4 张；在 1366x768 上约 550px、根字号 13px，得 3.8 张 ⇒ 3 张；
 * 窗口更矮时依次降到 2、1。调这个数就直接改可画的张数。
 */
export const MIN_CHART_REM = 11

/**
 * 按可用高度算能画几张图。
 *
 * 结果落在 `1..total`：永远至少画一张（有数据却什么都不显示更糟），也绝不超过指标数。
 */
export function chartCountFor(
  availablePx: number,
  rootFontPx: number,
  total: number,
  minRem: number = MIN_CHART_REM,
): number {
  if (!Number.isFinite(availablePx) || availablePx <= 0) return 1
  const minBlock = Math.max(1, minRem * (rootFontPx > 0 ? rootFontPx : 16))
  return Math.max(1, Math.min(total, Math.floor(availablePx / minBlock)))
}

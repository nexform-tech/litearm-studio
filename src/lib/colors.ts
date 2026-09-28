// Shared palette lifted 1:1 from the design mockup's Component class.
export const JOINT_COLORS = ['#e5484d', '#3b82f6', '#12a150', '#a855f7', '#f5a524', '#06b6d4', '#ec4899']

/**
 * 第 `i` 个关节的颜色 (`i` 从 0 起)。
 *
 * 调色板只有 7 色，是**配色**而不是轴数上限 —— 画几个关节由 `conn` 帧报告的 `n`
 * 决定 (见 `lib/arm/axes.ts`)，超出 7 轴时循环复用颜色，不能让手里那台臂的轴数
 * 反过来被调色板长度卡住。
 */
export function jointColor(i: number): string {
  return JOINT_COLORS[i % JOINT_COLORS.length]
}

export const AXIS_COLORS = ['#3b82f6', '#12a150', '#f5a524', '#8b5cf6', '#ef4444', '#0ea5a4']

export const INK = '#17212f'

import { useSyncExternalStore } from 'react'

/**
 * 主题（浅色 / 深色）单一数据源。
 *
 * 深色主题通过 `<html class="dark">` 生效：`styles/index.css` 里的设计令牌
 * 在 `.dark` 下整体覆盖，3D 预览（RobotViewport）也监听这个 class 切换配色，
 * 因此组件层只需要读令牌，不需要知道当前是哪个主题。
 *
 * 首次打开时跟随系统配色，用户手动切换后写入 localStorage，此后以用户的
 * 选择为准。首帧由 index.html 里的内联脚本提前设置，避免刷新时闪白。
 */
export type Theme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'litearm_theme'

const listeners = new Set<() => void>()

function readStoredTheme(): Theme | null {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY)
    return raw === 'dark' || raw === 'light' ? raw : null
  } catch {
    // 隐私模式等场景下 localStorage 不可用，退回到系统配色
    return null
  }
}

/** 系统偏好；jsdom / 老浏览器没有 matchMedia 时按浅色处理。 */
export function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light'
}

/** 当前生效的主题，直接以 DOM 上的 class 为准（内联脚本也写这个 class）。 */
export function getTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

function notify(): void {
  for (const listener of listeners) listener()
}

/** 显式设置主题并持久化（用户点击切换时调用）。 */
export function setTheme(theme: Theme): void {
  applyTheme(theme)
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // 写入失败不影响本次切换生效
  }
  notify()
}

export function toggleTheme(): void {
  setTheme(getTheme() === 'dark' ? 'light' : 'dark')
}

/**
 * 应用启动时调用：按「用户选择 → 系统偏好」决定首屏主题。
 * 幂等，重复调用只按同样的规则重新计算。
 */
export function initTheme(): Theme {
  const theme = readStoredTheme() ?? systemTheme()
  applyTheme(theme)
  return theme
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 订阅当前主题；任何组件都能用它渲染主题相关的文案 / 图标。 */
export function useTheme(): { theme: Theme; setTheme: typeof setTheme; toggleTheme: typeof toggleTheme } {
  const theme = useSyncExternalStore(subscribe, getTheme, () => 'light' as Theme)
  return { theme, setTheme, toggleTheme }
}

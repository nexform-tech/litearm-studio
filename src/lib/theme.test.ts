import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  THEME_STORAGE_KEY,
  getTheme,
  initTheme,
  setTheme,
  systemTheme,
  toggleTheme,
} from './theme'

function stubSystemDark(dark: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: dark && query.includes('prefers-color-scheme: dark'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

describe('主题切换', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark')
    localStorage.clear()
    stubSystemDark(false)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('默认跟随系统深色偏好', () => {
    stubSystemDark(true)
    expect(systemTheme()).toBe('dark')
    expect(initTheme()).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(getTheme()).toBe('dark')
  })

  it('系统为浅色时默认浅色', () => {
    expect(initTheme()).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('已有的用户选择优先于系统偏好', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light')
    stubSystemDark(true)
    expect(initTheme()).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('setTheme 切换 class 并写入 localStorage', () => {
    setTheme('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')

    setTheme('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
  })

  it('toggleTheme 在两种配色之间来回切换', () => {
    toggleTheme()
    expect(getTheme()).toBe('dark')
    toggleTheme()
    expect(getTheme()).toBe('light')
  })

  it('非法存储值不会污染主题', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'solarized')
    expect(initTheme()).toBe('light')
  })
})

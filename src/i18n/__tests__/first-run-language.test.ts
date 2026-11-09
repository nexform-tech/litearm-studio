import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 首屏语言：daemon 给的桌面语言 > navigator。
 *
 * jsdom 的 navigator 被钉成 en-US —— 正好模拟 Linux 上"桌面是中文、WebKitGTK 却报
 * en-US"的那台机器（`LANG=en_US.UTF-8` + `LANGUAGE=zh_CN:zh`）。于是每条用例都能
 * 一眼看出页面选了哪一边。
 *
 * ⚠ `src/i18n/index.ts` 在模块加载时就完成检测，所以这里必须 `vi.resetModules()` 后
 * 重新 import —— 直接改全局变量再读已经导入的实例是测不到首屏的。
 */
async function freshI18n() {
  vi.resetModules()
  return await import('../index')
}

beforeEach(() => {
  window.localStorage.clear()
  delete window.__LITEARM_UI_LANGUAGES__
  // jsdom 的默认值本来就是 en-US；显式钉住是为了让"退回 navigator"这条断言
  // 不依赖 jsdom 的版本。
  vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['en-US', 'en'])
  vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('en-US')
})

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
  delete window.__LITEARM_UI_LANGUAGES__
})

describe('first-run language detection', () => {
  it('takes the desktop language the daemon provides, not navigator', async () => {
    window.__LITEARM_UI_LANGUAGES__ = ['zh-CN', 'zh', 'en-US', 'en']

    const mod = await freshI18n()
    await mod.i18nReady

    expect(mod.default.language.startsWith('zh')).toBe(true)
    expect(mod.default.resolvedLanguage).toBe('zh')
    expect(mod.default.t('nav:control')).toBe('控制')
  })

  it('falls back to navigator when the daemon has nothing to say', async () => {
    const mod = await freshI18n()
    await mod.i18nReady

    expect(mod.default.language).toBe('en-US')
    expect(mod.default.resolvedLanguage).toBe('en')
    expect(mod.default.t('nav:control')).toBe('Control')
  })

  it('keeps the language the operator already chose', async () => {
    window.localStorage.setItem('litearm_language', 'en')
    window.__LITEARM_UI_LANGUAGES__ = ['zh-CN', 'zh']

    const mod = await freshI18n()
    await mod.i18nReady

    expect(mod.default.resolvedLanguage).toBe('en')
  })

  it('respects an English desktop as well', async () => {
    window.__LITEARM_UI_LANGUAGES__ = ['en-GB', 'en']

    const mod = await freshI18n()
    await mod.i18nReady

    expect(mod.default.resolvedLanguage).toBe('en')
  })
})

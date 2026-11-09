import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

import commonZh from './locales/zh/common.json'
import commonEn from './locales/en/common.json'
import navZh from './locales/zh/nav.json'
import navEn from './locales/en/nav.json'
import soloZh from './locales/zh/solo.json'
import soloEn from './locales/en/solo.json'
import settingsZh from './locales/zh/settings.json'
import settingsEn from './locales/en/settings.json'
import logsZh from './locales/zh/logs.json'
import logsEn from './locales/en/logs.json'
import gripperZh from './locales/zh/gripper.json'
import gripperEn from './locales/en/gripper.json'

declare global {
  interface Window {
    /** daemon 在 `/api/ui-language.js` 里写入的桌面语言列表；没有服务端时不存在。 */
    __LITEARM_UI_LANGUAGES__?: string[]
  }
}

// 桌面自己的语言列表 —— 由 daemon 的 `/api/ui-language.js` 在 i18n 初始化之前写到
// window 上，这里把它排在 navigator 前面。Linux 的 WebKitGTK 只从进程的 POSIX
// locale（`LANG`/`LC_ALL`）推 `navigator.language`，而中文桌面常见的
// `LANG=en_US.UTF-8` + `LANGUAGE=zh_CN:zh`（中文界面、英文终端）会让它报 `en-US`,
// 首屏就变成英文。列表怎么算见 daemon 的 `ui_language.py`。
const detector = new LanguageDetector()
detector.addDetector({
  name: 'liteArmSystem',
  lookup() {
    const languages = window.__LITEARM_UI_LANGUAGES__
    return Array.isArray(languages) && languages.length > 0 ? languages : undefined
  },
  // 系统语言不是操作员的选择；用户选中的语言仍由 `caches` 统一写入。
  cacheUserLanguage() {},
})

export const defaultNS = 'common'
export const resources = {
  zh: {
    common: commonZh,
    nav: navZh,
    solo: soloZh,
    settings: settingsZh,
    logs: logsZh,
    gripper: gripperZh,
  },
  en: {
    common: commonEn,
    nav: navEn,
    solo: soloEn,
    settings: settingsEn,
    logs: logsEn,
    gripper: gripperEn,
  },
} as const

/** init 的 promise —— 单测要等首屏检测落定，应用本身不需要等它。 */
export const i18nReady = i18n
  .use(detector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'zh',
    defaultNS,
    ns: ['common', 'nav', 'solo', 'settings', 'logs', 'gripper'],
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'liteArmSystem', 'navigator'],
      lookupLocalStorage: 'litearm_language',
      caches: ['localStorage'],
    },
  })

// 同步 document.documentElement.lang
if (typeof document !== 'undefined') {
  document.documentElement.lang = i18n.language.startsWith('en') ? 'en' : 'zh-CN'
  i18n.on('languageChanged', (lng) => {
    document.documentElement.lang = lng.startsWith('en') ? 'en' : 'zh-CN'
  })
}

export default i18n

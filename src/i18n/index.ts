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
import telemetryZh from './locales/zh/telemetry.json'
import telemetryEn from './locales/en/telemetry.json'
import gripperZh from './locales/zh/gripper.json'
import gripperEn from './locales/en/gripper.json'

export const defaultNS = 'common'
export const resources = {
  zh: {
    common: commonZh,
    nav: navZh,
    solo: soloZh,
    settings: settingsZh,
    telemetry: telemetryZh,
    gripper: gripperZh,
  },
  en: {
    common: commonEn,
    nav: navEn,
    solo: soloEn,
    settings: settingsEn,
    telemetry: telemetryEn,
    gripper: gripperEn,
  },
} as const

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'zh',
    defaultNS,
    ns: ['common', 'nav', 'solo', 'settings', 'telemetry', 'gripper'],
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
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

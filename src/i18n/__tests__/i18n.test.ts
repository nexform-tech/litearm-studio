import { describe, it, expect, beforeEach } from 'vitest'
import i18n from '../index'

describe('i18n Internationalization', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
  })

  it('initializes with Chinese (zh) by default', () => {
    expect(i18n.language.startsWith('zh')).toBe(true)
    expect(i18n.t('nav:control')).toBe('控制')
    expect(i18n.t('nav:controlTitle')).toBe('机械臂控制台')
    expect(i18n.t('nav:log')).toBe('遥测')
    expect(i18n.t('nav:logTitle')).toBe('遥测记录')
    expect(i18n.t('common:connected')).toBe('已连接')
    expect(i18n.t('common:enable')).toBe('使能')
    expect(i18n.t('solo:controlBar.clearFault')).toBe('清错')
    expect(i18n.t('settings:system.title')).toBe('控制器系统监控')
    expect(i18n.t('settings:system.cpuLoad')).toBe('CPU 负荷')
  })

  it('switches to English (en) and returns corresponding keys', async () => {
    await i18n.changeLanguage('en')
    expect(i18n.language).toBe('en')
    expect(i18n.t('nav:control')).toBe('Control')
    expect(i18n.t('nav:controlTitle')).toBe('Robot Arm Console')
    expect(i18n.t('nav:log')).toBe('Telemetry')
    expect(i18n.t('nav:logTitle')).toBe('Telemetry Records')
    expect(i18n.t('common:connected')).toBe('Connected')
    expect(i18n.t('common:enable')).toBe('Enable')
    expect(i18n.t('solo:controlBar.clearFault')).toBe('Clear Error')
    expect(i18n.t('settings:header.title')).toBe('System & Controller Settings')
    expect(i18n.t('settings:system.title')).toBe('Controller System Diagnostics')
    expect(i18n.t('settings:system.confirmRestart')).toBe('Confirm Restart')
  })

  it('updates document.documentElement.lang on language change', async () => {
    await i18n.changeLanguage('en')
    expect(document.documentElement.lang).toBe('en')
    await i18n.changeLanguage('zh')
    expect(document.documentElement.lang).toBe('zh-CN')
  })
})

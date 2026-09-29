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
    expect(i18n.t('nav:settings')).toBe('设置')
    expect(i18n.t('settings:payload.title')).toBe('末端负载')
    expect(i18n.t('settings:tabs.joints')).toBe('增益与限位')
    // 夹爪命名空间（§6.2）：导航、动作、闸门与新增的错误种类都要在两种语言里存在。
    expect(i18n.t('nav:gripper')).toBe('夹爪')
    expect(i18n.t('nav:gripperTitle')).toBe('LiteGrip 夹爪')
    expect(i18n.t('gripper:actions.open')).toBe('张开')
    expect(i18n.t('gripper:actions.resetStop')).toBe('复位急停')
    expect(i18n.t('gripper:source.template')).toBe('标称模板（从未实测）')
    expect(i18n.t('gripper:gate.TEMPLATE')).toBe('标称模板')
    expect(i18n.t('gripper:state.grasping')).toBe('夹持中')
    expect(i18n.t('gripper:zero.start')).toBe('开始标定')
    expect(i18n.t('gripper:settings.allowFactory')).toBe('允许出厂标定（已确认风险）')
    // 「未声明」是默认值：它必须自己解释自己，而不是让操作员猜（见 §6.2）。
    expect(i18n.t('gripper:settings.mountUndeclared')).toContain('零位标定')
    expect(i18n.t('common:errors.gripperCalibration')).toContain('标定')
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
    expect(i18n.t('nav:settingsTitle')).toBe('Controller Parameters')
    expect(i18n.t('settings:header.title')).toBe('Controller Parameters & Calibration')
    expect(i18n.t('settings:tabs.diagnostics')).toBe('Diagnostics')
    expect(i18n.t('settings:joints.factory')).toBe('Restore factory')
    expect(i18n.t('nav:gripper')).toBe('Gripper')
    expect(i18n.t('nav:gripperTitle')).toBe('LiteGrip Gripper')
    expect(i18n.t('gripper:actions.open')).toBe('Open')
    expect(i18n.t('gripper:actions.resetStop')).toBe('Reset stop')
    expect(i18n.t('gripper:source.template')).toBe('Nominal template (never measured)')
    expect(i18n.t('gripper:gate.BLOCKED')).toBe('Blocked')
    expect(i18n.t('gripper:state.grasping')).toBe('Grasping')
    expect(i18n.t('gripper:zero.start')).toBe('Start calibration')
    expect(i18n.t('gripper:settings.allowFactory')).toContain('factory')
    expect(i18n.t('gripper:settings.mountUndeclared')).toContain('zero calibration')
    expect(i18n.t('common:errors.gripperNotConnected')).toContain('not connected')
  })

  it('updates document.documentElement.lang on language change', async () => {
    await i18n.changeLanguage('en')
    expect(document.documentElement.lang).toBe('en')
    await i18n.changeLanguage('zh')
    expect(document.documentElement.lang).toBe('zh-CN')
  })
})

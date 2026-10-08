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
    // 「遥测」改成「日志」是刻意的: 页面记的不再只是采样, 还有事件与命令台账
    // (issue #79 第 1 点)。字符串是用户可见契约, 所以这条断言也要跟着改。
    expect(i18n.t('nav:log')).toBe('日志')
    expect(i18n.t('nav:logTitle')).toBe('日志')
    expect(i18n.t('logs:tabs.records')).toBe('日志记录')
    expect(i18n.t('logs:kind.command')).toBe('命令')
    expect(i18n.t('common:connected')).toBe('已连接')
    expect(i18n.t('common:enable')).toBe('使能')
    expect(i18n.t('solo:controlBar.reset')).toBe('复位')
    expect(i18n.t('solo:controlBar.clearFault')).toBe('清除故障')
    // 夹爪与机械臂的清障按钮说同一个词：各写一套的话，现场会看到两个名字指同一条
    // `clear_faults` 命令 —— 夹具面板还多一句「正在清除故障…」，更不该对不上。
    expect(i18n.t('gripper:actions.clearFault')).toBe(i18n.t('solo:controlBar.clearFault'))
    expect(i18n.t('solo:controlBar.home')).toBe('回零点')
    expect(i18n.t('solo:controlBar.disable')).toBe('失能')
    // 按钮叫什么，点名它的文案就得叫什么。这句报错指的是控制栏这颗按钮（激活写入要求先失能），
    // 而中文名曾经是「下使能」、全 app 其它地方都写「失能」—— 现场照着提示找不到那颗按钮。
    expect(i18n.t('common:errors.activationMustDisable')).toContain(i18n.t('solo:controlBar.disable'))
    expect(i18n.t('solo:modes.drag')).toBe('零重力')
    expect(i18n.t('nav:settings')).toBe('设置')
    expect(i18n.t('settings:payload.title')).toBe('末端负载')
    expect(i18n.t('settings:tabs.joints')).toBe('增益与限位')
    // 夹爪命名空间（§6.2）：导航、动作、闸门与新增的错误种类都要在两种语言里存在。
    expect(i18n.t('nav:gripper')).toBe('夹爪')
    expect(i18n.t('nav:gripperTitle')).toBe('LiteGrip 夹爪')
    expect(i18n.t('gripper:actions.open')).toBe('张开')
    expect(i18n.t('gripper:actions.resetStop')).toBe('解除急停')
    // 错误提示点名的那颗按钮必须真的叫这个名字：「复位急停」改名时漏掉引用，现场就会
    // 照着提示去找一颗不存在的按钮。机械臂的「复位」是控制器复位，两者不能再撞车。
    expect(i18n.t('common:errors.gripperEstopped')).toContain(i18n.t('gripper:actions.resetStop'))
    expect(i18n.t('gripper:source.template')).toBe('标称模板（从未实测）')
    expect(i18n.t('gripper:gate.TEMPLATE')).toBe('标称模板')
    expect(i18n.t('gripper:state.grasping')).toBe('夹持中')
    expect(i18n.t('gripper:zero.start')).toBe('开始标定')
    expect(i18n.t('gripper:settings.allowFactory')).toBe('允许出厂标定（已确认风险）')
    expect(i18n.t('common:errors.gripperCalibration')).toContain('标定')
    // 授权激活：未激活的机器一开机就会撞上的那条错误，以及它的入口。
    expect(i18n.t('settings:tabs.activation')).toBe('授权激活')
    expect(i18n.t('settings:activation.stateNotActivated')).toBe('未激活')
    expect(i18n.t('common:errors.notActivated')).toContain('未激活')
    // 注册与同意（激活那一半）：这套文案是给用户签字看的，两种语言都必须存在。
    expect(i18n.t('settings:activation.formTitle')).toContain('激活')
    expect(i18n.t('settings:activation.consentAgreeLabel')).toContain('同意')
    // 文档名点名的是"激活注册信息"（发送什么），不是"信息收集"。
    expect(i18n.t('settings:activation.consentTitle')).toBe('激活注册信息同意书')
    expect(i18n.t('settings:activation.consentItemVersions')).toContain('版本')
    expect(i18n.t('common:errors.activationUnreachable')).toContain('激活服务')
  })

  it('switches to English (en) and returns corresponding keys', async () => {
    await i18n.changeLanguage('en')
    expect(i18n.language).toBe('en')
    expect(i18n.t('nav:control')).toBe('Control')
    expect(i18n.t('nav:controlTitle')).toBe('Robot Arm Console')
    expect(i18n.t('nav:log')).toBe('Logs')
    expect(i18n.t('nav:logTitle')).toBe('Logs')
    expect(i18n.t('logs:tabs.records')).toBe('Log Records')
    expect(i18n.t('logs:kind.command')).toBe('Commands')
    expect(i18n.t('common:connected')).toBe('Connected')
    expect(i18n.t('common:enable')).toBe('Enable')
    expect(i18n.t('solo:controlBar.reset')).toBe('Reset')
    expect(i18n.t('solo:controlBar.clearFault')).toBe('Clear Fault')
    expect(i18n.t('gripper:actions.clearFault')).toBe(i18n.t('solo:controlBar.clearFault'))
    expect(i18n.t('solo:controlBar.home')).toBe('Go Home')
    expect(i18n.t('solo:controlBar.disable')).toBe('Disable')
    expect(i18n.t('common:errors.activationMustDisable')).toContain(i18n.t('solo:controlBar.disable'))
    expect(i18n.t('solo:modes.drag')).toBe('Zero Gravity')
    expect(i18n.t('nav:settingsTitle')).toBe('Controller Parameters')
    expect(i18n.t('settings:header.title')).toBe('Controller Parameters & Calibration')
    expect(i18n.t('settings:tabs.diagnostics')).toBe('Diagnostics')
    expect(i18n.t('settings:joints.factory')).toBe('Restore factory')
    expect(i18n.t('nav:gripper')).toBe('Gripper')
    expect(i18n.t('nav:gripperTitle')).toBe('LiteGrip Gripper')
    expect(i18n.t('gripper:actions.open')).toBe('Open')
    expect(i18n.t('gripper:actions.resetStop')).toBe('Release Stop')
    expect(i18n.t('common:errors.gripperEstopped')).toContain(i18n.t('gripper:actions.resetStop'))
    expect(i18n.t('gripper:source.template')).toBe('Nominal template (never measured)')
    expect(i18n.t('gripper:gate.BLOCKED')).toBe('Blocked')
    expect(i18n.t('gripper:state.grasping')).toBe('Grasping')
    expect(i18n.t('gripper:zero.start')).toBe('Start calibration')
    expect(i18n.t('gripper:settings.allowFactory')).toContain('factory')
    expect(i18n.t('common:errors.gripperNotConnected')).toContain('not connected')
    expect(i18n.t('settings:tabs.activation')).toBe('Activation')
    expect(i18n.t('settings:activation.stateNotActivated')).toBe('Not activated')
    expect(i18n.t('common:errors.notActivated')).toContain('not activated')
    expect(i18n.t('settings:activation.consentAgreeLabel')).toContain('agree')
    expect(i18n.t('settings:activation.consentTitle')).toBe('Activation Registration Consent')
    expect(i18n.t('common:errors.activationUnreachable')).toContain('activation service')
  })

  it('updates document.documentElement.lang on language change', async () => {
    await i18n.changeLanguage('en')
    expect(document.documentElement.lang).toBe('en')
    await i18n.changeLanguage('zh')
    expect(document.documentElement.lang).toBe('zh-CN')
  })
})

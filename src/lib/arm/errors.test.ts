import { describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { formatArmError } from './errors'

/** 构造 daemon 回传的 `err` 对象形状。 */
function daemonErr(kind: string, msg = '', extra: Record<string, unknown> = {}) {
  return { kind, msg, ...extra }
}

describe('formatArmError (daemon err.kind → i18n)', () => {
  it('translates daemon error kinds in Chinese (zh)', async () => {
    await i18n.changeLanguage('zh')

    expect(formatArmError(daemonErr('NotConnectedCommandError', '会话未连接'))).toBe(
      '机械臂未连接：请先在顶栏连接本地程序与机械臂',
    )
    expect(formatArmError(daemonErr('UnknownCommandError', '未知命令'))).toBe(
      '本地程序不支持该命令（不在命令白名单里）',
    )
    expect(formatArmError(daemonErr('MotionBusyError', '已有运动在途'))).toBe(
      '机械臂当前正处于运动中，请等待当前动作完成或急停后再试',
    )
    expect(formatArmError(daemonErr('CommandTimeoutError', '超过 60s'))).toBe(
      '指令执行超时：本地程序未在规定时间内返回响应，请检查机械臂状态',
    )
    expect(formatArmError(daemonErr('TransportError', '串口断开'))).toBe(
      '与机械臂的通信失败，请检查 USB 连接、设备供电与本地程序状态',
    )
    expect(formatArmError(daemonErr('FirmwareMismatchError', 'fw'))).toBe(
      '固件版本与本地程序不匹配，请升级控制器固件或本地程序',
    )
    expect(formatArmError(daemonErr('MotorFaultError', 'J3 过流'))).toBe(
      '电机故障：J3 过流，请检查供电或执行清除故障',
    )
    expect(formatArmError(daemonErr('CommandRejectedError', 'rejected', { cmd: 3, code: 9 }))).toBe(
      '控制器拒绝了该命令（错误码 9）',
    )
    expect(formatArmError(daemonErr('CommandRejectedError', 'rejected'))).toBe(
      '控制器拒绝了该命令',
    )
    expect(formatArmError(daemonErr('MotionTimeoutError', 'timeout'))).toBe(
      '运动超时：控制器未在预期时间内完成动作，请检查机械臂状态',
    )
    expect(formatArmError(daemonErr('BadMessage', '顶层需是 JSON 对象'))).toBe(
      '与本地程序的通信协议错误：顶层需是 JSON 对象',
    )
  })

  it('translates daemon error kinds in English (en)', async () => {
    await i18n.changeLanguage('en')

    expect(formatArmError(daemonErr('NotConnectedCommandError', 'x'))).toBe(
      'Robot arm not connected: connect the local daemon and the arm from the top bar first',
    )
    expect(formatArmError(daemonErr('MotionBusyError', 'x'))).toBe(
      'Robot arm is busy with another motion, please wait for completion or stop current motion',
    )
    expect(formatArmError(daemonErr('CommandRejectedError', 'x', { code: 9 }))).toBe(
      'The controller rejected the command（错误码 9）',
    )
    expect(formatArmError(daemonErr('BadMessage', 'bad json'))).toBe(
      'Protocol error talking to the local daemon: bad json',
    )

    await i18n.changeLanguage('zh')
  })

  it('names the remedy when the firmware refuses ENABLE because the arm is not activated', async () => {
    // ERR{0x10,0x08}: 固件 `ctrl_enable()` 的第一条判据就是"没激活"。这条错**必须**说清
    // 下一步 —— 只说"控制器拒绝了该命令（错误码 8）"等于没说，而它正是每台未激活的
    // 机器一开机就会撞上的那条。
    await i18n.changeLanguage('zh')
    const zh = formatArmError(daemonErr('CommandRejectedError', 'ERR [10,8]', { cmd: 16, code: 8 }))
    expect(zh).toContain('尚未激活')
    expect(zh).toContain('授权激活')
    expect(formatArmError(daemonErr('CommandRejectedError', 'ERR [10,8]', { cmd: 16, code: 8 }))).not.toContain('错误码 8')

    await i18n.changeLanguage('en')
    const en = formatArmError(daemonErr('CommandRejectedError', 'ERR [10,8]', { cmd: 16, code: 8 }))
    expect(en).toContain('not activated')
    expect(en).toContain('Activation')

    // ⚠ 同一个数字在别的命令下**不是**这个意思：不带命令码时不许套用这条文案。
    await i18n.changeLanguage('zh')
    expect(formatArmError(daemonErr('CommandRejectedError', 'rejected', { code: 8 }))).toBe(
      '控制器拒绝了该命令（错误码 8）',
    )
    expect(formatArmError(daemonErr('CommandRejectedError', 'rejected', { cmd: 63, code: 8 }))).toBe(
      '控制器拒绝了该命令（错误码 8）',
    )
  })

  it('names the remedy for the two ACTIVATE refusals', async () => {
    // ERR{0x3F,0x04}: 使能中。ERR{0x3F,0x02}: **聚合档** —— docs/ACTIVATION.md §7 明写
    // 不许把它说成"凭据错误"，所以这里除了断言文案有用，还要断言它**没有**替固件下结论。
    await i18n.changeLanguage('zh')
    const armed = formatArmError(daemonErr('CommandRejectedError', 'ERR [3F,4]', { cmd: 63, code: 4 }))
    expect(armed).toContain('失能')
    expect(armed).not.toContain('错误码 4')

    const rejected = formatArmError(daemonErr('CommandRejectedError', 'ERR [3F,2]', { cmd: 63, code: 2 }))
    expect(rejected).toContain('刷新')
    // 契约而非措辞：聚合档不能被断言成"这份凭据是假的"。四种成因共用一个码，
    // 断言其中一种就是把"没写进去"说成"凭据无效"。
    expect(rejected).not.toMatch(/凭据无效|凭据是假|不是本机签发的|凭据有误/)

    await i18n.changeLanguage('en')
    // 英文点名的是控制栏那颗按钮的名字（`solo:controlBar.disable` = "Disable"）：以前这里写
    // "Disarm"，而控制栏上并没有叫这个名字的按钮。
    expect(formatArmError(
      daemonErr('CommandRejectedError', 'ERR [3F,4]', { cmd: 63, code: 4 }))).toContain('Disable')

    // 同一个数字在别的命令下**不**套用这些文案。
    await i18n.changeLanguage('zh')
    expect(formatArmError(daemonErr('CommandRejectedError', 'rejected', { cmd: 16, code: 4 }))).toBe(
      '控制器拒绝了该命令（错误码 4）',
    )
  })

  it('unwraps the daemon info carried on a rejected command Error', async () => {
    await i18n.changeLanguage('zh')
    const err = Object.assign(new Error('已有运动在途'), { err: daemonErr('MotionBusyError', '已有运动在途') })
    expect(formatArmError(err)).toBe('机械臂当前正处于运动中，请等待当前动作完成或急停后再试')
  })

  it('passes through plain strings and Error messages', async () => {
    await i18n.changeLanguage('zh')
    expect(formatArmError('连接已断开')).toBe('连接已断开')
    expect(formatArmError(new Error('本地程序未连接'))).toBe('本地程序未连接')
  })

  it('handles empty input', () => {
    expect(formatArmError(null)).toBe('')
    expect(formatArmError(undefined)).toBe('')
    expect(formatArmError('')).toBe('')
  })
})

describe('formatArmError (activation reasons)', () => {
  it('explains activation failures by short code, never by the daemon wording', async () => {
    // ⚠ 本地程序写的 msg 是中文；英文界面上必须换一句话，所以判据只能是 `reason`。
    const err = (reason: string) =>
      daemonErr('ActivationError', '连不上激活服务: Name or service not known', { reason, method: 'activate' })

    await i18n.changeLanguage('zh')
    expect(formatArmError(err('unreachable'))).toContain('网络')
    expect(formatArmError(err('not_found'))).toContain('设备 UID')
    expect(formatArmError(err('consent_required'))).toContain('勾选')
    expect(formatArmError(err('unconfigured'))).toContain('--activation-url')

    await i18n.changeLanguage('en')
    const en = formatArmError(err('unreachable'))
    expect(en).toContain('network')
    // 中文那句**不许**被拼进英文句子（那是最容易漏的一种串台）。
    expect(en).not.toContain('连不上')

    await i18n.changeLanguage('zh')
  })

  it('separates an unreadable device record from an unsupported firmware', async () => {
    // ⚠ 两条都发生在**出网之前**（daemon 拿不到设备 UID 就不发注册信息），但让操作员
    //   做的事完全不同：查 USB 链路 vs 升级固件。合成一句"激活失败"等于没说。
    const err = (reason: string) =>
      daemonErr('ActivationError', '读不到设备授权记录', { reason, method: 'activate' })

    await i18n.changeLanguage('zh')
    expect(formatArmError(err('device_uid_unavailable'))).toContain('USB')
    expect(formatArmError(err('firmware_unsupported'))).toContain('升级固件')

    await i18n.changeLanguage('en')
    expect(formatArmError(err('device_uid_unavailable'))).toContain('USB link')
    expect(formatArmError(err('firmware_unsupported'))).toContain('1.8.0')

    await i18n.changeLanguage('zh')
  })

  it('names what to do with a bad licence file', async () => {
    await i18n.changeLanguage('zh')
    const file = (reason: string) => daemonErr('LicenseFileError', '凭据文件缺 mac 字段', { reason })
    expect(formatArmError(file('uid_mismatch'))).toContain('不是当前这台机器')
    expect(formatArmError(file('unsupported_format'))).toContain('升级上位机')
    // 缺字段/不是 JSON 归成"换一份文件"这一个动作。
    expect(formatArmError(file('missing_field'))).toContain('lic.json')
    expect(formatArmError(file('not_json'))).toContain('lic.json')

    await i18n.changeLanguage('en')
    expect(formatArmError(file('unsupported_format'))).toContain('upgrade')
    await i18n.changeLanguage('zh')
  })

  it('covers the server-side fallback codes instead of a bare "activation failed"', async () => {
    await i18n.changeLanguage('zh')
    const err = (reason: string) =>
      daemonErr('ActivationError', '激活服务返回 HTTP 400', { reason, method: 'activate' })
    // `server` 是 daemon 对"服务端回了没登记的 error code"的兜底。
    expect(formatArmError(err('server'))).toContain('激活服务出错')
    expect(formatArmError(err('code_required'))).toContain('订单号')
    expect(formatArmError(err('invalid_uid'))).toContain('UID')
    expect(formatArmError(err('bad_uid'))).toContain('UID')
    // ⚠ `invalid_request` 是**服务端说"这个请求本身不成立"**（体积 / JSON / 表单判据），
    //   它与 `server` 的下一步动作不同 ⇒ 不能落到同一句"服务出错了"。
    expect(formatArmError(err('invalid_request'))).toContain('注册信息')
    expect(formatArmError(err('invalid_request'))).not.toContain('激活服务出错')

    await i18n.changeLanguage('en')
    expect(formatArmError(err('server'))).toContain('activation service')
    expect(formatArmError(err('invalid_request'))).toContain('registration')
    // 中文那句不许被拼进英文句子。
    expect(formatArmError(err('invalid_uid'))).not.toContain('设备')
    await i18n.changeLanguage('zh')
  })

  it('falls back to the generic activation text for an unknown reason', async () => {
    await i18n.changeLanguage('zh')
    const text = formatArmError(daemonErr('ActivationError', '出错了', { reason: 'brand_new' }))
    // 认不出的短码不许静默变成空串 —— 那会让界面上什么都不显示。
    expect(text).not.toBe('')
    expect(text).toMatch(/激活|凭据/)
    await i18n.changeLanguage('zh')
  })
})

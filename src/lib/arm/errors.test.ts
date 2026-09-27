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

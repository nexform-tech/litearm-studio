import { describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { formatArmError } from './errors'

describe('formatArmError (i18n)', () => {
  it('translates errors in Chinese (zh)', async () => {
    await i18n.changeLanguage('zh')
    const raw = 'daemon 进程提前退出 (exit=1)'
    expect(formatArmError(raw)).toBe(
      '末端设备守护进程启动失败 (exit=1)：请检查控制器 CAN 接口状态（can0 是否 UP）或末端设备供电与连线',
    )

    expect(formatArmError('使能失败: [Errno 100] Network is down')).toBe(
      '控制器网络/CAN 接口未启动（Network is down），请检查控制器 can0 状态',
    )

    expect(formatArmError('FeedbackTimeoutError: 连接超时，未收到全部关节反馈: [1, 2]')).toBe(
      '机械臂通信异常：未收到全部关节反馈，请检查电机通信总线与供电',
    )

    expect(formatArmError('BusBusyError: CAN 总线存在活跃报文')).toBe(
      'CAN 总线繁忙，检测到活跃控制报文，请先退出其他控制进程',
    )

    expect(formatArmError('NotConnectedError: 未 connect()')).toBe(
      '机械臂未连接，请先连接机械臂',
    )

    expect(formatArmError('WebSocket connection to ws://... failed')).toBe(
      '无法连接到机械臂控制器，请检查网络连接、IP 端口与服务端运行状态',
    )

    expect(formatArmError('No valid reply received')).toBe(
      '控制器无响应（未收到有效应答）：请求超时或控制器后台未提供该功能接口，请检查 litearm-server 运行状态与版本',
    )

    expect(formatArmError('Error: RPC timeout')).toBe(
      '指令执行超时：机械臂控制器未在规定时间内返回响应，请检查机械臂状态',
    )

    expect(formatArmError('TypeError: this.arm.home is not a function')).toBe(
      '客户端内置 SDK 缺少该功能接口（is not a function），请更新客户端后重试',
    )

    expect(formatArmError("AttributeError: Unknown method: 'home' (not found in Arm or custom_handlers)")).toBe(
      '当前功能暂不支持或客户端版本不匹配，请检查控制器服务端与客户端版本',
    )

    expect(formatArmError('MotionCancelled: home 已取消')).toBe(
      '运动已被取消或中断',
    )

    expect(formatArmError('Another motion is active')).toBe(
      '机械臂当前正处于运动中，请等待当前动作完成或停止后再试',
    )

    expect(formatArmError('Self-collision detected along trajectory')).toBe(
      '路径规划检测到干涉或碰撞风险，已中止运动',
    )

    expect(formatArmError('Joint limit exceeded on J4')).toBe(
      '目标位置超出机械臂安全工作范围或关节软限位',
    )

    expect(formatArmError('FileNotFoundError: trajectories/traj1.json not found')).toBe(
      '指定的轨迹文件不存在或已被删除',
    )
  })

  it('translates errors in English (en)', async () => {
    await i18n.changeLanguage('en')
    const raw = 'daemon 进程提前退出 (exit=1)'
    expect(formatArmError(raw)).toBe(
      'End-effector device daemon failed to start (exit=1): please check controller CAN interface (can0 UP) and device power/cables',
    )

    expect(formatArmError('使能失败: [Errno 100] Network is down')).toBe(
      'Controller CAN network is down, please check controller can0 interface status',
    )

    expect(formatArmError('FeedbackTimeoutError: timeout')).toBe(
      'Arm communication error: missing joint feedback, please check motor bus and power supply',
    )

    expect(formatArmError('BusBusyError: active frames')).toBe(
      'CAN bus busy: active control frames detected, please terminate conflicting control processes',
    )

    expect(formatArmError('NotConnectedError: not connected')).toBe(
      'Robot arm not connected, please connect first',
    )

    expect(formatArmError('WebSocket connection failed')).toBe(
      'Failed to connect to robot controller, please verify network, IP/port and server status',
    )

    expect(formatArmError('No valid reply received')).toBe(
      'Controller not responding (no valid reply received): request timed out or method unsupported by backend service, please check litearm-server status and version',
    )

    expect(formatArmError('RPC timeout')).toBe(
      'Command execution timed out: controller did not return a response in time, please check robot status',
    )

    expect(formatArmError('this.arm.home is not a function')).toBe(
      'Client SDK is missing this method (is not a function), please update the client and retry',
    )

    expect(formatArmError("Unknown method: 'home'")).toBe(
      'Method unsupported or client SDK version mismatch, please check controller and client versions',
    )

    // Reset back to zh
    await i18n.changeLanguage('zh')
  })

  it('handles Error object and empty input', () => {
    expect(formatArmError(new Error('daemon 进程提前退出 (exit=2)'))).toContain('(exit=2)')
    expect(formatArmError(null)).toBe('')
    expect(formatArmError(undefined)).toBe('')
    expect(formatArmError('')).toBe('')
  })
})

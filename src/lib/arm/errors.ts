import i18n from '@/i18n'

/**
 * 机械臂与末端设备错误信息语义化转换工具。
 * 将底层驱动、Python 异常、子进程退出码等原始技术报错转换为操作员友好的多语言排查指引。
 */
export function formatArmError(err: unknown): string {
  if (err == null) return ''
  const raw = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err)
  const msg = raw.trim()
  if (!msg) return ''

  const t = (key: string, options?: Record<string, unknown>) => {
    if (i18n && typeof i18n.t === 'function') {
      return i18n.t(`common:errors.${key}`, options)
    }
    return ''
  }

  // 1. 无有效回复 / 节点未响应 (Zenoh No valid reply received)
  if (/No valid reply received/i.test(msg) || /query_error/i.test(msg)) {
    return t('noReply') || '控制器无响应（未收到有效应答）：请求超时或控制器后台未提供该功能接口，请检查 litearm-server 运行状态与版本'
  }

  // 2. RPC 执行超时
  if (/RPC\s*timeout/i.test(msg) || /bridge timeout/i.test(msg) || /timed\s*out/i.test(msg)) {
    return t('rpcTimeout') || '指令执行超时：机械臂控制器未在规定时间内返回响应，请检查机械臂状态'
  }

  // 3a. 客户端内置 SDK 缺方法：本地同步抛错，根本没发出网络请求，不是服务端/版本问题
  if (/is not a function/i.test(msg)) {
    return t('sdkMethodMissing') || '客户端内置 SDK 缺少该功能接口（is not a function），请更新客户端后重试'
  }

  // 3b. 服务端不提供该方法 / 版本不匹配
  if (/method not found/i.test(msg) || /unsupported method/i.test(msg) || /Unknown method/i.test(msg)) {
    return t('methodNotFound') || '当前功能暂不支持或客户端版本不匹配，请检查控制器服务端与客户端版本'
  }

  // 3c. 末端设备驱动未实现该方法 / 设备守护进程未注册（未挂载）
  if (/has no method/i.test(msg) || /not registered/i.test(msg)) {
    if (/not registered/i.test(msg)) {
      return t('deviceNotMounted') || '末端设备未挂载或守护进程未运行，请先在「设置 → 末端设备」中挂载'
    }
    return t('deviceMethodMissing') || '当前末端设备不支持该操作：控制器端设备驱动未实现该方法，请等待控制器服务端更新'
  }

  // 4. 运动取消
  if (/MotionCancelled/i.test(msg) || /motion.*cancell?ed/i.test(msg) || /已取消/i.test(msg)) {
    return t('motionCancelled') || '运动已被取消或中断'
  }

  // 5. 并发运动 / 忙
  if (/Another motion is active/i.test(msg) || /motion in progress/i.test(msg) || /运动中禁止/i.test(msg) || /并发指令/i.test(msg)) {
    return t('motionBusy') || '机械臂当前正处于运动中，请等待当前动作完成或停止后再试'
  }

  // 6. 末端守护进程提前退出 / 异常退出
  if (/daemon\s*进程提前退出/i.test(msg) || /daemon.*exit=/i.test(msg)) {
    const exitMatch = msg.match(/exit=(\d+)/i)
    const exitCode = exitMatch ? ` (exit=${exitMatch[1]})` : ''
    return t('daemonExit', { exitCode }) || `末端设备守护进程启动失败${exitCode}：请检查控制器 CAN 接口状态（can0 是否 UP）或末端设备供电与连线`
  }

  // 7. CAN / 网络不可用 (Errno 100)
  if (/Network is down/i.test(msg) || /Errno 100/i.test(msg)) {
    return t('networkDown') || '控制器网络/CAN 接口未启动（Network is down），请检查控制器 can0 状态'
  }

  // 8. 碰撞 / 自碰风险
  if (/collision/i.test(msg) || /自碰/i.test(msg) || /碰撞/i.test(msg)) {
    return t('collision') || '路径规划检测到干涉或碰撞风险，已中止运动'
  }

  // 9. 关节限位越界
  if (/joint.*limit.*exceed/i.test(msg) || /超出.*限位/i.test(msg) || /out of (?:range|reach)/i.test(msg) || /越限/i.test(msg)) {
    return t('limitExceeded') || '目标位置超出机械臂安全工作范围或关节软限位'
  }

  // 10. 文件 / 轨迹不存在
  if (/FileNotFound/i.test(msg) || /轨迹.*不存在/i.test(msg) || /文件.*不存在/i.test(msg) || /not found/i.test(msg)) {
    return t('fileNotFound') || '指定的轨迹文件不存在或已被删除'
  }

  // 11. 末端设备未找到 / 未配置
  if (/未提供.*类型的末端设备/i.test(msg) || /末端设备不存在/i.test(msg)) {
    return t('deviceUnavailable', { message: msg }) || `末端设备不可用：${msg}`
  }

  // 12. CAN 总线繁忙 / 残留控制进程
  if (/BusBusyError/i.test(msg) || /CAN\s*总线存在活跃报文/i.test(msg) || /残留控制进程/i.test(msg)) {
    return t('busBusy') || 'CAN 总线繁忙，检测到活跃控制报文，请先退出其他控制进程'
  }

  // 13. 关节反馈超时 / 通信缺失
  if (/FeedbackTimeoutError/i.test(msg) || /未收到全部关节反馈/i.test(msg) || /关节反馈缺失或超时/i.test(msg)) {
    return t('feedbackTimeout') || '机械臂通信异常：未收到全部关节反馈，请检查电机通信总线与供电'
  }

  // 14. 电机故障码 (MotorFaultError / ArmFault / 欠压/过流/过温)
  if (/MotorFaultError/i.test(msg) || /ArmFault/i.test(msg) || /motors still in fault/i.test(msg) || /电机故障/i.test(msg)) {
    const cleaned = msg.replace(/^.*?(?:MotorFaultError|ArmFault|motors still in fault):\s*/i, '')
    return t('motorFault', { message: cleaned }) || `电机故障：${cleaned}，请检查供电或执行清除错误`
  }

  // 15. 安全包络 / 越界保护
  if (/SafetyViolationError/i.test(msg) || /超出安全包络/i.test(msg) || /关节位置越界/i.test(msg) || /关节速度超限/i.test(msg)) {
    const cleaned = msg.replace(/^.*?SafetyViolationError:\s*/i, '')
    return t('safetyViolation', { message: cleaned }) || `触发安全保护：${cleaned}`
  }

  // 16. 看门狗接管
  if (/WatchdogError/i.test(msg) || /watchdog\s*已接管/i.test(msg)) {
    return t('watchdogTripped') || '控制周期超时（看门狗已接管），需重新发起运动'
  }

  // 17. 机械臂未连接 / 断开
  if (/NotConnectedError/i.test(msg) || /未\s*connect\(\)/i.test(msg) || /机械臂未连接/i.test(msg)) {
    return t('notConnected') || '机械臂未连接，请先连接机械臂'
  }

  // 18. 网络连接 / WebSocket 握手失败
  if (/WebSocket.*(?:failed|closed|error)/i.test(msg) || /Failed to fetch/i.test(msg) || /Connection refused/i.test(msg) || /ECONNREFUSED/i.test(msg)) {
    return t('connectionFailed') || '无法连接到机械臂控制器，请检查网络连接、IP 端口与服务端运行状态'
  }

  return msg
}

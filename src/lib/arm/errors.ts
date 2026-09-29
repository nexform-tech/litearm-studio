import i18n from '@/i18n'

/** daemon `res` 帧里 `err` 字段的形状（计划 3.1）。 */
export type DaemonErrorInfo = {
  kind?: string
  msg?: string
  method?: string
  cmd?: number
  code?: number
}

/** daemon 回传的 `err.kind` → i18n key（common:errors.*）。 */
const KIND_KEYS: Record<string, string> = {
  NotConnectedCommandError: 'notConnected',
  NotConnectedError: 'notConnected',
  UnknownCommandError: 'unknownCommand',
  MotionBusyError: 'motionBusy',
  CommandTimeoutError: 'commandTimeout',
  TransportError: 'transportError',
  FirmwareMismatchError: 'firmwareMismatch',
  MotorFaultError: 'motorFault',
  CommandRejectedError: 'commandRejected',
  MotionTimeoutError: 'motionTimeout',
  BadMessage: 'badMessage',
  // 夹爪 (§4.3)。daemon 的类名与这里的键一一对应。
  GripperNotConnectedError: 'gripperNotConnected',
  GripperLinkError: 'gripperLinkError',
  GripperFaultActiveError: 'gripperFaultActive',
  GripperCalibrationError: 'gripperCalibration',
  GripperEstoppedError: 'gripperEstopped',
  GripperBusyError: 'gripperBusy',
}

/**
 * 固件拒绝码 → i18n key（键是 `命令码:错误码`，**两个都要**）。
 *
 * 错误码是**逐命令定义**的，同一个数字在不同命令下意思完全不同 —— 只按 `code` 查表
 * 必然张冠李戴（`0x10` 的 `0x08` 是"未激活"，`0x3F` 的 `0x02` 是激活的聚合档）。
 *
 * ⚠ 这张表**只收"用户必须看到、且必须知道下一步做什么"的码**，不是错误码全集的镜像：
 * 全集的权威文本在 SDK 的 `errors.ERR_TEXT` 里（且它刻意不在包级公开面上），这里抄的是
 * 面向操作员的那一句。没登记的码照旧落到通用文案 + 原始码（见 `formatArmError`）。
 */
const REJECTED_KEYS: Record<string, string> = {
  // ERR{0x10,0x08} ENABLE：`ctrl_enable()` 的第一条判据就是"没激活"，重发无用、无旁路。
  '16:8': 'notActivated',
}

/** i18n 缺失时的内置中文兜底（不依赖 i18n 初始化）。 */
const FALLBACK_ZH: Record<string, string> = {
  notConnected: '机械臂未连接：请先连接本地程序，并在顶栏连接机械臂',
  unknownCommand: '本地程序不支持该命令（不在命令白名单里）',
  motionBusy: '机械臂当前正处于运动中，请等待当前动作完成或急停后再试',
  commandTimeout: '指令执行超时：本地程序未在规定时间内返回响应，请检查机械臂状态',
  transportError: '与机械臂的通信失败，请检查 USB 连接、设备供电与本地程序状态',
  firmwareMismatch: '固件版本与本地程序不匹配，请升级控制器固件或本地程序',
  motorFault: '电机故障：{{message}}，请检查供电或执行清除故障',
  commandRejected: '控制器拒绝了该命令{{code}}',
  motionTimeout: '运动超时：控制器未在预期时间内完成动作，请检查机械臂状态',
  badMessage: '与本地程序的通信协议错误：{{message}}',
  gripperNotConnected: '夹爪未连接：请先在夹爪页连接',
  gripperLinkError: '夹爪的 CAN 接口不可用：{{message}}',
  gripperFaultActive: '夹爪驱动报故障：{{message}}，请排除原因后清除故障',
  gripperCalibration: '夹爪标定不允许这个动作：{{message}}',
  gripperEstopped: '夹爪急停已锁存：请排除原因后按「复位急停」',
  gripperBusy: '夹爪正在执行另一项长操作（标定），请等它结束',
  notActivated:
    '这台机械臂尚未激活，固件拒绝使能。请到「设置 → 授权激活」复制设备 UID，向供应商换取授权凭据',
  unknownError: '操作失败：{{message}}',
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '')
}

function extractInfo(err: unknown): DaemonErrorInfo | null {
  if (!err || typeof err !== 'object') return null
  // ArmCommandError：错误对象挂在 `err` 字段上
  const direct = (err as { err?: unknown }).err
  if (direct && typeof direct === 'object') return direct as DaemonErrorInfo
  const maybeKind = (err as { kind?: unknown }).kind
  if (typeof maybeKind === 'string') return err as DaemonErrorInfo
  return null
}

/**
 * 把 daemon 回传的结构化错误（`err.kind` / `err.msg` / `err.code`）转换为
 * 操作员友好的多语言提示。传入普通 Error / 字符串时原样返回其消息。
 */
export function formatArmError(err: unknown): string {
  if (err == null) return ''
  const info = extractInfo(err)
  const rawMsg =
    info?.msg ??
    (typeof err === 'string' ? err : err instanceof Error ? err.message : String(err))
  const msg = (rawMsg ?? '').trim()

  const t = (key: string, options?: Record<string, unknown>) => {
    if (i18n && typeof i18n.t === 'function') {
      return i18n.t(`common:errors.${key}`, options)
    }
    return ''
  }

  const kind = info?.kind
  if (!msg && !kind) return ''
  // 固件拒绝码**优先于** `kind` 的通用文案：`kind` 只说"被拒了"，码才说清"为什么、
  // 下一步做什么"。没登记的码落到下面，照旧带原始码回（不静默折叠）。
  const key = REJECTED_KEYS[`${info?.cmd}:${info?.code}`] ?? (kind ? KIND_KEYS[kind] : undefined)
  if (key) {
    const vars: Record<string, string> = {
      message: msg,
      // CommandRejectedError：固件逐命令错误码（存在时带上）
      code: info?.code != null ? `（错误码 ${info.code}）` : '',
    }
    const translated = t(key, vars)
    // i18next 找不到 key 时会原样返回 key，据此回退到内置中文。
    if (translated && !translated.startsWith('common:errors.')) return translated
    return interpolate(FALLBACK_ZH[key] ?? FALLBACK_ZH.unknownError, vars)
  }

  if (msg) return msg
  const fallback = t('unknownError', { message: kind ?? '' }) || ''
  return fallback.startsWith('common:errors.') ? '' : fallback
}

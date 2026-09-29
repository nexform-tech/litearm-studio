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
  const key = kind ? KIND_KEYS[kind] : undefined
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

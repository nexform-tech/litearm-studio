import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import i18n from '@/i18n'
import { formatArmError } from './errors'
import { gripperClient } from './gripperClient'
import type { GripperAlert, GripperCalibProgress, GripperBusy, GripperConnInfo, GripperState } from './gripperClient'

/** 夹爪的连接态（`gripper_conn`，§4.1）。`present` 为 false 时本进程没有夹爪。 */
export function useGripperConnection(): {
  conn: GripperConnInfo | null
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  present: boolean
  busy: GripperBusy
  connect: (params?: Parameters<typeof gripperClient.connect>[0]) => void
  disconnect: () => void
} {
  const conn = useSyncExternalStore(gripperClient.subscribeConn, () => gripperClient.conn)
  const status = useSyncExternalStore(gripperClient.subscribeConn, () => gripperClient.status)
  const present = useSyncExternalStore(gripperClient.subscribeConn, () => gripperClient.present)
  const busy = useSyncExternalStore(gripperClient.subscribeBusy, () => gripperClient.busy)

  const connect = useCallback((params?: Parameters<typeof gripperClient.connect>[0]) => {
    void gripperClient.connect(params ?? {}).catch((err) => {
      toast.error(formatArmError(err) || String(err), { id: 'gripper-action-error' })
    })
  }, [])
  const disconnect = useCallback(() => {
    void gripperClient.disconnect().catch((err) => {
      toast.error(formatArmError(err) || String(err), { id: 'gripper-action-error' })
    })
  }, [])

  return { conn, status, present, busy, connect, disconnect }
}

/** 夹爪的实时状态（`gripper_state`）。`null` = 还没有状态帧。 */
export function useGripperState(): GripperState | null {
  return useSyncExternalStore(gripperClient.subscribeState, () => gripperClient.state)
}

/**
 * 本机的 CAN 接口列表（`gripper.list_channels`）—— 控制页的通道下拉用。
 *
 * ⚠ 只在 `present` 时问: 没有夹爪会话的进程 (Windows / `--no-gripper`) 回的是
 * `GripperNotConnectedError`, 那不是"这台机器没有 CAN 接口" —— 混起来会让界面把
 * "本进程没起夹爪"说成"你没有 CAN 接口"。
 *
 * ⚠ 枚举失败时保持空表, **不**报错: 通道下拉退回"配置里那个通道", 而那正是 daemon
 * 会用的那个 —— 连接本身照常可用。
 */
export function useGripperChannels(): { channels: string[]; reload: () => void } {
  const present = useSyncExternalStore(gripperClient.subscribeConn, () => gripperClient.present)
  const [channels, setChannels] = useState<string[]>([])
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!present) return
    let alive = true
    gripperClient.listChannels().then(
      (found) => {
        if (alive && Array.isArray(found)) setChannels(found)
      },
      () => {
        /* 见上面的说明: 枚举不出来不是连接的前提 */
      },
    )
    return () => {
      alive = false
    }
  }, [present, tick])

  const reload = useCallback(() => setTick((n) => n + 1), [])
  return { channels, reload }
}

/** 一次探测的进度（`gripper_calib`），没有探测时为 `null`。 */
export function useGripperCalibration(): GripperCalibProgress | null {
  return useSyncExternalStore(gripperClient.subscribeCalib, () => gripperClient.calib)
}

/**
 * 把异步的 `gripper_alert` 变成一条**稳定 id** 的 toast（§6.4）。
 *
 * tick 线程上的拒绝/故障没有 `res` 可以回，这条通道就是它们的出口；id 固定是为了
 * 不让连续几条把屏幕刷满 —— 操作员要看的是最新那一条。
 *
 * ⚠ 文字来自 daemon（诊断原文只有中文）。带 `kind` 的告警走与 `res` 同一张翻译表 ——
 * 否则英文界面上会突然冒出一句中文；没有 kind 的（推不出可翻译的类别）原样显示，
 * 因为把原文换成一句空泛的"操作失败"反而丢掉了唯一的线索。
 */
export function useGripperAlerts(): void {
  useEffect(() => {
    const onAlert = (alert: GripperAlert) => {
      const text = alert.kind
        ? formatArmError({ kind: alert.kind, msg: alert.text }) || alert.text
        : alert.text
      if (alert.level === 'error' || alert.level === 'fatal') {
        toast.error(text, { id: 'gripper-alert' })
      } else if (alert.level === 'warn') {
        toast.warning(text, { id: 'gripper-alert' })
      } else {
        toast.info(text, { id: 'gripper-alert' })
      }
    }
    return gripperClient.subscribeAlert(onAlert)
  }, [])
}

/** 夹爪命令的统一失败出口：一条稳定 id 的 toast，附带操作名。 */
export function gripperFail(op: string) {
  return (err: unknown) => {
    const message = formatArmError(err) || String(err)
    toast.error(i18n.t('gripper:page.opFailed', { op, message }), { id: 'gripper-action-error' })
  }
}

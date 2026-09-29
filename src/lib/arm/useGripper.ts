import { useCallback, useEffect, useSyncExternalStore } from 'react'
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
 * ⚠ 文字来自 daemon（夹爪侧的诊断目前只有中文）。同步拒绝走 `res` 的 `kind`，那条
 * 路是翻译过的；这条只兜住"tick 上发生的事"。
 */
export function useGripperAlerts(): void {
  useEffect(() => {
    const onAlert = (alert: GripperAlert) => {
      const text = alert.text
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

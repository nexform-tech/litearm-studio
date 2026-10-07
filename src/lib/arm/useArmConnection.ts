import { useCallback, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import i18n from '@/i18n'
import { armClient } from './client'
import { formatArmError } from './errors'

export function useArmConnection() {
  const status = useSyncExternalStore(armClient.subscribeStatus, () => armClient.status)
  // conn 与 status 同源于 daemon 的 conn 帧，共用 status 订阅通道。
  const conn = useSyncExternalStore(armClient.subscribeStatus, () => armClient.conn)
  const motionBusy = useSyncExternalStore(armClient.subscribeMotion, () => armClient.motionBusy)
  // ⚠ 被拒绝的 connect **不是**连接失败（`status` 不变），所以它要自己的快照：
  //   `lastError` 那种"渲染时现读"的读法在 status 不变时不会触发重渲染。
  const connectError = useSyncExternalStore(armClient.subscribeStatus, () => armClient.connectError)

  /** 连接。`port` = 顶栏下拉里选的那个串口（不传 = 交给 daemon 自己解析）。 */
  const connect = useCallback((port?: string) => armClient.connect(port), [])
  const disconnect = useCallback(() => armClient.disconnect(), [])

  // 急停失败必须让操作员看见。`client.requestStop()` 刻意不吞拒绝（见那里的注释），
  // 因为「按了 STOP 但 daemon 拒绝」是最不能静默的一条路径。
  const requestStop = useCallback(() => {
    void armClient.requestStop().catch((err) => {
      const message = formatArmError(err) || String(err)
      toast.error(i18n.t('common:errors.stopFailed', { message }), { id: 'estop-failed' })
    })
  }, [])

  return {
    status,
    conn,
    motionBusy,
    lastError: armClient.lastError,
    connectError,
    connect,
    disconnect,
    requestStop,
  }
}

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

  const connect = useCallback(() => armClient.connect(), [])
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
    connect,
    disconnect,
    requestStop,
  }
}

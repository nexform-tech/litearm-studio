import { useCallback, useSyncExternalStore } from 'react'
import { armClient } from './client'

export function useArmConnection() {
  const status = useSyncExternalStore(armClient.subscribeStatus, () => armClient.status)
  // conn 与 status 同源于 daemon 的 conn 帧，共用 status 订阅通道。
  const conn = useSyncExternalStore(armClient.subscribeStatus, () => armClient.conn)
  const motionBusy = useSyncExternalStore(armClient.subscribeMotion, () => armClient.motionBusy)

  const connect = useCallback(() => armClient.connect(), [])
  const disconnect = useCallback(() => armClient.disconnect(), [])
  const requestStop = useCallback(() => armClient.requestStop(), [])

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

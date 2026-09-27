import { useCallback, useSyncExternalStore } from 'react'
import { armClient } from './client'

export function useArmConnection() {
  const status = useSyncExternalStore(armClient.subscribeStatus, () => armClient.status)
  const motionBusy = useSyncExternalStore(armClient.subscribeMotion, () => armClient.motionBusy)

  const connect = useCallback((endpoint: string, token?: string) => armClient.connect(endpoint, token), [])
  const disconnect = useCallback(() => armClient.disconnect(), [])
  const requestStop = useCallback(() => armClient.requestStop(), [])

  return {
    status,
    motionBusy,
    endpoint: armClient.endpointValue,
    lastError: armClient.lastError,
    connect,
    disconnect,
    requestStop,
  }
}

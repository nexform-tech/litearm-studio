import { useSyncExternalStore } from 'react'
import { armClient } from './client'
import type { RobotState } from './client'

/** Live robot state (q/dq/tau/faults/temps/...), null while disconnected. */
export function useArmState(): RobotState | null {
  return useSyncExternalStore(armClient.subscribeState, () => armClient.state)
}

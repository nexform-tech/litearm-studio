import { useEffect, useState } from 'react'
import { GripperPanel } from './GripperPanel'
import { HandPanel } from './HandPanel'
import { armClient, useArmConnection } from '@/lib/arm'
import type { ActiveDeviceInfo } from 'litearm-js/browser'

const DEVICE_ID = 'end_0'
const POLL_DEVICE_INTERVAL_MS = 2000

export function EndEffectorControlPanel({ simMode = false }: { simMode?: boolean }) {
  const { status } = useArmConnection()
  const connected = status === 'connected'
  const [deviceCategory, setDeviceCategory] = useState<'gripper' | 'hand'>('gripper')

  useEffect(() => {
    if (!connected || simMode) {
      return
    }

    let cancelled = false

    const checkDevice = async () => {
      try {
        const active: ActiveDeviceInfo | null = await armClient.getActiveDevice(DEVICE_ID).catch(() => null)
        if (cancelled) return
        if (active?.configured && active?.category === 'hand') {
          setDeviceCategory('hand')
        } else {
          setDeviceCategory('gripper')
        }
      } catch {
        // 保持当前分类
      }
    }

    checkDevice()
    const timer = setInterval(checkDevice, POLL_DEVICE_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [connected, simMode])

  if (deviceCategory === 'hand') {
    return <HandPanel simMode={simMode} />
  }

  return <GripperPanel simMode={simMode} />
}

import { useCallback, useEffect, useState } from 'react'
import { armClient, formatArmError, useArmConnection, type LicenseSnapshot } from '@/lib/arm'

/**
 * 授权状态的读取 —— **只读**，不写任何东西。
 *
 * ⚠ 授权记录**不随状态帧推送**（它是请求/应答式的一次性记录，不是 100Hz 的状态流），
 * 所以这里按需拉一次：连上之后拉、用户点「刷新」时拉。读失败不抛给上层，落 `error`
 * 让面板显示原因（未激活是**状态**，不是错误 —— 那一种走 `snapshot`）。
 */
export function useActivation() {
  const { status } = useArmConnection()
  const connected = status === 'connected'

  const [snapshot, setSnapshot] = useState<LicenseSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!connected) return
    setLoading(true)
    try {
      setSnapshot(await armClient.license())
      setError(null)
    } catch (err) {
      setError(formatArmError(err) || String(err))
    } finally {
      setLoading(false)
    }
  }, [connected])

  useEffect(() => {
    if (connected) {
      void refresh()
    } else {
      // 断开之后不留上一次会话的授权记录：那台机器已经不在这条链路上了。
      setSnapshot(null)
      setError(null)
    }
  }, [connected, refresh])

  return { connected, snapshot, loading, error, refresh }
}

export type ActivationState = ReturnType<typeof useActivation>

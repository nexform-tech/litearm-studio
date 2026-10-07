import { useCallback, useEffect, useState } from 'react'
import { armClient } from './client'
import { formatArmError } from './errors'

export type ArmPortsState = {
  /** 候选串口路径（daemon 把 STM32 CDC 排在最前）；还没取到或列不出来时为空。 */
  ports: string[]
  loading: boolean
  /** 列不出来时的原因（旧版 daemon 没有 `list_ports`、枚举本身失败）。 */
  error: string | null
  reload: () => void
}

/** 首次失败后的重试节奏 —— 启动时 WebSocket 还在开, 那一次拒绝不算"列不出来"。 */
const RETRY_DELAY_MS = 400
const MAX_ATTEMPTS = 5

/**
 * 顶栏端口下拉的数据源（`list_ports`）。
 *
 * 为什么不在 `useArmConnection` 里: 端口列表是**设备发现**, 与"臂连上没有"无关 ——
 * 恰恰在连不上的时候操作员最需要它 (换一个口再试)。daemon 侧这条命令也因此是
 * session-free 的。
 *
 * ⚠ 旧版 daemon 没有这条命令（回 `UnknownCommandError`）: 那时 `ports` 为空、`error`
 * 有值, 下拉只剩"自动发现"一项 —— 连接本身照常可用, 而不是整块界面报错。
 *
 * ⚠ 失败**不**清掉已经枚举到的口 (见失败分支的说明): 按「断开」之后 `listPorts` 就再也
 * 问不动 daemon 了, 而那正是要换口的时候。
 */
export function useArmPorts(): ArmPortsState {
  const [ports, setPorts] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempts = 0

    const attempt = () => {
      armClient.listPorts().then(
        (found) => {
          if (!alive) return
          setPorts(found)
          setError(null)
          setLoading(false)
        },
        (err: unknown) => {
          if (!alive) return
          // ⚠ 启动/重连这一拍 `sendCmd` 会当场拒绝 («本地程序未连接»), 过一会儿就好。
          //   把它显示成"列不出串口"会让操作员以为机器上没有设备 —— 那个结论是错的。
          if (attempts < MAX_ATTEMPTS) {
            attempts += 1
            timer = setTimeout(attempt, RETRY_DELAY_MS)
            return
          }
          // ⚠ **保留上一次成功枚举的结果, 不清空**: 按「断开」会关掉那条共用 WebSocket
          //   (`ArmClient.disconnect`), 之后每次 `listPorts()` 都当场被拒 —— 而那恰恰是
          //   操作员要换口的时候。清空的话下拉只剩「自动发现」, 换口这条真实工作流就断了。
          //   重开 socket 不行: `ArmClient` 的 `onOpen` 会自动补一条 `connect`, 那会把
          //   操作员刚断开的臂又连回去。所以只记失败原因, 让上一次的列表留在原地。
          setError(formatArmError(err) || String(err))
          setLoading(false)
        },
      )
    }

    attempt()
    return () => {
      alive = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [tick])

  const reload = useCallback(() => setTick((n) => n + 1), [])
  return { ports, loading, error, reload }
}

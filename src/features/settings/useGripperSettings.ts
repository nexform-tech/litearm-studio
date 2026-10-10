import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { formatArmError } from '@/lib/arm/errors'
import { gripperClient } from '@/lib/arm/gripperClient'
import { useGripperAlerts, useGripperCalibration, useGripperConnection, useGripperState } from '@/lib/arm/useGripper'
import { pickFileThroughDaemon } from '@/lib/pickFile'

/** daemon 侧 `STROKE_MIN_MM` / `STROKE_MAX_MM`：行程的合理带。 */
export const TRAVEL_MIN_MM = 10
export const TRAVEL_MAX_MM = 300

/** 所输路径的**上级目录** —— "浏览…"的原生对话框从哪开始; 取不到就让本地程序落回家目录。 */
function dirOf(path: string): string | undefined {
  const trimmed = path.trim()
  const cut = trimmed.lastIndexOf('/')
  return cut <= 0 ? undefined : trimmed.slice(0, cut)
}

export type GripperSettingsVm = ReturnType<typeof useGripperSettings>

/**
 * 设置页里夹爪那一段的视图模型（§6.2）。
 *
 * 这里做的是**配置**：通道、CAN ID、用哪份标定、导入标定、零位写入与行程。
 * 装配方向固定为正装，不在设置页选。操作夹爪本身在夹爪页 —— 两处共用同一个
 * `gripperClient`。
 */
export function useGripperSettings() {
  const { t } = useTranslation(['common', 'gripper'])
  const { conn, status, present, connect, disconnect } = useGripperConnection()
  const state = useGripperState()
  const calib = useGripperCalibration()
  useGripperAlerts()

  const [channel, setChannel] = useState('')
  const [canId, setCanId] = useState(8)
  const [mstId, setMstId] = useState<number | null>(null)
  // 装配方向固定为正装：参考硬件就是正装，设置页不再让操作员选。
  const mount = 'normal' as const
  const [travel, setTravel] = useState(85)
  const [importPath, setImportPath] = useState('')
  const [channels, setChannels] = useState<string[]>([])
  const [scanning, setScanning] = useState(false)
  const [applying, setApplying] = useState(false)

  const connected = status === 'connected'
  const enabled = state?.enabled === true
  const probing = calib != null && calib.phase !== 'done' && calib.phase !== 'failed'

  // 读回：表单跟着**设备报告的**记录走，而不是跟着我们刚才输入的东西（§6.3）。
  // ⚠ 依赖是那几个**值**，不是 `conn` 对象：`gripper_conn` 每次推送都是新对象
  // （闸门一变就推一条），挂在对象上会把操作员正在改的输入框冲掉。
  const connChannel = conn?.channel
  const connCanId = conn?.canId
  const connTravel = conn?.travelMm
  useEffect(() => {
    if (connChannel == null || connCanId == null) return
    setChannel((prev) => (prev === '' ? connChannel : prev))
    setCanId(connCanId)
    setTravel(connTravel && connTravel > 0 ? connTravel : 85)
  }, [connChannel, connCanId, connTravel])

  /** 枚举本机 CAN 接口：内核的问题，不需要连接。 */
  const refresh = useCallback(async () => {
    setScanning(true)
    try {
      const found = await gripperClient.listChannels().catch(() => [] as string[])
      setChannels(found)
      // ⚠ 只在**还没有选择**时用枚举结果填上默认值，而且是函数式更新：
      // 用闭包里的 `channel` 判断会把操作员在这次扫描返回之前选好的通道冲掉
      // （实测：选中 can1 之后被一次迟到的扫描改回 can0）。
      setChannel((prev) => (prev === '' && found.length ? found[0] : prev))
    } catch (err) {
      toast.error(formatArmError(err) || String(err), { id: 'gripper-settings-error' })
    } finally {
      setScanning(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    // 挂载时扫一次；此后在应用配置、载入模板、导入标定、写零位之后各刷新一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fail = useCallback(
    (op: string) => (err: unknown) => {
      const message = formatArmError(err) || String(err)
      toast.error(t('gripper:page.opFailed', { op, message }), { id: 'gripper-settings-error' })
    },
    [t],
  )

  /** 应用通道/ID：先断开（改这些必须断开），再用新记录连上。装配方向固定正装。 */
  const apply = useCallback(async () => {
    setApplying(true)
    try {
      if (connected) {
        await gripperClient.disconnect()
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      await gripperClient.connect({
        channel: channel || undefined,
        canId,
        mstId: mstId ?? undefined,
        mount,
      })
      toast.success(t('gripper:settings.applied'), { id: 'gripper-settings-error' })
      await refresh()
    } catch (err) {
      fail(t('gripper:settings.apply'))(err)
    } finally {
      setApplying(false)
    }
  }, [connected, channel, canId, mstId, mount, refresh, t, fail])

  /**
   * "浏览…" —— 请本地程序弹**原生打开对话框**选一份控制机上的标定, 把它填进输入框。
   *
   * 与导出 (`lib/export.ts`) 同一条路: 页面铺不开一个稳当的目录浏览器, 由持有窗口的
   * 这一侧去问。取消**什么都不做** (操作员已经说了不要); 没有本地程序可弹对话框时如实告知。
   */
  const pickCalibration = useCallback(async () => {
    const outcome = await pickFileThroughDaemon(dirOf(importPath))
    if (outcome.kind === 'picked') {
      setImportPath(outcome.path)
    } else if (outcome.kind === 'unavailable') {
      toast.error(t('gripper:settings.browseUnavailable'), { id: 'gripper-settings-error' })
    }
  }, [importPath, t])

  const importCalibration = useCallback(async () => {
    const path = importPath.trim()
    if (!path) return
    try {
      await gripperClient.importCalibration(path)
      setImportPath('')
      await refresh()
    } catch (err) {
      fail(t('gripper:settings.import'))(err)
    }
  }, [importPath, fail, refresh, t])

  const setAllowFactory = useCallback(
    async (allow: boolean) => {
      try {
        await gripperClient.setAllowFactory(allow)
      } catch (err) {
        fail(t('gripper:settings.allowFactory'))(err)
      }
    },
    [fail, t],
  )

  const writeZero = useCallback(async () => {
    try {
      const result = await gripperClient.writeZero()
      toast.success(
        t('gripper:writeZero.done', {
          before: result.beforeRad.toFixed(4),
          after: result.afterRad.toFixed(4),
        }),
        { id: 'gripper-settings-error', duration: 8000 },
      )
      await refresh()
    } catch (err) {
      fail(t('gripper:writeZero.title'))(err)
    }
  }, [fail, refresh, t])

  return {
    present,
    connected,
    status,
    conn,
    state,
    enabled,
    probing,
    calib,
    // 表单
    channel,
    setChannel,
    channels,
    canId,
    setCanId,
    mstId,
    setMstId,
    mount,
    travel,
    setTravel,
    importPath,
    setImportPath,
    scanning,
    applying,
    // 动作
    refresh,
    apply,
    pickCalibration,
    importCalibration,
    setAllowFactory,
    writeZero,
    connect,
    disconnect,
  }
}

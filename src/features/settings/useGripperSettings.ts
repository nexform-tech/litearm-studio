import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { formatArmError } from '@/lib/arm/errors'
import { gripperClient } from '@/lib/arm/gripperClient'
import type { CalibrationCandidate } from '@/lib/arm/gripperClient'
import { useGripperAlerts, useGripperCalibration, useGripperConnection, useGripperState } from '@/lib/arm/useGripper'

/** daemon 侧 `STROKE_MIN_MM` / `STROKE_MAX_MM`：行程的合理带。 */
export const TRAVEL_MIN_MM = 10
export const TRAVEL_MAX_MM = 300

export type GripperSettingsVm = ReturnType<typeof useGripperSettings>

/**
 * 设置页里夹爪那一段的视图模型（§6.2）。
 *
 * 这里做的是**配置**：通道、CAN ID、装配方向、用哪份标定、导入标定、运行零位标定与
 * 实测行程。操作夹爪本身在夹爪页 —— 两处共用同一个 `gripperClient`。
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
  // 装配方向没有"未声明"：正装是默认，也是参考硬件的装配方式。
  const [mount, setMount] = useState<'normal' | 'reverse'>('normal')
  const [travel, setTravel] = useState(85)
  const [importPath, setImportPath] = useState('')
  const [channels, setChannels] = useState<string[]>([])
  const [calibrations, setCalibrations] = useState<CalibrationCandidate[]>([])
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
  const connMount = conn?.declaredMount
  const connTravel = conn?.travelMm
  useEffect(() => {
    if (connChannel == null || connCanId == null) return
    setChannel((prev) => (prev === '' ? connChannel : prev))
    setCanId(connCanId)
    // 没有会话（`conn` 为 null）时不动它：默认就是正装。
    if (connMount != null) setMount(connMount)
    setTravel(connTravel && connTravel > 0 ? connTravel : 85)
  }, [connChannel, connCanId, connMount, connTravel])

  /** 枚举 + 扫描标定：都是文件系统/内核的问题，不需要连接。 */
  const refresh = useCallback(async () => {
    setScanning(true)
    try {
      const [found, candidates] = await Promise.all([
        gripperClient.listChannels().catch(() => [] as string[]),
        gripperClient.listCalibrations(),
      ])
      setChannels(found)
      setCalibrations(candidates)
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
    // 只扫一次：之后由操作员按「重新扫描」触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fail = useCallback(
    (op: string) => (err: unknown) => {
      const message = formatArmError(err) || String(err)
      toast.error(t('gripper:page.opFailed', { op, message }), { id: 'gripper-settings-error' })
    },
    [t],
  )

  /** 应用通道/ID/方向：先断开（改这些必须断开），再用新记录连上。 */
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

  const useTemplate = useCallback(
    async (name: 'normal' | 'reverse') => {
      try {
        const result = await gripperClient.loadTemplate(name)
        setMount(result.mount === 'reverse' ? 'reverse' : 'normal')
        await refresh()
      } catch (err) {
        fail(t('gripper:settings.mount'))(err)
      }
    },
    [fail, refresh, t],
  )

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

  const zero = useCallback(async () => {
    if (!(travel > 0)) {
      toast.error(t('gripper:settings.noTravel'), { id: 'gripper-settings-error' })
      return
    }
    try {
      const result = await gripperClient.zero(travel)
      toast.success(
        t('gripper:zero.done', {
          closed: result.closedRad.toFixed(4),
          open: result.openRad.toFixed(4),
          scale: result.radToMm.toFixed(1),
        }),
        { id: 'gripper-settings-error', duration: 8000 },
      )
      await refresh()
    } catch (err) {
      fail(t('gripper:zero.title'))(err)
    }
  }, [travel, fail, refresh, t])

  /** 生效中的那一份：按路径/模板名匹配扫描结果。 */
  const activePath = useMemo(() => {
    if (!conn?.path) return null
    return conn.path
  }, [conn?.path])

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
    setMount,
    travel,
    setTravel,
    importPath,
    setImportPath,
    calibrations,
    activePath,
    scanning,
    applying,
    // 动作
    refresh,
    apply,
    useTemplate,
    importCalibration,
    setAllowFactory,
    zero,
    connect,
    disconnect,
  }
}

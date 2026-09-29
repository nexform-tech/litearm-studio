import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useGripperAlerts, useGripperCalibration, useGripperConnection, useGripperState } from '@/lib/arm/useGripper'
import { gripperClient } from '@/lib/arm/gripperClient'
import type { GripperState } from '@/lib/arm/gripperClient'
import { formatArmError } from '@/lib/arm/errors'

/** 速度/夹持力滑条的量程与默认值 —— 与 daemon 的 `gripper/constants.py` 一致。 */
export const SPEED_MIN_MM_S = 5
export const SPEED_MAX_MM_S = 150
export const SPEED_DEFAULT_MM_S = 50
/** ⚠ 40 N 是机械上限，但推荐工作力是 20 N（§6.4）。 */
export const FORCE_MAX_N = 40
export const FORCE_DEFAULT_N = 20

const SPEED_STORAGE_KEY = 'litearm.gripper.speedMmS'
const FORCE_STORAGE_KEY = 'litearm.gripper.forceN'

function readStored(key: string, fallback: number, min: number, max: number): number {
  const raw = window.localStorage.getItem(key)
  const parsed = raw == null || raw === '' ? NaN : Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

export type GripperPanelVm = ReturnType<typeof useGripperPanel>

/**
 * 控制页夹爪组件的视图模型：一处决定"什么可以按、为什么不可以按"，组件只负责画。
 *
 * 读回纪律（§6.3）：写下去之后显示的是**设备报告的**值 —— 速度/夹持力用
 * `set_motion` 的答复（daemon 已经算过钳幅），位置用状态帧，滑条在拖动期间不回灌。
 *
 * 配置（通道/ID/装配方向/标定文件/行程）不在这里，在 `useGripperSettings`。
 */
export function useGripperPanel() {
  const { t } = useTranslation(['common', 'gripper'])
  const { conn, status, present, busy, connect, disconnect } = useGripperConnection()
  const state = useGripperState()
  const calib = useGripperCalibration()
  useGripperAlerts()

  const [speedMmS, setSpeedMmS] = useState(() =>
    readStored(SPEED_STORAGE_KEY, SPEED_DEFAULT_MM_S, SPEED_MIN_MM_S, SPEED_MAX_MM_S),
  )
  const [forceN, setForceN] = useState(() =>
    readStored(FORCE_STORAGE_KEY, FORCE_DEFAULT_N, 0, FORCE_MAX_N),
  )
  const [aperture, setAperture] = useState(0)
  // 拖动是**指针**状态，不是值状态：Radix 在键盘步进时先发 onValueCommit 再发
  // onValueChange，从值变化去推断拖动会把它永远打开，滑块从此不再跟设备对表。
  const [dragging, setDragging] = useState(false)

  const connected = status === 'connected'
  const enabled = state?.enabled === true
  const estopped = state?.state === 'stopped'
  const gate = state?.gate ?? conn?.gate ?? null
  const travelMm = conn?.travelMm && conn.travelMm > 0 ? conn.travelMm : 85
  const mountMismatch =
    conn?.declaredMount != null && conn.mount != null && conn.declaredMount !== conn.mount

  // ── 拖动期间不回声：手指还在滑条上时，设备的位置不该把滑块拽回去（§6.3）。
  //
  // `dragging` 必须在依赖里：只在 `positionMm` **变化**时回灌会漏掉松手那一刻 ——
  // 操作员拖到 42、设备一直报 41.2，松手后 positionMm 没变，effect 不重跑，滑块就停在
  // 42，而设备根本还没走到那儿。带上 dragging，松手会再对一次表，下一帧到达时也一样。
  useEffect(() => {
    if (dragging) return
    if (state?.positionMm == null) return
    setAperture(Math.min(Math.max(state.positionMm, 0), travelMm))
  }, [state?.positionMm, travelMm, dragging])

  useEffect(() => {
    window.localStorage.setItem(SPEED_STORAGE_KEY, String(speedMmS))
  }, [speedMmS])
  useEffect(() => {
    window.localStorage.setItem(FORCE_STORAGE_KEY, String(forceN))
  }, [forceN])

  const fail = useCallback(
    (op: string) => (err: unknown) => {
      const message = formatArmError(err) || String(err)
      toast.error(t('gripper:page.opFailed', { op, message }), { id: 'gripper-action-error' })
    },
    [t],
  )

  /** 闸门是否允许某一类命令；模板只放行方向类动作（§5.3）。 */
  const gateAllows = useCallback(
    (geometry: boolean) => gate === 'READY' || (gate === 'TEMPLATE' && !geometry),
    [gate],
  )

  const canControl = connected && enabled && !estopped && gateAllows(true)
  const canDirection = connected && enabled && !estopped && gateAllows(false)

  /** 为什么按钮是灰的 —— 组件必须**说出原因**，而不是只灰掉（§6.3）。 */
  const disabledReason = useMemo(() => {
    if (!present) return t('gripper:connection.noSession')
    if (!connected) return t('common:disconnected')
    if (estopped) return t('common:errors.gripperEstopped')
    if (!enabled) return t('common:errors.notEnabled')
    if (gate && gate !== 'READY') {
      // 模板也要说：它只挡毫米目标，但操作员必须知道为什么「夹取」是灰的（§6.3）。
      return `${t(`gripper:gate.${gate}`)}：${state?.gateReason || conn?.gateReason || ''}`
    }
    return ''
  }, [present, connected, estopped, enabled, gate, state?.gateReason, conn?.gateReason, t])

  const run = useCallback(
    (op: string, fn: () => Promise<unknown>) => {
      void fn()
        .then(() => toast.dismiss('gripper-action-error'))
        .catch(fail(op))
    },
    [fail],
  )

  // ── 写下去（读回由 daemon 推的状态帧负责） ──
  const open = useCallback(() => run(t('gripper:actions.open'), () => gripperClient.open()), [run, t])
  const close = useCallback(() => run(t('gripper:actions.close'), () => gripperClient.close()), [run, t])
  const grasp = useCallback(
    () => run(t('gripper:actions.grasp'), () => gripperClient.grasp({ forceN })),
    [run, t, forceN],
  )
  const release = useCallback(
    () => run(t('gripper:actions.release'), () => gripperClient.release()),
    [run, t],
  )
  const stop = useCallback(() => run(t('gripper:actions.stop'), () => gripperClient.stop()), [run, t])
  const resetStop = useCallback(
    () => run(t('gripper:actions.resetStop'), () => gripperClient.resetStop()),
    [run, t],
  )
  const clearFault = useCallback(
    () => run(t('gripper:actions.clearFault'), () => gripperClient.clearFault()),
    [run, t],
  )

  const commitAperture = useCallback(
    (targetMm: number) => {
      if (!canControl) return
      run(t('gripper:aperture.title'), () => gripperClient.moveTo(targetMm, speedMmS))
    },
    [canControl, run, t, speedMmS],
  )

  const commitSpeed = useCallback(
    (value: number) => {
      setSpeedMmS(value)
      if (!connected) return
      void gripperClient
        .setMotion({ speedMmS: value })
        .then((effective) => {
          // 读回：设备真正生效的是它回的这两个数，不是我们发出去的那个。
          setSpeedMmS(effective.speedMmS)
        })
        .catch(fail(t('gripper:params.moveSpeed')))
    },
    [connected, fail, t],
  )

  const commitForce = useCallback(
    (value: number) => {
      setForceN(value)
      if (!connected) return
      void gripperClient
        .setMotion({ forceN: value })
        .then((effective) => setForceN(effective.forceN))
        .catch(fail(t('gripper:params.targetForce')))
    },
    [connected, fail, t],
  )

  const enable = useCallback(
    () => run(t('gripper:actions.enable'), () => gripperClient.enable()),
    [run, t],
  )
  const disable = useCallback(
    () => run(t('gripper:actions.disable'), () => gripperClient.disable()),
    [run, t],
  )

  const stateLabel = useMemo(() => {
    const key = state?.state
    if (!key) return t('gripper:readout.unknown')
    const known = ['ready', 'moving', 'grasping', 'holding', 'fault', 'disabled', 'stopped']
    return known.includes(key) ? t(`gripper:state.${key}`) : key
  }, [state?.state, t])

  return {
    // 连接
    present,
    status,
    connected,
    conn,
    busy,
    connect,
    disconnect,
    // 状态
    state: state as GripperState | null,
    stateLabel,
    gate,
    gateAllows,
    canControl,
    canDirection,
    disabledReason,
    enabled,
    estopped,
    travelMm,
    mountMismatch,
    calib,
    // 参数
    speedMmS,
    forceN,
    setSpeedMmS,
    setForceN,
    commitSpeed,
    commitForce,
    aperture,
    setAperture,
    commitAperture,
    setDragging,
    // 动作
    open,
    close,
    grasp,
    release,
    stop,
    resetStop,
    clearFault,
    enable,
    disable,
    fail,
  }
}

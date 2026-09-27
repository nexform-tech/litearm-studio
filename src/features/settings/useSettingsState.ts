import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { armClient, formatArmError, useArmConnection, type JointParams } from '@/lib/arm'

/** 生效的末端载荷（固件钳幅后的**读回值**，不是下发值）。 */
export type Payload = { mass: number; com: [number, number, number] }

/** 前馈：逐轴重力/惯量系数 + 重力方向向量。 */
export type FeedForward = {
  gravityScale: number[]
  inertiaScale: number[]
  gravityVector: [number, number, number]
}

export type KinBench = {
  ok?: boolean
  [key: string]: unknown
}

const FEED_FORWARD_JOINTS = 7

function normalizeFeedForward(values: number[] | null | undefined, fallback = 1): number[] {
  return Array.from({ length: FEED_FORWARD_JOINTS }, (_, i) => {
    const n = Number(values?.[i])
    return Number.isFinite(n) ? n : fallback
  })
}

/**
 * 设置页的状态 —— 只封装**固件真的有的**命令（计划 §5「有对应, 直接接线」）。
 *
 * ⚠ 写→读回是刚需, 不是保险: 固件对载荷质量/质心是**静默钳幅**（质量夹到 0、
 * 质心夹到 ±1），不回读就不知道真正生效的是什么。所以每个 writer 之后都重新
 * `read*()` 并把读回值渲染出来。
 */
export function useSettingsState() {
  const { t } = useTranslation(['common', 'settings'])
  const { status } = useArmConnection()
  const connected = status === 'connected'

  const [payload, setPayload] = useState<Payload>({ mass: 0, com: [0, 0, 0] })
  const [feedForward, setFeedForward] = useState<FeedForward>({
    gravityScale: normalizeFeedForward(null),
    inertiaScale: normalizeFeedForward(null),
    gravityVector: [0, 0, 0],
  })
  const [joints, setJoints] = useState<JointParams[]>([])
  const [kinBench, setKinBench] = useState<KinBench | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const showAlert = useCallback((type: 'success' | 'error' | 'info', text: string) => {
    if (type === 'success') toast.success(text)
    else if (type === 'error') toast.error(text)
    else toast.info(text)
  }, [])

  /** 一次把四类参数都读回来（它们各自是独立 RPC，串行会很慢）。 */
  const refresh = useCallback(async () => {
    if (!connected) return
    setLoading(true)
    try {
      const [p, gravityScale, inertiaScale, gravityVector, jointParams] = await Promise.all([
        armClient.readPayload(),
        armClient.readGravityScale(),
        armClient.readInertiaScale(),
        armClient.readGravityVector(),
        armClient.getJointParams(),
      ])
      setPayload(p)
      setFeedForward({
        gravityScale: normalizeFeedForward(gravityScale),
        inertiaScale: normalizeFeedForward(inertiaScale),
        gravityVector,
      })
      setJoints(jointParams)
    } catch (err) {
      showAlert('error', t('settings:toast.readFailed', { message: formatArmError(err) }))
    } finally {
      setLoading(false)
    }
  }, [connected, showAlert, t])

  useEffect(() => {
    if (connected) {
      void refresh()
    } else {
      // 未连接时不展示上一次会话的残留值。
      setJoints([])
      setKinBench(null)
    }
  }, [connected, refresh])

  /** 统一的「写 + 反馈」包装：失败必须可见，成功后由调用方补读回。 */
  const run = useCallback(
    async (successKey: string, fn: () => Promise<void>): Promise<boolean> => {
      if (!connected) {
        showAlert('error', t('common:errors.notConnected'))
        return false
      }
      setSaving(true)
      try {
        await fn()
        showAlert('success', t(`settings:toast.${successKey}`))
        return true
      } catch (err) {
        showAlert('error', t('settings:toast.writeFailed', { message: formatArmError(err) }))
        return false
      } finally {
        setSaving(false)
      }
    },
    [connected, showAlert, t],
  )

  const savePayload = useCallback(
    (mass: number, com: [number, number, number]) =>
      run('payloadSaved', async () => {
        await armClient.setPayload(mass, com)
        // 固件会钳幅 ⇒ 读回才是生效值（这也是面板显示的东西）。
        setPayload(await armClient.readPayload())
      }),
    [run],
  )

  const saveGravityScale = useCallback(
    (values: number[]) =>
      run('gravityScaleSaved', async () => {
        await armClient.setGravityScale(values)
        // 读回固件里的真值（下发值可能被钳幅/取整）。
        const readBack = await armClient.readGravityScale()
        setFeedForward((prev) => ({ ...prev, gravityScale: normalizeFeedForward(readBack) }))
      }),
    [run],
  )

  const saveInertiaScale = useCallback(
    (values: number[]) =>
      run('inertiaScaleSaved', async () => {
        await armClient.setInertiaScale(values)
        const readBack = await armClient.readInertiaScale()
        setFeedForward((prev) => ({ ...prev, inertiaScale: normalizeFeedForward(readBack) }))
      }),
    [run],
  )

  const saveGravityVector = useCallback(
    (g: [number, number, number]) =>
      run('gravityVectorSaved', async () => {
        await armClient.setGravityVector(g)
        const readBack = await armClient.readGravityVector()
        setFeedForward((prev) => ({ ...prev, gravityVector: readBack }))
      }),
    [run],
  )

  const saveJointParam = useCallback(
    (idx: number, kp: number, kd: number, tauMax: number) =>
      run('jointParamSaved', async () => {
        await armClient.setJointParam(idx, kp, kd, tauMax)
        setJoints(await armClient.getJointParams())
      }),
    [run],
  )

  const saveJointLimits = useCallback(
    (idx: number, qMin: number, qMax: number) =>
      run('jointLimitsSaved', async () => {
        await armClient.setJointLimits(idx, qMin, qMax)
        setJoints(await armClient.getJointParams())
      }),
    [run],
  )

  const saveParams = useCallback(
    () =>
      run('paramsPersisted', async () => {
        await armClient.saveParams()
      }),
    [run],
  )

  const resetFactoryParams = useCallback(
    () =>
      run('factoryReset', async () => {
        await armClient.resetFactoryParams()
        await refresh()
      }),
    [run, refresh],
  )

  const runSelfTest = useCallback(async () => {
    if (!connected) {
      showAlert('error', t('common:errors.notConnected'))
      return
    }
    setSaving(true)
    try {
      const result = await armClient.kinBench()
      setKinBench(typeof result === 'object' && result !== null ? (result as KinBench) : { value: result })
      showAlert('success', t('settings:toast.selfTestDone'))
    } catch (err) {
      showAlert('error', t('settings:toast.selfTestFailed', { message: formatArmError(err) }))
    } finally {
      setSaving(false)
    }
  }, [connected, showAlert, t])

  return {
    connected,
    /** 固件要求失能态才能擦写 flash —— 面板据此提示，但不代劳 `disable()`。 */
    canPersist: connected,
    loading,
    saving,
    showAlert,
    refresh,
    payload,
    savePayload,
    feedForward,
    saveGravityScale,
    saveInertiaScale,
    saveGravityVector,
    joints,
    saveJointParam,
    saveJointLimits,
    saveParams,
    resetFactoryParams,
    kinBench,
    runSelfTest,
  }
}

export type SettingsState = ReturnType<typeof useSettingsState>

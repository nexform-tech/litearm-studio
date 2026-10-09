import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { armClient, formatArmError, useArmConnection, useArmState, type JointParams } from '@/lib/arm'

/** 生效的末端载荷（固件钳幅后的**读回值**，不是下发值）。 */
export type Payload = { mass: number; com: [number, number, number] }

export type KinBench = {
  ok?: boolean
  [key: string]: unknown
}

/** 基座系重力向量 (m/s²)，固件前馈标量 item 6 的读回值。 */
export type GravityVector = [number, number, number]

/** 未读取时的占位值。`[0, 0, 0]` 不可能是真实的重力向量 (|g| 恒为 9.81)，见 `installationPose.ts`。 */
const NO_GRAVITY_VECTOR: GravityVector = [0, 0, 0]

/**
 * 设置页的状态 —— 只封装**固件真的有的**命令（计划 §5「有对应, 直接接线」）。
 *
 * ⚠ 写→读回是刚需, 不是保险: 固件对载荷质量/质心是**静默钳幅**（质量夹到 0、
 * 质心夹到 ±1），不回读就不知道真正生效的是什么。所以每个 writer 之后都重新
 * `read*()` 并把读回值渲染出来。
 *
 * ⚠ 逐轴重力/惯量系数 (`set_gravity_scale` / `set_inertia_scale`) 已从界面上撤掉:
 * 装向错了要改的是**安装方向**, 而不是把重力的量级乘一个系数糊过去 —— 后者会同时
 * 改掉所有姿态下的补偿力矩, 且没有任何读数能证明它是对的。命令本身仍在固件/SDK 里,
 * 需要时走 pylitearm 侧。
 */
export function useSettingsState() {
  const { t } = useTranslation(['common', 'settings'])
  const { status } = useArmConnection()
  const connected = status === 'connected'
  const robot = useArmState()

  const [payload, setPayload] = useState<Payload>({ mass: 0, com: [0, 0, 0] })
  const [gravityVector, setGravityVector] = useState<GravityVector>(NO_GRAVITY_VECTOR)
  const [joints, setJoints] = useState<JointParams[]>([])
  const [kinBench, setKinBench] = useState<KinBench | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const showAlert = useCallback((type: 'success' | 'error' | 'info', text: string) => {
    if (type === 'success') toast.success(text)
    else if (type === 'error') toast.error(text)
    else toast.info(text)
  }, [])

  /** 一次把三类参数都读回来（它们各自是独立 RPC，串行会很慢）。 */
  const refresh = useCallback(async () => {
    if (!connected) return
    setLoading(true)
    try {
      const [p, g, jointParams] = await Promise.all([
        armClient.readPayload(),
        armClient.readGravityVector(),
        armClient.getJointParams(),
      ])
      setPayload(p)
      setGravityVector(g)
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

  const saveGravityVector = useCallback(
    (g: GravityVector) =>
      run('gravityVectorSaved', async () => {
        await armClient.setGravityVector(g)
        const readBack = await armClient.readGravityVector()
        setGravityVector(readBack)
      }),
    [run],
  )

  /**
   * 读回重力向量 —— 「安装方向」页签的「读当前」。
   *
   * ⚠ 不复用 `refresh()`: 那会把载荷与逐轴参数一起重读, 于是"看一眼现在装向是什么"
   * 会顺带把别的页签里没保存的草稿覆盖掉。这里只读它自己那一组 (item 6 的三个 sub)。
   */
  const readGravity = useCallback(async () => {
    if (!connected) {
      showAlert('error', t('common:errors.notConnected'))
      return
    }
    setLoading(true)
    try {
      setGravityVector(await armClient.readGravityVector())
    } catch (err) {
      showAlert('error', t('settings:toast.readFailed', { message: formatArmError(err) }))
    } finally {
      setLoading(false)
    }
  }, [connected, showAlert, t])

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
    /** 固件要求失能态才能擦写 flash, 也拒绝在使能状态下改重力向量 —— 面板据此提示。 */
    canPersist: connected,
    /** 驱动器是否已使能 (daemon 的 `enabled` 位) —— 「下发（须失能）」据此禁用。 */
    enabled: robot?.enabled === true,
    loading,
    saving,
    showAlert,
    refresh,
    payload,
    savePayload,
    gravityVector,
    readGravity,
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

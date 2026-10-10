import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { armClient, formatArmError, useArmConnection, useArmState, type JointParams } from '@/lib/arm'
import { gravityMagnitude, isStandardMagnitude } from './installationPose'

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
 * 「下发安装方向」之后的自检结果 —— 三件事分开看，别混成一句"成功"：
 *
 * · `readbackDelta/Ok` —— 回读**就是**写入值吗（f32 舍入之内）。只说明字节落位了；
 * · `magnitude/Ok`      —— 回读的 `|g|` 还在 9.81 附近吗（是否被固件钳/截）；
 * · `gq*`              —— 固件的模型重力项 `G(q)` 前后变了吗。**这一条才证明真的进了
 *   动力学模型**：写同值不该变，改动过则必须变。取不到 `G(q)`（旧固件没有 0x39，
 *   或手里没有姿态）时为 `null`，界面显示"跳过"而不是假装通过。
 */
export type InstallationCheck = {
  /** 下发的那三个数。 */
  wrote: GravityVector
  /** 固件回读的三个数。 */
  back: GravityVector
  /** 回读与写入的最大分量差 (m/s²)，以及它是否落在舍入容差内。 */
  readbackDelta: number
  readbackOk: boolean
  magnitude: number
  magnitudeOk: boolean
  /** `G(q)` 前后（同一个姿态）。取不到时两者都是 `null`。 */
  gqBefore: number[] | null
  gqAfter: number[] | null
  /** 模型重力项变了没有；取不到 `G(q)` 时为 `null`。 */
  gqChanged: boolean | null
  /** "变没变"是否符合预期（值没改动 ⇒ 不该变；改动过 ⇒ 必须变）。 */
  gqOk: boolean | null
}

/** 回读与写入的判等容差 (m/s²)：固件按 f32 存，量化误差远小于它。 */
const READBACK_EPSILON = 1e-4

/** `G(q)` 前后是否算"变了"的容差 (Nm)：模型重算的浮点抖动不该算成变化。 */
const GQ_EPSILON = 1e-6

function maxAbsDelta(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return Number.POSITIVE_INFINITY
  let worst = 0
  for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]))
  return worst
}

function buildInstallationCheck(
  wrote: GravityVector,
  back: GravityVector,
  previous: GravityVector,
  gqBefore: number[] | null,
  gqAfter: number[] | null,
): InstallationCheck {
  const readbackDelta = maxAbsDelta(wrote, back)
  const readbackOk = readbackDelta < READBACK_EPSILON
  // 值没动过就不该有模型变化 —— 所以"预期变没变"由**回读相对基线**决定，不由写入值决定
  // （写入值可能被固件钳，那时字节层就不一致，预期自然是"变了"）。
  const expectedChange = !readbackOk || maxAbsDelta(back, previous) > READBACK_EPSILON
  const gqChanged = gqBefore && gqAfter
    ? maxAbsDelta(gqBefore, gqAfter) > GQ_EPSILON
    : null
  return {
    wrote,
    back,
    readbackDelta,
    readbackOk,
    magnitude: gravityMagnitude(back),
    magnitudeOk: isStandardMagnitude(back),
    gqBefore,
    gqAfter,
    gqChanged,
    gqOk: gqChanged === null ? null : gqChanged === expectedChange,
  }
}

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
  /**
   * 「手里这组重力向量是**从设备读回来的**」—— 下发/固化的第一条闸门。
   *
   * ⚠ 没有这一条，页面上那三个数就可能是 `[0, 0, 0]` 这样的控件默认值，而"下发"
   * 会把它**当作一个装向**盲写进固件（重力前馈随即按 0 算）。读取成功（挂载时那次
   * 自动读，或手动「读当前」）才算数；断开、换会话一律作废。
   */
  const [gravitySynced, setGravitySynced] = useState(false)
  /** 最近一次「下发安装方向」的自检结果（没有下发过时为 `null`）。 */
  const [installationCheck, setInstallationCheck] = useState<InstallationCheck | null>(null)
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
      // 这一读是"手里的装向来自设备"的凭据之一 —— 挂载时的那次自动读同样算数。
      setGravitySynced(true)
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
      // ⚠ 重力向量也要一起作废，不能只清"显示"：留着它，断开前的读回值仍会满足
      //   下发前置，重连到**另一台**臂时等于拿上一台的装向当基线。
      setGravityVector(NO_GRAVITY_VECTOR)
      setGravitySynced(false)
      setInstallationCheck(null)
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

  /**
   * 下发安装方向 —— 写三条分量 → 回读 → **自检**。
   *
   * 自检不是"再读一遍好看": 字节写进去了 ≠ 模型用了它。所以这里额外取一次固件的
   * 模型重力项 `G(q)`（0x39，同一个姿态前后各一次）—— 写同值它不该变，改动过它
   * 必须变。取不到 `G(q)`（旧固件 / 没有姿态）就如实标成"跳过"，不冒充通过。
   *
   * ⚠ 三条分量在 SDK 侧是**三次独立写**（`set_gravity_vector` 逐 sub 下发），中途
   *   会经过"模长 13.87、方向偏 45°"的中间态 ⇒ 使能态下发是危险的，闸门在界面上
   *   （见 `InstallationSection`），这里再兜一道：拒绝而不是"帮它失能"。
   */
  const applyGravityVector = useCallback(
    async (g: GravityVector): Promise<boolean> => {
      if (!connected) {
        showAlert('error', t('common:errors.notConnected'))
        return false
      }
      if (!gravitySynced) {
        showAlert('error', t('settings:installation.gateNotRead'))
        return false
      }
      // ⚠ 用 hook 里那一份 `robot`, 不用 `armClient.state`: 闸门 (界面) 与拒绝 (这里)
      //   必须看**同一个**快照, 否则会出现"按钮可点但点下去被拒"这种自相矛盾的组合。
      if (robot === null) {
        showAlert('error', t('settings:installation.gateStateUnknown'))
        return false
      }
      if (robot.enabled) {
        showAlert('error', t('settings:installation.gateArmed'))
        return false
      }
      setSaving(true)
      try {
        const previous = gravityVector
        // 姿态**只取一次**：前后两次 `G(q)` 必须在同一个 q 上比，否则"变了没有"
        // 分不清是参数生效还是臂动了。
        const q = robot.q
        const gravityTerm = async () => {
          try {
            return await armClient.getGravity(q)
          } catch {
            return null // 旧固件没有 0x39 ⇒ 跳过这一条, 不阻断下发
          }
        }
        const gqBefore = await gravityTerm()
        await armClient.setGravityVector(g)
        const back = await armClient.readGravityVector()
        const gqAfter = await gravityTerm()

        const check = buildInstallationCheck(g, back, previous, gqBefore, gqAfter)
        setGravityVector(back)
        setGravitySynced(true)
        setInstallationCheck(check)
        if (!check.readbackOk) {
          showAlert('error', t('settings:installation.checkReadbackFailed'))
        } else if (check.gqOk === false) {
          showAlert('error', t('settings:installation.checkGqFailed'))
        } else {
          showAlert('success', t('settings:toast.gravityVectorSaved'))
        }
        return true
      } catch (err) {
        showAlert('error', t('settings:toast.writeFailed', { message: formatArmError(err) }))
        return false
      } finally {
        setSaving(false)
      }
    },
    [connected, gravitySynced, gravityVector, robot, showAlert, t],
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
      setGravitySynced(true)
      setInstallationCheck(null) // 基线换了, 上一次下发的自检结果不再描述现状
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
    /**
     * 有没有收到状态帧。**"没收到"不等于"安全"** —— 与使能态并列，是下发安装方向的
     * 第二道闸门（见 `InstallationSection`）。
     */
    stateKnown: robot !== null,
    /** 驱动器是否已使能 (daemon 的 `enabled` 位) —— 「下发（须失能）」据此禁用。 */
    enabled: robot?.enabled === true,
    loading,
    saving,
    showAlert,
    refresh,
    payload,
    savePayload,
    gravityVector,
    /** 手里的重力向量是不是**从设备读回来的**（下发/固化的第一条闸门）。 */
    gravitySynced,
    /** 最近一次下发的自检结果（回读 / |g| / G(q) 前后），没下发过时为 `null`。 */
    installationCheck,
    readGravity,
    applyGravityVector,
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

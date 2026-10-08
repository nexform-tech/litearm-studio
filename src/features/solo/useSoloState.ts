import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { PadCell } from '../../components/DirectionPad'
import type { SegItem } from '../../components/SegmentedControl'
import { armClient, formatArmError, useArmConnection, useArmState, useArmMetrics, type Pose6, type SeriesSample } from '@/lib/arm'
import { DEFAULT_JOINT_COUNT, resolveJointCount } from '@/lib/arm/axes'
import { jogPose, rpyToMat3, mat3ToRpy, type Mat3 } from '@/lib/arm/geometry'
import {
  ARM_OPERATIONAL_STATES,
  FAULT_STATE_HINT,
  FIRST_SEGMENT_POINTS,
  HOME_JOINTS,
  JOINT_LIMITS,
  MODE_INTENT_TIMEOUT_MS,
  NEXT_SEGMENT_POINTS,
  ROT_STEPS,
  SEED_JOINT_PCT,
  SOLO_SPEED_STORAGE_KEY,
  TRANS_STEPS,
  ZERO_JOINTS,
  describeArmFault,
  fitJointPct,
  fitJoints,
  normalizeLimits,
  parseJog,
  readStoredSpeed,
} from './soloUtils'
import type { JointLimits } from './soloUtils'

// 兼容旧公开入口：纯函数/常量已迁移到 ./soloUtils，这里保持 re-export，
// 避免外部（含测试）在拆分后改动 import 路径。
export { HOME_JOINTS, JOINT_LIMITS, ZERO_JOINTS, normalizeLimits, pctToRad, pctToRadNum, radToPct, readStoredSpeed } from './soloUtils'

type Frame = 'base' | 'tool'
type ArmMode = '位置' | '零重力'

export type { SeriesSample }

/** 3D 预览的数据源：仿真跟随虚拟关节姿态，实机跟随广播的实际关节角。 */
export type PreviewFeed = { mode: 'sim'; q: number[] } | { mode: 'real'; q: number[] | null }

export type SoloState = {
  /** 仿真模式下的本地使能开关；实机模式由广播状态派生，不使用该值。 */
  enabled: boolean
  real: boolean
  mode: ArmMode
  /** 已下发但广播尚未确认的模式切换意图；null 表示以广播状态为准。 */
  modeIntent: ArmMode | null
  speed: number
  frame: Frame
  expanded: boolean
  jointPct: number[]
  releaseOnly: boolean
  cart: { X: number; Y: number; Z: number; RX: number; RY: number; RZ: number }
  transStep: string
  rotStep: string
  fault: boolean
}

const INITIAL_STATE: SoloState = {
  enabled: true,
  real: true,
  mode: '位置',
  modeIntent: null,
  speed: 50,
  frame: 'base',
  expanded: false,
  jointPct: [...SEED_JOINT_PCT],
  releaseOnly: true,
  cart: { X: 0.3241, Y: -0.0182, Z: 0.487, RX: 0, RY: 1.5701, RZ: -0.0004 },
  transStep: '10 mm',
  rotStep: '5 °',
  fault: false,
}

function getInitialSoloState(): SoloState {
  return { ...INITIAL_STATE, speed: readStoredSpeed() }
}

function pillProps<T extends string>(current: T, id: T) {
  return {
    active: current === id,
    bg: current === id ? 'var(--seg-active)' : 'transparent',
    fg: current === id ? 'var(--ink)' : 'var(--ink-subtle)',
  }
}

export function useSoloState() {
  const { t } = useTranslation(['common', 'solo'])
  const [s, setS] = useState(getInitialSoloState)
  const update = (patch: Partial<SoloState>) => setS((prev) => ({ ...prev, ...patch }))

  // ── 全局速度持久化：滑块变化即写入 localStorage，刷新后恢复 ──
  useEffect(() => {
    try {
      localStorage.setItem(SOLO_SPEED_STORAGE_KEY, String(s.speed))
    } catch {
      // 忽略 localStorage 写入错误
    }
  }, [s.speed])

  const { status: armStatus, conn } = useArmConnection()
  const armState = useArmState()
  const connected = armStatus === 'connected'

  // 这台臂有几个轴 —— 唯一来源是 daemon `conn` 帧里的 `n`（issue #37）。以前滑条、
  // 读数与 movej 目标都按写死的 7 轴来，`{1J}` 台架上会多发 6 个假关节角。
  // 仿真模式固定内置虚拟臂的轴数：那时姿态本来就是前端造的。
  const jointCount = s.real ? resolveJointCount(conn, armState) : DEFAULT_JOINT_COUNT

  // `s.jointPct` 可能还是按内置 7 轴种的初始值（或上一次连的另一种臂），按当前轴数
  // 裁剪/补齐后再交给界面与指令，保证"看到几根滑条"就等于"发出去几个关节角"。
  const jointPct = useMemo(() => fitJointPct(s.jointPct, jointCount), [s.jointPct, jointCount])

  // 固件是否编译了笛卡尔规划（`conn.cart`，daemon 连接时探测固件得出）。只在
  // **已连接且固件明确报告 cart=false** 时判定为不支持：仿真模式不下发指令，
  // 未连接时也发不出指令，这两种情况都不该冒出"固件没有笛卡尔规划"的说法。
  const cartUnsupported = s.real && connected && conn?.cart === false

  // 滑条 0–100 的弧度映射：优先用 daemon get_joint_params 的实际软限位，
  // 未连接/拿不到时回退到前端硬编码默认（GENERIC-V4）。
  const [jointLimits, setJointLimits] = useState<JointLimits[] | null>(null)

  useEffect(() => {
    if (!connected) {
      setJointLimits(null)
      return
    }
    let cancelled = false
    armClient
      .getJointParams()
      .then((raw) => {
        if (cancelled) return
        const normalized = normalizeLimits(raw)
        if (normalized) setJointLimits(normalized)
      })
      .catch((err) => {
        // ⚠ 不许静默回退：滑条会退回**内置**量程，但界面仍宣称是这台臂的范围。
        // 静默的话，按滑条的百分比换算出的目标角可能落在固件软限位之外。至少说一声。
        if (cancelled) return
        console.warn('get_joint_params failed; falling back to built-in joint limits', err)
        toast.warning(t('common:errors.jointLimitsFallback'), { id: 'joint-limits-fallback' })
      })
    return () => {
      cancelled = true
    }
  }, [connected, t])

  const limitsOf = useCallback(
    (i: number) => jointLimits?.[i] ?? JOINT_LIMITS[i] ?? { min: -Math.PI, max: Math.PI },
    [jointLimits],
  )
  const toRad = useCallback((pct: number, i: number) => {
    const { min, max } = limitsOf(i)
    return min + ((max - min) * pct) / 100
  }, [limitsOf])
  const toPct = useCallback((rad: number, i: number) => {
    const { min, max } = limitsOf(i)
    return Math.min(100, Math.max(0, ((rad - min) / (max - min)) * 100))
  }, [limitsOf])

  // 最近一次失败的机械臂指令。此前这些错误只进 console，界面上只剩一个说不清缘由的故障灯。
  const [lastError, setLastError] = useState<{ op: string; msg: string } | null>(null)
  const reportError = useCallback((op: string, err: unknown) => {
    console.error(`${op} failed`, err)
    const msg = formatArmError(err)
    setLastError({ op, msg })
    toast.error(`${op}失败：${msg}`, { id: `solo-error-${op}` })
  }, [])

  const [cartPose, setCartPose] = useState<Pose6 | null>(null)

  const armStateRef = useRef(armState)
  armStateRef.current = armState

  // 广播里的真实模式（zero_gravity ⇔ 零重力）；仿真/未连接时为 null。
  const broadcastMode: ArmMode | null =
    s.real && armState ? (armState.state === 'zero_gravity' ? '零重力' : '位置') : null

  // 模式意图对账：广播追上意图即清除意图，回到"以广播为准"。依赖的是派生出的
  // 模式字符串而非 armState 本身，否则 10Hz 广播会不停重置下面的超时定时器。
  useEffect(() => {
    if (!s.modeIntent) return
    if (!s.real || broadcastMode === s.modeIntent) {
      setS((p) => (p.modeIntent ? { ...p, modeIntent: null } : p))
      return
    }
    const id = setTimeout(() => setS((p) => ({ ...p, modeIntent: null })), MODE_INTENT_TIMEOUT_MS)
    return () => clearTimeout(id)
  }, [s.modeIntent, s.real, broadcastMode])

  const metricsState = useArmMetrics({ real: s.real })

  // 笛卡尔点动状态：按住时逐段生成目标位姿并用 movel 直线趋近，松开即停止续段。
  const jogHoldingRef = useRef(false)
  const jogGenRef = useRef(0)
  const jogContinuousRef = useRef(false)

  const runJog = useCallback(
    async (gen: number, axis: 'X' | 'Y' | 'Z', isRot: boolean, step: number, frame: Frame, speed: number) => {
      let first = true
      try {
        while (gen === jogGenRef.current) {
          const pose6 = await armClient.getTcpPose()
          // 异步等待期间如果被新操作覆盖，直接退出
          if (gen !== jogGenRef.current) break
          // 续段必须处于按住状态才继续
          if (!first && !jogHoldingRef.current) break

          if (!first) {
            jogContinuousRef.current = true
          }

          const points = first ? FIRST_SEGMENT_POINTS : NEXT_SEGMENT_POINTS
          first = false

          // 本地生成笛卡尔路点；daemon 只有 movel（单条直线），逐段下发末点目标。
          let p: [number[], number[][]] = [
            [pose6[0], pose6[1], pose6[2]],
            rpyToMat3(pose6[3], pose6[4], pose6[5]),
          ]
          for (let i = 0; i < points; i++) {
            p = jogPose(p, axis, isRot ? 'rotate' : 'translate', step, frame)
          }

          if (gen !== jogGenRef.current) break
          const rpy = mat3ToRpy(p[1] as Mat3)
          const target: Pose6 = [p[0][0], p[0][1], p[0][2], rpy[0], rpy[1], rpy[2]]
          await armClient.movel(target, speed / 100)
          if (!jogHoldingRef.current || gen !== jogGenRef.current) break
        }
      } catch (err) {
        if (jogHoldingRef.current && gen === jogGenRef.current) {
          // ⚠ 之前只 `console.error` —— 点动被拒（运动互斥/未使能/链路故障）时面板
          // 毫无反应，操作员只能反复按。走统一报错（toast id 相同 ⇒ 不会刷屏）。
          reportError('笛卡尔点动', err)
          jogHoldingRef.current = false
        }
      } finally {
        if (gen === jogGenRef.current) {
          jogContinuousRef.current = false
        }
      }
    },
    [reportError],
  )

  // 进入仿真：沿用实机模式的当前关节姿态作为纯前端临时模拟的起点，
  // 避免从初始姿态跳变；仿真期间广播不再更新 jointPct。
  useEffect(() => {
    if (s.real) return
    setS((p) => ({ ...p, fault: false }))
  }, [s.real])

  // 切回实机：丢弃仿真期间的全部虚拟状态（有广播时由下方同步 effect 在同一
  // 提交内覆盖为实际关节角；未连接则回到初始姿态）。
  useEffect(() => {
    if (!s.real) return
    setS((p) => ({ ...p, jointPct: [...INITIAL_STATE.jointPct], cart: { ...INITIAL_STATE.cart }, fault: false }))
  }, [s.real])

  // 实机模式：jointPct 跟随广播的实际关节角（JointSpacePanel 拖动时会用本地
  // staged 值遮蔽广播，不会打断在途手势）。仿真模式为纯前端虚拟姿态，不受广播污染。
  useEffect(() => {
    if (!armState || !s.real) return
    const rawQ = armState.q
    if (!Array.isArray(rawQ) || rawQ.length === 0) return
    const next = rawQ.slice(0, jointCount).map((rad, i) => toPct(rad, i))
    setS((p) => {
      // 值未变化时保持原状态引用，避免广播/渲染抖动触发无限更新。
      if (p.jointPct.length === next.length && p.jointPct.every((v, i) => v === next[i])) return p
      return { ...p, jointPct: next }
    })
  }, [armState, s.real, toPct, jointCount])

  // Cartesian pose is fetched on demand (RPC, not part of the state broadcast).
  // 关节与笛卡尔现在**同时可见**（不再用页签二选一），所以只要连着就轮询；
  // 固件没有笛卡尔规划时不轮询——那条读口必然失败。
  useEffect(() => {
    if (!s.real || !connected || cartUnsupported) return
    let cancelled = false
    const tick = () => {
      armClient
        .getTcpPose()
        .then((pose) => {
          if (!cancelled) setCartPose(pose)
        })
        .catch(() => {})
    }
    tick()
    const id = setInterval(tick, 400)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [connected, cartUnsupported, s.real])

  const armErrs = s.real && armState ? (armState.errs ?? []) : []
  const realEnabled = s.real && connected && armState != null && armState.enabled && ARM_OPERATIONAL_STATES.has(armState.state)
  const realJointFault = s.real && armState != null && (armErrs.some((e) => e >= 8) || armState.faulted)
  const realStateFault = s.real && armState?.state === 'fault'
  // 实机模式展示真实状态；仿真模式保留本地开关（纯前端临时模拟）。
  const enableOn = s.real ? realEnabled : s.enabled

  // 实机模式以广播的真实状态为准（zero_gravity ⇔ 零重力），避免 UI 与实际不符；
  // 切换指令在途时先按意图显示（modeIntent），仿真/未连接时退回本地选择。
  const realMode: ArmMode = s.modeIntent ?? broadcastMode ?? s.mode

  // 零重力是一颗可反复开关的按钮：按一下进入（固件 zero_g_start），再按一下退出
  // （zero_g_stop，固件没有 hold 指令）。目标模式由**当前显示的模式**取反，
  // 而不是由点击那一刻写死的目标决定 —— 否则连点两下会发出两条同样的命令。
  const toggleZeroGravity = () => {
    const target: ArmMode = realMode === '零重力' ? '位置' : '零重力'
    if (!connected || !s.real) {
      update({ mode: target, modeIntent: null })
      return
    }
    update({ mode: target, modeIntent: target })
    const action = target === '零重力' ? armClient.zeroGStart() : armClient.zeroGStop()
    action
      .then(() => setLastError(null))
      .catch((err) => {
        reportError(target === '零重力' ? '进入零重力模式' : '退出零重力模式', err)
        setS((p) => ({ ...p, modeIntent: null }))
      })
  }

  // 仿真模式始终展示虚拟姿态；实机模式已连接时展示同步的实际关节角；
  // 未连接时也展示滑条对应的角度，避免读数与滑条不一致。
  // 位姿卡给到 6 位小数：关节角差 0.001 rad、TCP 差 0.0001 m 在示教时都看得见。
  const jointVals = jointPct.map((pct, i) => toRad(pct, i).toFixed(6))
  const poseJoint = jointVals.map((v, i) => ({ k: 'J' + (i + 1), v, u: 'rad' }))

  // 关节与笛卡尔同时展示（不再用页签二选一）。顺序取 daemon `get_tcp` 的原生顺序：
  // 先位置后姿态。两列网格下因此排成 (X,Y) (Z,RX) (RY,RZ) 三行。
  // ⚠ 固件没有笛卡尔规划时返回 null：这条 RPC 必然失败，退回本地兜底的 `s.cart`
  // 初始值会把假数当真实位姿显示（见 useSoloState.cart.test.ts）。
  const poseCart = cartUnsupported
    ? null
    : cartPose
      ? [
          { k: 'X', v: cartPose[0].toFixed(6), u: 'm' },
          { k: 'Y', v: cartPose[1].toFixed(6), u: 'm' },
          { k: 'Z', v: cartPose[2].toFixed(6), u: 'm' },
          { k: 'RX', v: cartPose[3].toFixed(6), u: 'rad' },
          { k: 'RY', v: cartPose[4].toFixed(6), u: 'rad' },
          { k: 'RZ', v: cartPose[5].toFixed(6), u: 'rad' },
        ]
      : [
          { k: 'X', v: s.cart.X.toFixed(6), u: 'm' },
          { k: 'Y', v: s.cart.Y.toFixed(6), u: 'm' },
          { k: 'Z', v: s.cart.Z.toFixed(6), u: 'm' },
          { k: 'RX', v: s.cart.RX.toFixed(6), u: 'rad' },
          { k: 'RY', v: s.cart.RY.toFixed(6), u: 'rad' },
          { k: 'RZ', v: s.cart.RZ.toFixed(6), u: 'rad' },
        ]

  const joints = jointPct.map((pct, i) => {
    // 实机：按驱动状态码逐关节显示（0=未使能、1=正常/运动中、≥8=故障）；
    // 未拿到广播（未连接）一律视为未使能。仿真纯前端：仅由本地开关控制。
    const st = s.real
      ? !armState
        ? 'off'
        : (armErrs[i] ?? 0) >= 8
          ? 'warn'
          : (armErrs[i] ?? 0) === 1
            ? connected && armState.state === 'moving'
              ? 'move'
              : 'ok'
            : 'off'
      : !s.enabled
        ? 'off'
        : 'ok'
    const DOT = {
      ok: { c: 'var(--ok)', r: 'rgba(18,161,80,0)', t: `关节 ${i + 1} · 正常` },
      move: { c: '#3b82f6', r: 'rgba(59,130,246,.22)', t: `关节 ${i + 1} · 运动中` },
      warn: { c: '#f5a524', r: 'rgba(245,165,36,.25)', t: `关节 ${i + 1} · 故障` },
      off: { c: 'var(--line-strong)', r: 'rgba(0,0,0,0)', t: `关节 ${i + 1} · 未使能` },
    }[st]
    return {
      key: i,
      name: '关节 ' + (i + 1),
      val: toRad(pct, i).toFixed(3),
      pct,
      dot: DOT.c,
      dotRing: `0 0 0 0.1875rem ${DOT.r}`,
      dotTitle: DOT.t,
    }
  })

  const frames = ([
    { id: 'base', name: t('solo:cartesian.baseFrame') },
    { id: 'tool', name: t('solo:cartesian.toolFrame') },
  ] as const).map((f) => ({ key: f.id, label: f.name, ...pillProps(s.frame, f.id), onClick: () => update({ frame: f.id }) }))

  // 点动盘的格子顺序 = 盘面位置（十字形，见 `DirectionPad` 的 `PadCell`）：
  // 顶部一对 → 上 → 左/标签/右 → 下。平移盘把 Z 拆成顶部那一对，X 走竖向、
  // Y 走横向；旋转盘同理（RZ 一对、RY 竖向、RX 横向）。
  const transCells: PadCell[] =
    s.frame === 'base'
      ? [
          ['Z+', t('solo:cartesian.pad.up')],
          ['Z−', t('solo:cartesian.pad.down')],
          ['X+', t('solo:cartesian.pad.fwd')],
          ['Y+', t('solo:cartesian.pad.left')],
          [t('solo:cartesian.transTitle'), t('solo:cartesian.transUnit'), true],
          ['Y−', t('solo:cartesian.pad.right')],
          ['X−', t('solo:cartesian.pad.back')],
        ]
      : [
          ['TZ+', t('solo:cartesian.pad.feed')],
          ['TZ−', t('solo:cartesian.pad.retract')],
          ['TX+', t('solo:cartesian.pad.toolFwd')],
          ['TY+', t('solo:cartesian.pad.toolLeft')],
          [t('solo:cartesian.transTitle'), t('solo:cartesian.transUnit'), true],
          ['TY−', t('solo:cartesian.pad.toolRight')],
          ['TX−', t('solo:cartesian.pad.toolBack')],
        ]

  const rotCells: PadCell[] =
    s.frame === 'base'
      ? [
          ['RZ+', t('solo:cartesian.pad.rotBaseZ')],
          ['RZ−', t('solo:cartesian.pad.rotBaseZ')],
          ['RY−', t('solo:cartesian.pad.rotBaseY')],
          ['RX+', t('solo:cartesian.pad.rotBaseX')],
          [t('solo:cartesian.rotTitle'), t('solo:cartesian.rotUnit'), true],
          ['RX−', t('solo:cartesian.pad.rotBaseX')],
          ['RY+', t('solo:cartesian.pad.rotBaseY')],
        ]
      : [
          ['RTZ+', t('solo:cartesian.pad.rotToolZ')],
          ['RTZ−', t('solo:cartesian.pad.rotToolZ')],
          ['RTY−', t('solo:cartesian.pad.rotToolY')],
          ['RTX+', t('solo:cartesian.pad.rotToolX')],
          [t('solo:cartesian.rotTitle'), t('solo:cartesian.rotUnit'), true],
          ['RTX−', t('solo:cartesian.pad.rotToolX')],
          ['RTY+', t('solo:cartesian.pad.rotToolY')],
        ]

  const viewTabs: SegItem[] = [
    { key: 'sim', label: t('common:sim'), active: !s.real, onClick: () => update({ real: false }) },
    { key: 'real', label: t('common:real'), active: s.real, onClick: () => update({ real: true }) },
  ]

  // 3D 预览数据源：实机跟随广播的实际关节角；仿真跟随纯前端虚拟姿态（jointPct），
  // 由 PreviewPanel 在本地做平滑插值动画，未连接时也能预览。
  const preview: PreviewFeed = s.real
    ? { mode: 'real', q: armState?.q ?? null }
    : { mode: 'sim', q: jointPct.map((pct, i) => toRad(pct, i)) }

  const currentModeName = realMode === '位置' ? t('solo:modes.position') : t('solo:modes.drag')

  return {
    // top-of-card view mode
    viewBadge: `${currentModeName} · ${s.real ? t('common:real') : t('common:sim')}`,
    viewTabs,
    preview,

    poseJoint,
    poseCart,
    /** 固件未编译笛卡尔规划：笛卡尔面板与笛卡尔读数据此收手。 */
    cartUnsupported,

    ...metricsState,

    speed: s.speed,
    setSpeed: (v: number) => update({ speed: v }),
    enabled: enableOn,
    toggleEnable: () => {
      // 仿真模式：纯前端开关，只影响虚拟姿态面板。
      if (!s.real) {
        update({ enabled: !s.enabled })
        return
      }
      // 实机模式：已使能 → 失能（ControlBar 会先弹确认再调到这里）；
      // 未使能/故障 → 清锁存故障并重新使能驱动。
      if (realEnabled) {
        update({ fault: false })
        if (!connected) return
        armClient
          .disable()
          .then(() => setLastError(null))
          .catch((err) => reportError('失能', err))
        return
      }
      update({ fault: false })
      if (!connected) return
      armClient
        .clearFaults()
        .then(() => armClient.enable())
        .then(() => setLastError(null))
        .catch((err) => reportError('使能', err))
    },
    fault: s.real ? realJointFault || realStateFault : s.fault,
    // 故障灯旁边说人话。广播里的线索和最近一条指令的报错都要给——前者说“现在是什么
    // 状态”，后者往往才是真正的原因。
    faultReason: s.real
      ? [
          describeArmFault(armState),
          lastError && `${lastError.op}失败：${lastError.msg}`,
          armState?.state === 'fault' ? FAULT_STATE_HINT : null,
        ]
          .filter(Boolean)
          .join('；') || null
      : null,
    clearFault: () => {
      update({ fault: false })
      if (!connected || !s.real) return
      setLastError(null)
      armClient.clearFaults().catch((err) => reportError('清除故障', err))
    },
    homeJoints: () => {
      // 就绪姿态 Home [0, 0.5, 0, -1, 0, 0.6, 0]（按当前轴数裁剪/补齐）
      const target = fitJoints(HOME_JOINTS, jointCount)
      setS((p) => ({ ...p, jointPct: target.map((rad, i) => toPct(rad, i)) }))
      if (connected && s.real && enableOn) {
        armClient
          .setSpeed(s.speed)
          .then(() => armClient.movej(target, s.speed / 100))
          .then(() => setLastError(null))
          .catch((err) => reportError('就绪姿态', err))
      }
    },
    zeroJoints: () => {
      // 直立零位 Zero [0, 0, 0, 0, 0, 0, 0]（固件低速度回零）
      const target = fitJoints(ZERO_JOINTS, jointCount)
      setS((p) => ({ ...p, jointPct: target.map((rad, i) => toPct(rad, i)) }))
      if (connected && s.real && enableOn) {
        armClient
          .setSpeed(s.speed)
          .then(() => armClient.home())
          .then(() => setLastError(null))
          .catch((err) => reportError('回零点', err))
      }
    },
    // 使能按钮只吃一颗状态点的颜色：按钮皮肤统一在 ControlBar（描边 + 圆点）。
    enableDot: enableOn ? '#4ade80' : '#f5a524',
    /** 零重力开关是否处于激活：实机跟随广播，指令在途时先跟随意图。 */
    zeroGravity: realMode === '零重力',
    toggleZeroGravity,

    joints,
    releaseOnly: s.releaseOnly,
    toggleReleaseOnly: () => update({ releaseOnly: !s.releaseOnly }),
    radOfPct: (pct: number, i: number) => toRad(pct, i).toFixed(3),
    dispatchJoint: (key: number, pct: number) => {
      const clamped = Math.min(100, Math.max(0, pct))
      // 只认界面当前这根滑条：目标长度 = 这台臂的轴数，不再多发内置 7 轴的残余。
      const next = jointPct.map((v, i) => (i === key ? clamped : v))
      // 仿真模式下只更新虚拟姿态（纯前端），不向真机下发任何指令。
      setS((p) => ({ ...p, jointPct: next }))
      if (connected && s.real) {
        const target = next.map((v, i) => toRad(v, i))
        armClient
          .movej(target, s.speed / 100)
          // 运动成功即清掉旧错误：被"正在运动"拦下后，下一次成功运动要让提示消失。
          .then(() => setLastError(null))
          .catch((err) => reportError(`关节 ${key + 1} 运动`, err))
      }
    },

    // 一次下发完整关节姿态（合成单个 movej），用于“发送”暂存改动。
    dispatchJoints: (targetPct: number[]) => {
      const clamped = fitJoints(
        targetPct.map((v) => Math.min(100, Math.max(0, Number(v) || 0))),
        jointCount,
      )
      setS((p) => ({ ...p, jointPct: clamped }))
      if (connected && s.real) {
        const target = clamped.map((v, i) => toRad(v, i))
        armClient
          .movej(target, s.speed / 100)
          .then(() => setLastError(null))
          .catch((err) => reportError('关节运动', err))
      }
    },

    movelTarget: async (targetPos: [number, number, number], targetRpy: [number, number, number]) => {
      if (!connected || !s.real) return
      if (cartUnsupported) {
        // 固件没有笛卡尔规划：movel 一定被拒。与其让操作员看到一句固件内部的报错，
        // 不如直说是这台控制器不具备该能力。
        toast.warning(t('common:errors.cartUnsupported'), { id: 'solo-cart-unsupported' })
        return
      }
      if (!enableOn) {
        // 原来这里静默 return —— 点「发送」什么都不会发生，操作员只能反复点。
        toast.warning(t('common:errors.notEnabled'), { id: 'solo-not-enabled' })
        return
      }
      try {
        await armClient.movel([...targetPos, ...targetRpy] as Pose6, s.speed / 100)
        setLastError(null)
      } catch (err) {
        reportError('笛卡尔直线运动 movel', err)
      }
    },
    syncCurrentTcpPose: async () => {
      if (!connected || !s.real) return null
      try {
        const pose = await armClient.getTcpPose()
        return {
          pos: [pose[0], pose[1], pose[2]] as [number, number, number],
          rpy: [pose[3], pose[4], pose[5]] as [number, number, number],
        }
      } catch (err) {
        reportError('获取当前 TCP 位姿', err)
        return null
      }
    },

    frames,
    transCells,
    rotCells,
    transSteps: TRANS_STEPS,
    rotSteps: ROT_STEPS,
    transStep: s.transStep,
    rotStep: s.rotStep,
    setTransStep: (v: string) => update({ transStep: v }),
    setRotStep: (v: string) => update({ rotStep: v }),
    onJogPress: (label: string) => {
      // 仿真模式纯前端：笛卡尔点动需要 IK/位姿 RPC，不与真机交互，直接忽略。
      if (!s.real || !connected) return
      // 固件没有笛卡尔规划：点动的每一段都会以 movel 下发并被拒。面板已置灰，这里
      // 兜住任何其它调用方，免得变成一串重复的固件报错。
      if (cartUnsupported) {
        toast.warning(t('common:errors.cartUnsupported'), { id: 'solo-cart-unsupported' })
        return
      }
      const jog = parseJog(label)
      if (!jog) return
      const isRot = jog.axis === 'RX' || jog.axis === 'RY' || jog.axis === 'RZ'
      const stepNum = parseFloat((isRot ? s.rotStep : s.transStep).split(' ')[0])
      const step = jog.sign * (isRot ? (stepNum * Math.PI) / 180 : stepNum / 1000)
      const baseAxis = jog.axis.startsWith('R') ? (jog.axis.slice(1) as 'X' | 'Y' | 'Z') : (jog.axis as 'X' | 'Y' | 'Z')
      const gen = ++jogGenRef.current
      jogHoldingRef.current = true
      jogContinuousRef.current = false
      void runJog(gen, baseAxis, isRot, step, s.frame, s.speed)
    },
    onJogRelease: () => {
      // 松开只停止续段；在途的单段 movel 让它自己走完（急停是独立的 STOP 按钮）。
      jogHoldingRef.current = false
      if (jogContinuousRef.current) {
        jogGenRef.current++ // 作废在途连续链路
        jogContinuousRef.current = false
      }
    },
  }
}

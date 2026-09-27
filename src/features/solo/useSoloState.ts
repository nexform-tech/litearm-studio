import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { PadCell } from '../../components/DirectionPad'
import type { SegItem } from '../../components/SegmentedControl'
import { armClient, formatArmError, useArmConnection, useArmState, useArmMetrics, type SeriesSample } from '@/lib/arm'
import { jogPose, rpyToMat3, mat3ToRpy, type Mat3 } from '@/lib/arm/geometry'
import type { Pose } from 'litearm-js/browser'
import {
  ARM_OPERATIONAL_STATES,
  FAULT_STATE_HINT,
  FIRST_SEGMENT_POINTS,
  HOME_JOINTS,
  JOINT_LIMITS,
  MODE_INTENT_TIMEOUT_MS,
  NEXT_SEGMENT_POINTS,
  RATES,
  RECORD_SAMPLE_HZ,
  ROT_STEPS,
  SOLO_SPEED_STORAGE_KEY,
  TRANS_STEPS,
  ZERO_JOINTS,
  describeArmFault,
  fmtDate,
  fmtDuration,
  isRpcTimeout,
  normalizeLimits,
  normalizeTrajList,
  parseJog,
  rateMultiplier,
  readStoredSpeed,
  trajPath,
} from './soloUtils'
import type { JointLimits, TrajRecord } from './soloUtils'

// 兼容旧公开入口：纯函数/常量已迁移到 ./soloUtils，这里保持 re-export，
// 避免外部（含测试）在拆分后改动 import 路径。
export { HOME_JOINTS, JOINT_LIMITS, ZERO_JOINTS, normalizeLimits, pctToRad, pctToRadNum, radToPct, readStoredSpeed } from './soloUtils'

type PoseTab = 'joint' | 'cart'
type Frame = 'base' | 'tool'
// 服务端没有“暂停回放”这回事（pylitearm 只有 play_trajectory + request_stop），
// 所以只有播放/停止两态。
type PlayState = 'idle' | 'playing'

export type { SeriesSample }

/** 3D 预览的数据源：仿真跟随虚拟关节姿态，实机跟随广播的实际关节角。 */
export type PreviewFeed = { mode: 'sim'; q: number[] } | { mode: 'real'; q: number[] | null }

export type SoloState = {
  /** 仿真模式下的本地使能开关；实机模式由广播状态派生，不使用该值。 */
  enabled: boolean
  real: boolean
  mode: '位置' | '拖动' | '阻抗'
  /** 已下发但广播尚未确认的模式切换意图；null 表示以广播状态为准。 */
  modeIntent: '位置' | '拖动' | '阻抗' | null
  speed: number
  frame: Frame
  poseTab: PoseTab
  expanded: boolean
  play: PlayState
  sel: number
  loop: boolean
  rate: string
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
  poseTab: 'joint',
  expanded: false,
  play: 'idle',
  sel: 0,
  loop: false,
  rate: '1.0×',
  jointPct: [50, 42, 55, 83, 48, 61, 49],
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

  const { status: armStatus } = useArmConnection()
  const armState = useArmState()
  const connected = armStatus === 'connected'

  // 滑条 0–100 的弧度映射：优先用控制器 getJointLimits 的实际限位，
  // 未连接/拿不到时回退到前端硬编码默认（GENERIC-V4）。
  const [jointLimits, setJointLimits] = useState<JointLimits[] | null>(null)

  useEffect(() => {
    if (!connected) {
      setJointLimits(null)
      return
    }
    let cancelled = false
    armClient
      .withArm((a) => a.getJointLimits())
      .then((raw) => {
        if (cancelled) return
        const normalized = normalizeLimits(raw)
        if (normalized) setJointLimits(normalized)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [connected])

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

  // 最近一次失败的机械臂指令。此前这些错误只进 console，界面上只剩一个说不清缘由的
  // 故障灯——出问题时只能去翻控制器日志。
  const [lastError, setLastError] = useState<{ op: string; msg: string } | null>(null)
  const reportError = useCallback((op: string, err: unknown) => {
    console.error(`${op} failed`, err)
    const msg = formatArmError(err)
    setLastError({ op, msg })
    toast.error(`${op}失败：${msg}`, { id: `solo-error-${op}` })
  }, [])

  const [cartPose, setCartPose] = useState<Pose | null>(null)
  const [trajList, setTrajList] = useState<TrajRecord[]>([])
  const [recording, setRecording] = useState(false)
  const [recElapsedS, setRecElapsedS] = useState(0)
  const [trajName, setTrajName] = useState('')

  const armStateRef = useRef(armState)
  armStateRef.current = armState

  // 广播里的真实模式（zero_gravity ⇔ 拖动，阻抗 ⇔ 阻抗）；仿真/未连接时为 null。
  const broadcastMode: '位置' | '拖动' | '阻抗' | null =
    s.real && armState
      ? armState.state === 'zero_gravity'
        ? '拖动'
        : armState.state === 'joint_impedance' || armState.state === 'cartesian_impedance'
          ? '阻抗'
          : '位置'
      : null

  // 模式意图对账：广播追上意图即清除意图，回到"以广播为准"。依赖的是派生出的
  // 模式字符串而非 armState 本身，否则 50Hz 广播会不停重置下面的超时定时器。
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

  // 笛卡尔点动状态：按住时分段 movep 链，首段单步（1点），长按进入连续点动，松开 requestStop 打断。
  const jogHoldingRef = useRef(false)
  const jogGenRef = useRef(0)
  const jogContinuousRef = useRef(false)

  const runJog = useCallback(
    async (gen: number, axis: 'X' | 'Y' | 'Z', isRot: boolean, step: number, frame: Frame, speed: number) => {
      let first = true
      try {
        while (gen === jogGenRef.current) {
          const pose0 = await armClient.withArm((a) => a.getTcpPose())
          // 异步等待期间如果被新操作覆盖，直接退出
          if (gen !== jogGenRef.current) break
          // 续段必须处于按住状态才继续
          if (!first && !jogHoldingRef.current) break

          if (!first) {
            jogContinuousRef.current = true
          }

          const points = first ? FIRST_SEGMENT_POINTS : NEXT_SEGMENT_POINTS
          first = false

          // 本地生成笛卡尔路点；服务端 movep 一次规划并沿单条 S 曲线连续执行。
          const poses: [number[], number[][]][] = []
          let p = pose0
          for (let i = 0; i < points; i++) {
            p = jogPose(p, axis, isRot ? 'rotate' : 'translate', step, frame)
            poses.push(p)
          }

          if (gen !== jogGenRef.current) break
          await armClient.withArm((a) => a.movep(poses, { speed: speed / 100, settle_s: 0 }))
          if (!jogHoldingRef.current || gen !== jogGenRef.current) break
        }
      } catch (err) {
        // 松开时的 requestStop 会中断在途 movep，属正常退出；其余错误记录并停止。
        if (jogHoldingRef.current && gen === jogGenRef.current) {
          console.error('jog movep failed', err)
          jogHoldingRef.current = false
        }
      } finally {
        if (gen === jogGenRef.current) {
          jogContinuousRef.current = false
        }
      }
    },
    [],
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
    const next = rawQ.slice(0, 7).map((rad, i) => toPct(rad, i))
    setS((p) => {
      // 值未变化时保持原状态引用，避免广播/渲染抖动触发无限更新。
      if (p.jointPct.length === next.length && p.jointPct.every((v, i) => v === next[i])) return p
      return { ...p, jointPct: next }
    })
  }, [armState, s.real, toPct])

  const refreshTrajectories = () => {
    armClient
      .withArm((a) => a.listTrajectories())
      .then((raw) => setTrajList(normalizeTrajList(raw)))
      .catch((err) => console.error('listTrajectories failed', err))
  }

  useEffect(() => {
    if (!s.real) {
      setTrajList([])
      return
    }
    if (!connected) {
      setTrajList([])
      return
    }
    refreshTrajectories()
  }, [connected, s.real])

  // Cartesian pose is fetched on demand (RPC, not part of the state
  // broadcast) — poll while the 笛卡尔 tab is visible.
  useEffect(() => {
    if (!s.real || !connected || s.poseTab !== 'cart') return
    let cancelled = false
    const tick = () => {
      armClient
        .withArm((a) => a.getTcpPose())
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
  }, [connected, s.poseTab, s.real])

  useEffect(() => {
    if (!recording) return
    const t0 = Date.now()
    const id = setInterval(() => setRecElapsedS((Date.now() - t0) / 1000), 200)
    return () => clearInterval(id)
  }, [recording])

  // 用户是否已按下“停止并保存”——用来区分“录制真的失败了”和“只是 RPC 超时”。
  const recStopRef = useRef(false)
  const recRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 组件卸载时清掉延迟刷新，避免卸载后 setState
  useEffect(
    () => () => {
      if (recRefreshTimerRef.current) clearTimeout(recRefreshTimerRef.current)
    },
    [],
  )

  const toggleRecording = () => {
    if (!connected || !s.real) return
    if (!recording) {
      // 拖拽示教走 pylitearm 原生的 record_trajectory：它内部就是
      // zero_gravity(on_sample=...)，100Hz 采样 + EMA 平滑，跑完由 pylitearm 自己存成
      // trajectories/trajectory_NNN.json —— 前端不需要再 saveTrajectory。
      // 这条 RPC 要等到 request_stop 才返回，且返回值是数据类的 repr 字符串（WS 桥接层
      // 没法序列化它），所以一律不依赖返回值，以重新拉列表为准。
      recStopRef.current = false
      setRecElapsedS(0)
      setRecording(true)
      armClient
        .withArm((a) => a.recordTrajectory({ name: trajName.trim() || undefined, sample_rate_hz: RECORD_SAMPLE_HZ }))
        .then(() => {
          setRecording(false)
          setTrajName('')
          refreshTrajectories()
        })
        .catch((err) => {
          // 用户主动停止：requestStop 会打断在途的 record_trajectory RPC，
          // 中断/超时都是正常退出，不当作失败展示。
          if (recStopRef.current) {
            setRecording(false)
            refreshTrajectories()
            return
          }
          // 超时且用户还没喊停 → 服务端仍在录制，保持 UI 的录制中状态。
          if (isRpcTimeout(err)) return
          reportError('拖拽示教录制', err)
          setRecording(false)
          refreshTrajectories()
        })
      return
    }
    // 停止录制：record_trajectory 内部的零重力循环只认急停通道（直接调底层
    // requestStop 打断）。
    recStopRef.current = true
    setRecording(false)
    armClient.withArm(async (a) => { a.requestStop() }).catch((err) => console.error('stop recording failed', err))
    // 存盘发生在 record_trajectory 返回之前，稍等一下再拉列表。
    recRefreshTimerRef.current = setTimeout(refreshTrajectories, 800)
  }

  // 回放：一趟跑完由 finally 归位；循环回放服务端不支持，由前端重新下发实现。
  const playGenRef = useRef(0)
  const loopRef = useRef(s.loop)
  loopRef.current = s.loop

  const stopPlayback = () => {
    playGenRef.current++ // 作废在途的循环链
    setS((p) => ({ ...p, play: 'idle' }))
    if (connected && s.real) {
      armClient.withArm(async (a) => { a.requestStop() }).catch((err) => console.error('stop playback failed', err))
    }
  }

  const startPlayback = (i: number) => {
    const t = trajList[i]
    if (!t || !s.real) return
    setS((p) => ({ ...p, sel: i, expanded: true, play: 'playing' }))
    if (!connected) return
    const gen = ++playGenRef.current
    // 全局速度 × 倍速，pylitearm 的 speed 只接受 (0,1]，超出部分截断。
    const speed = Math.min(1, Math.max(0.01, (s.speed / 100) * rateMultiplier(s.rate)))
    const runOnce = (): Promise<unknown> =>
      armClient.playTrajectory(trajPath(t.id), { speed }).then((ok) => {
        if (ok && loopRef.current && gen === playGenRef.current) return runOnce()
      })
    runOnce()
      .then(() => setLastError(null))
      .catch((err) => {
        if (isRpcTimeout(err)) return // 服务端还在回放，等它自己跑完
        reportError('轨迹回放', err)
      })
      .finally(() => {
        if (gen === playGenRef.current) setS((p) => ({ ...p, play: 'idle' }))
      })
  }

  // 删除轨迹：先弹应用内确认对话框，确认后才真正删除（不再用原生 window.confirm）
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null)
  const requestDeleteTraj = (id: string) => {
    const found = trajList.find((x) => x.id === id)
    setPendingDelete({ id, name: found?.name || found?.id || id })
  }
  const cancelDelete = () => setPendingDelete(null)
  const confirmDeleteTraj = () => {
    const target = pendingDelete
    setPendingDelete(null)
    if (!target || !connected || !s.real) return
    armClient
      .withArm((a) => a.deleteTrajectory(target.id))
      .then(() => {
        setLastError(null)
        refreshTrajectories()
      })
      .catch((err) => reportError('删除轨迹', err))
  }

  const playing = s.play === 'playing'
  const locked = s.play !== 'idle'
    // 实机模式：使能状态来自广播而不是本地开关。errs 是各关节驱动状态码，
    // 0=失能、1=使能正常、≥8=带故障的使能态（欠压/过流/过温等）。
    const armErrs = s.real && armState ? (armState.errs ?? []) : []
    const realEnabled =
      s.real &&
      connected &&
      armState != null &&
      armErrs.length > 0 &&
      armErrs.every((e) => e === 1) &&
      ARM_OPERATIONAL_STATES.has(armState.state)
    const realJointFault = s.real && armErrs.some((e) => e >= 8)
    const realStateFault = s.real && armState?.state === 'fault'
    // 实机模式展示真实状态；仿真模式保留本地开关（纯前端临时模拟）。
    const enableOn = s.real ? realEnabled : s.enabled
    // 只有轨迹回放期间锁定/置灰操作区；普通运动由 client 的运动互斥
    // （_guardMotion）和 jogInFlight 拦截并发指令，不再整列置灰禁用。
    const dimmed = locked

    // 实机模式以广播的真实状态为准（zero_gravity ⇔ 拖动，阻抗 ⇔ 阻抗），避免 UI 与实际不符；
    // 切换指令在途时先按意图显示（modeIntent），仿真/未连接时退回本地选择。
    const realMode: '位置' | '拖动' | '阻抗' = s.modeIntent ?? broadcastMode ?? s.mode

    const modes = (['位置', '拖动', '阻抗'] as const).map((name) => ({
      key: name,
      label: name === '位置' ? t('solo:modes.position') : name === '拖动' ? t('solo:modes.drag') : t('solo:modes.impedance'),
      active: realMode === name,
      onClick: () => {
        if (!connected || !s.real) {
          update({ mode: name, modeIntent: null })
          return
        }
        update({ mode: name, modeIntent: name })
        if (name === '拖动') {
          armClient
            .withArm((a) => a.zeroGravity())
            .then(() => setLastError(null))
            .catch((err) => {
              reportError('切换到拖动模式', err)
              setS((p) => ({ ...p, modeIntent: null }))
            })
        } else if (name === '阻抗') {
          const sState = armStateRef.current
          const q = sState?.q?.map(Number) || [0, 0, 0, 0, 0, 0, 0]
          const K = [4, 10, 10, 2, 2, 1, 0.5]
          const B = [0.5, 0.8, 0.8, 0.2, 0.2, 0.1, 0.05]
          armClient
            .withArm((a) => a.jointImpedance(q, K, B, { engage_sec: 0.3 }))
            .then(() => setLastError(null))
            .catch((err) => {
              reportError('切换到阻抗模式', err)
              setS((p) => ({ ...p, modeIntent: null }))
            })
        } else {
          armClient
            .withArm((a) => a.hold(3.0))
            .then(() => setLastError(null))
            .catch((err) => {
              reportError('切换到位置模式', err)
              setS((p) => ({ ...p, modeIntent: null }))
            })
        }
      },
    }))

    const poseTabs = ([
      { id: 'joint', name: t('solo:submodes.joint', { defaultValue: '关节' }) },
      { id: 'cart', name: t('solo:submodes.cartesian', { defaultValue: '笛卡尔' }) },
    ] as const).map((tItem) => ({ key: tItem.id, label: tItem.name, ...pillProps(s.poseTab, tItem.id), onClick: () => update({ poseTab: tItem.id }) }))

    // 仿真模式始终展示虚拟姿态；实机模式已连接时展示同步的实际关节角；
    // 未连接时也展示滑条对应的角度，避免读数与滑条不一致。
    const jointVals = s.jointPct.map((pct, i) => toRad(pct, i).toFixed(3))
    const pose =
      s.poseTab === 'joint'
        ? jointVals.map((v, i) => ({ k: 'J' + (i + 1), v, u: 'rad' }))
        : cartPose && cartPose[0] && cartPose[1]
        ? [
              { k: 'X', v: (cartPose[0][0] ?? 0).toFixed(4), u: 'm' },
              { k: 'Y', v: (cartPose[0][1] ?? 0).toFixed(4), u: 'm' },
              { k: 'Z', v: (cartPose[0][2] ?? 0).toFixed(4), u: 'm' },
              { k: 'RX', v: (mat3ToRpy(cartPose[1])[0] ?? 0).toFixed(4), u: 'rad' },
              { k: 'RY', v: (mat3ToRpy(cartPose[1])[1] ?? 0).toFixed(4), u: 'rad' },
              { k: 'RZ', v: (mat3ToRpy(cartPose[1])[2] ?? 0).toFixed(4), u: 'rad' },
            ]
          : [
              { k: 'X', v: (s.cart.X ?? 0).toFixed(4), u: 'm' },
              { k: 'RX', v: (s.cart.RX ?? 0).toFixed(4), u: 'rad' },
              { k: 'Y', v: (s.cart.Y ?? 0).toFixed(4), u: 'm' },
              { k: 'RY', v: (s.cart.RY ?? 0).toFixed(4), u: 'rad' },
              { k: 'Z', v: (s.cart.Z ?? 0).toFixed(4), u: 'm' },
              { k: 'RZ', v: (s.cart.RZ ?? 0).toFixed(4), u: 'rad' },
            ]

    const joints = s.jointPct.map((pct, i) => {
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

    const frameOrigin = s.frame === 'base' ? 'BASE_LINK' : 'TOOL0 / TCP'

    const transCells: PadCell[] =
      s.frame === 'base'
        ? [null, ['X+', t('solo:cartesian.pad.fwd')], ['Z+', t('solo:cartesian.pad.up')], ['Y+', t('solo:cartesian.pad.left')], ['TCP', '', true], ['Y−', t('solo:cartesian.pad.right')], null, ['X−', t('solo:cartesian.pad.back')], ['Z−', t('solo:cartesian.pad.down')]]
        : [null, ['TX+', t('solo:cartesian.pad.toolFwd')], ['TZ+', t('solo:cartesian.pad.feed')], ['TY+', t('solo:cartesian.pad.toolLeft')], ['TOOL', '', true], ['TY−', t('solo:cartesian.pad.toolRight')], null, ['TX−', t('solo:cartesian.pad.toolBack')], ['TZ−', t('solo:cartesian.pad.retract')]]

    const rotCells: PadCell[] =
      s.frame === 'base'
        ? [null, ['RX+', t('solo:cartesian.pad.rotBaseX')], ['RZ+', t('solo:cartesian.pad.rotBaseZ')], ['RY+', t('solo:cartesian.pad.rotBaseY')], [t('solo:cartesian.pad.pose'), '', true], ['RY−', t('solo:cartesian.pad.rotBaseY')], null, ['RX−', t('solo:cartesian.pad.rotBaseX')], ['RZ−', t('solo:cartesian.pad.rotBaseZ')]]
        : [null, ['RTX+', t('solo:cartesian.pad.rotToolX')], ['RTZ+', t('solo:cartesian.pad.rotToolZ')], ['RTY+', t('solo:cartesian.pad.rotToolY')], [t('solo:cartesian.pad.toolPose'), '', true], ['RTY−', t('solo:cartesian.pad.rotToolY')], null, ['RTX−', t('solo:cartesian.pad.rotToolX')], ['RTZ−', t('solo:cartesian.pad.retract')]]

    const traj = trajList.map((tItem, i) => {
      const on = s.sel === i && s.expanded
      const busy = s.play !== 'idle'
      const blocked = busy && !on
      return {
        key: tItem.id,
        i: String(i + 1).padStart(2, '0'),
        name: tItem.name || tItem.id,
        meta: fmtDate(tItem.created_at),
        dur: fmtDuration(tItem.duration),
        pts: tItem.point_count != null ? `${tItem.point_count} 点` : '— 点',
        expanded: on,
        blocked,
        // 只折叠/展开，不动 play：回放在途时收起卡片不代表机械臂停了。
        select: blocked
          ? undefined
          : () => setS((p) => ({ ...p, sel: i, expanded: !(p.sel === i && p.expanded) })),
        play: blocked ? undefined : () => startPlayback(i),
        opacity: blocked ? 0.45 : 1,
        cursor: blocked ? 'not-allowed' : 'pointer',
        playFg: blocked ? 'var(--line-strong)' : 'var(--ink-muted)',
        bg: on ? 'var(--muted)' : 'var(--card)',
        bd: on ? 'var(--line-strong)' : 'var(--line-soft)',
        idxBg: on ? 'var(--chip)' : 'var(--line-soft)',
        idxFg: on ? 'var(--chip-fg)' : 'var(--ink-soft)',
        remove: () => requestDeleteTraj(tItem.id),
      }
    })

    const rates = RATES.map((r) => ({
      key: r,
      label: r,
      active: s.rate === r,
      bg: s.rate === r ? 'var(--seg-active)' : 'transparent',
      fg: s.rate === r ? 'var(--ink)' : 'var(--ink-subtle)',
      fw: s.rate === r ? 700 : 500,
      onClick: () => update({ rate: r }),
    }))

    const viewTabs: SegItem[] = [
      { key: 'sim', label: t('common:sim'), active: !s.real, onClick: () => update({ real: false }) },
      { key: 'real', label: t('common:real'), active: s.real, onClick: () => update({ real: true }) },
    ]

    // 3D 预览数据源：实机跟随广播的实际关节角；仿真跟随纯前端虚拟姿态（jointPct），
    // 由 PreviewPanel 在本地做平滑插值动画，未连接时也能预览。
    const preview: PreviewFeed = s.real
      ? { mode: 'real', q: armState?.q ?? null }
      : { mode: 'sim', q: s.jointPct.map((pct, i) => toRad(pct, i)) }

    const selTraj = trajList[s.sel]

    const currentModeName = realMode === '位置' ? t('solo:modes.position') : realMode === '拖动' ? t('solo:modes.drag') : t('solo:modes.impedance')

    return {
      // top-of-card view mode
      viewBadge: `${currentModeName} · ${s.real ? t('common:real') : t('common:sim')}`,
      viewTabs,
      preview,

      poseTabs,
      pose,

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
            .withArm((a) => a.disable())
            .then(() => setLastError(null))
            .catch((err) => reportError('失能', err))
          return
        }
        update({ fault: false })
        if (!connected) return
        armClient
          .withArm(async (a) => {
            await a.clearFaults()
            await a.enable()
          })
          .then(() => setLastError(null))
          .catch((err) => reportError('使能', err))
      },
      fault: s.real ? realJointFault || realStateFault : s.fault,
      // 故障灯旁边说人话。广播里的线索和最近一条指令的报错都要给——前者说“现在是什么
      // 状态”，后者往往才是真正的原因（比如回放的到位超时只体现在 RPC 报错里）。
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
        armClient.withArm((a) => a.clearFaults()).catch((err) => reportError('清除故障', err))
      },
      homeJoints: () => {
        // 就绪姿态 Home [0, 0.5, 0, -1, 0, 0.6, 0]
        setS((p) => ({ ...p, jointPct: HOME_JOINTS.map((rad, i) => toPct(rad, i)) }))
        if (connected && s.real && enableOn) {
          armClient
            .movej(HOME_JOINTS, {
              speed: s.speed / 100,
              settle_s: 0,
            })
            .then(() => setLastError(null))
            .catch((err) => reportError('就绪姿态', err))
        }
      },
      zeroJoints: () => {
        // 直立零位 Zero [0, 0, 0, 0, 0, 0, 0]（无视关节限位与自碰安全检查直接回零）
        setS((p) => ({ ...p, jointPct: ZERO_JOINTS.map((rad, i) => toPct(rad, i)) }))
        if (connected && s.real && enableOn) {
          armClient
            .home({
              speed: s.speed / 100,
              settle_s: 0,
            })
            .then(() => setLastError(null))
            .catch((err) => reportError('回零位', err))
        }
      },
      enableBg: enableOn ? 'var(--chip)' : 'var(--card)',
      enableFg: enableOn ? 'var(--chip-fg)' : 'var(--ink-strong)',
      // 失能态与卡片同底（浅色白 / 深色卡片色）：必须给描边，否则看不出是个按钮。
      enableBd: enableOn ? 'var(--ink)' : 'var(--line-strong)',
      enableDot: enableOn ? '#4ade80' : '#f5a524',
      enableLabel: enableOn ? t('common:enabled') : t('common:disabled'),
      modes,

      locked,
      playing,
      lockDim: dimmed ? 0.45 : 1,
      lockEvents: dimmed ? 'none' : 'auto',
      playName: selTraj?.name || selTraj?.id || '—',
      playPoint: String(selTraj?.point_count ?? 0),
      rateLabel: s.rate,
      playBtnLabel: playing ? t('solo:controlBar.stopPlayback') : t('solo:controlBar.startPlayback'),
      togglePlay: () => (playing ? stopPlayback() : startPlayback(s.sel)),
      stopPlay: stopPlayback,

      joints,
      releaseOnly: s.releaseOnly,
      toggleReleaseOnly: () => update({ releaseOnly: !s.releaseOnly }),
      radOfPct: (pct: number, i: number) => toRad(pct, i).toFixed(3),
      dispatchJoint: (key: number, pct: number) => {
        const clamped = Math.min(100, Math.max(0, pct))
        // 仿真模式下只更新虚拟姿态（纯前端），不向真机下发任何指令。
        setS((p) => ({ ...p, jointPct: p.jointPct.map((v, i) => (i === key ? clamped : v)) }))
        if (connected && s.real) {
          const target = s.jointPct.map((v, i) => toRad(i === key ? clamped : v, i))
          // 同 homeJoints：settle_s: 0，运动到位即释放互斥锁，避免"到位后的持位期"
          // 误拦紧接着的下一次运动（详见 client.ts _guardMotion 注释）。
          armClient
            .movej(target, {
              speed: s.speed / 100,
              settle_s: 0,
            })
            // 运动成功即清掉旧错误：被"正在运动"拦下后，下一次成功运动要让提示消失。
            .then(() => setLastError(null))
            .catch((err) => reportError(`关节 ${key + 1} 运动`, err))
        }
      },

      // 一次下发完整关节姿态（7 个百分比合成单个 movej），用于“发送”暂存改动。
      // 之前 sendAll 同 tick 并发发多个 movej，运动互斥锁只放行第一个且暂存值
      // 合不到一起；这里始终只发一次，目标以调用方传入的完整数组为准。
      dispatchJoints: (targetPct: number[]) => {
        const clamped = targetPct.map((v) => Math.min(100, Math.max(0, Number(v) || 0)))
        setS((p) => ({ ...p, jointPct: clamped }))
        if (connected && s.real) {
          const target = clamped.map((v, i) => toRad(v, i))
          armClient
            .movej(target, { speed: s.speed / 100, settle_s: 0 })
            .then(() => setLastError(null))
            .catch((err) => reportError('关节运动', err))
        }
      },

      movelTarget: async (targetPos: [number, number, number], targetRpy: [number, number, number]) => {
        if (!connected || !s.real || !enableOn) return
        const R = rpyToMat3(targetRpy[0], targetRpy[1], targetRpy[2])
        try {
          await armClient.movel([targetPos, R], { speed: s.speed / 100, settle_s: 0.5 })
          setLastError(null)
        } catch (err) {
          reportError('笛卡尔直线运动 movel', err)
        }
      },
      syncCurrentTcpPose: async () => {
        if (!connected || !s.real) return null
        try {
          const [pos, rot] = await armClient.withArm((a) => a.getTcpPose())
          const rpy = mat3ToRpy(rot as Mat3)
          return {
            pos: [pos[0], pos[1], pos[2]] as [number, number, number],
            rpy,
          }
        } catch (err) {
          reportError('获取当前 TCP 位姿', err)
          return null
        }
      },

      frames,
      frameOrigin,
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
        jogHoldingRef.current = false
        if (jogContinuousRef.current) {
          jogGenRef.current++ // 作废在途连续链路
          if (connected && s.real) {
            // 直接调底层 requestStop 打断在途连续 movep 链。
            armClient.withArm(async (a) => { a.requestStop() }).catch((err) => console.error('jog stop failed', err))
          }
          jogContinuousRef.current = false
        }
      },

      traj,
      pendingDelete,
      cancelDelete,
      confirmDelete: confirmDeleteTraj,
      trajName,
      setTrajName,
      recording,
      recOpacity: s.play === 'idle' ? 1 : 0.45,
      recEvents: s.play === 'idle' ? 'auto' : 'none',
      recElapsed: fmtDuration(recElapsedS).slice(0, -2),
      toggleRecording,
      refreshTraj: refreshTrajectories,
      playBtnBg: playing ? 'var(--card)' : 'var(--chip)',
      playBtnFg: playing ? 'var(--ink)' : 'var(--chip-fg)',
      playBtnBd: playing ? 'var(--line)' : 'var(--ink)',
      toggleLoop: () => update({ loop: !s.loop }),
      loop: s.loop,
      loopBd: s.loop ? 'var(--ink)' : 'var(--line)',
      loopBg: s.loop ? 'var(--chip)' : 'var(--card)',
      loopFg: s.loop ? 'var(--chip-fg)' : 'var(--ink-subtle)',
      rates,
      lockNote:
        s.play === 'idle'
          ? t('solo:trajectory.lockNoteIdle')
          : t('solo:trajectory.lockNoteActive'),
      lockFg: s.play === 'idle' ? 'var(--ink-faint)' : 'var(--ink-soft)',
    }
}

import { Arm } from 'litearm-js/browser'
import type {
  ActiveDeviceInfo,
  DeviceTypeInfo,
  Pose,
  RobotState,
} from 'litearm-js/browser'
import { formatArmError } from './errors'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'

type Listener = () => void

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000]

function arraysEqual(a: number[] | undefined, b: number[] | undefined) {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * 格式化并防御 RobotState 中的缺失或缺省字段。
 * protobuf.js 在序列化 0、空数组等默认值时会省略 key，转为 JSON 后变成 undefined。
 * 此函数确保消费方拿到的所有数组与数值字段均有效存在，杜绝渲染崩溃。
 */
export function normalizeRobotState(raw: RobotState | null | undefined): RobotState | null {
  if (!raw) return null
  return {
    ...raw,
    q: Array.isArray(raw.q) ? raw.q.map((v) => (typeof v === 'number' && !isNaN(v) ? v : 0)) : [],
    dq: Array.isArray(raw.dq) ? raw.dq.map((v) => (typeof v === 'number' && !isNaN(v) ? v : 0)) : [],
    tau: Array.isArray(raw.tau) ? raw.tau.map((v) => (typeof v === 'number' && !isNaN(v) ? v : 0)) : [],
    errs: Array.isArray(raw.errs) ? raw.errs.map((v) => (typeof v === 'number' && !isNaN(v) ? v : 0)) : [],
    fault: Array.isArray(raw.fault)
      ? raw.fault.map((f) => ({ joint: f?.joint ?? 0, errCode: f?.errCode ?? 0 }))
      : [],
    temps: Array.isArray(raw.temps)
      ? raw.temps.map((t) => ({
          mosTemp: typeof t?.mosTemp === 'number' && !isNaN(t.mosTemp) ? t.mosTemp : 0,
          coilTemp: typeof t?.coilTemp === 'number' && !isNaN(t.coilTemp) ? t.coilTemp : 0,
        }))
      : [],
    state: typeof raw.state === 'string' ? raw.state : 'idle',
  }
}

/**
 * Owns the single Arm WebSocket connection for the whole app and polls its
 * cached state broadcast. Two independent listener sets (status vs. state)
 * so UI that only cares about connection status (TopBar) doesn't re-render
 * on every ~50Hz state tick.
 */
export class ArmClient {
  private arm: Arm | null = null
  private endpoint = ''
  private token: string | undefined
  private manualDisconnect = true
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pollHandle: number | null = null
  private _lastStateNotify = 0
  private _lastRawState: any = null
  private _cachedNormalizedState: RobotState | null = null

  /** 遥测状态（关节角/温度/力矩等）的最大通知频率。
   *  真机广播 ~50Hz，若每帧都通知，React 会以 60Hz 全页重渲染——
   *  dev 构建下每次 commit 都会产生 performance.measure 且永不清理，内存无限上涨。
   *  降频到 10Hz 后 3D 预览仍由 PreviewPanel 直接订阅原始状态保持 60Hz。 */
  private static readonly STATE_NOTIFY_INTERVAL_MS = 100

  private _status: ConnectionStatus = 'disconnected'
  private _state: RobotState | null = null
  private _lastError: string | null = null
  private _motionPending = false

  private statusListeners = new Set<Listener>()
  private stateListeners = new Set<Listener>()
  private stateFastListeners = new Set<Listener>()
  private motionListeners = new Set<Listener>()

  get status() {
    return this._status
  }
  get state() {
    return this._state
  }
  get lastError() {
    return this._lastError
  }
  get endpointValue() {
    return this.endpoint
  }

  /** True while a motion RPC (movej/movel/replay) is in flight. */
  get motionBusy() {
    return this._motionPending
  }

  subscribeStatus = (cb: Listener) => {
    this.statusListeners.add(cb)
    return () => {
      this.statusListeners.delete(cb)
    }
  }

  subscribeState = (cb: Listener) => {
    this.stateListeners.add(cb)
    return () => {
      this.stateListeners.delete(cb)
    }
  }

  /** 每帧触发的原始状态订阅（~60Hz），只给命令式消费方用（如 3D 预览），
   *  不经过 10Hz 降频，也不进 React 渲染循环。 */
  subscribeStateFast = (cb: Listener) => {
    this.stateFastListeners.add(cb)
    return () => {
      this.stateFastListeners.delete(cb)
    }
  }

  subscribeMotion = (cb: Listener) => {
    this.motionListeners.add(cb)
    return () => {
      this.motionListeners.delete(cb)
    }
  }

  connect(endpoint: string, token?: string) {
    // 已连接/连接中时忽略重复点击；重连退避期间（reconnecting）允许取消
    // 当前定时器并立即重试，用户点击「连接」不必等最长 30s 的退避结束。
    if (
      !this.manualDisconnect &&
      this.endpoint === endpoint &&
      this._status !== 'disconnected' &&
      this._status !== 'error' &&
      this._status !== 'reconnecting'
    ) {
      return
    }
    this.manualDisconnect = false
    this.endpoint = endpoint
    this.token = token
    this.reconnectAttempt = 0
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this._openSocket()
  }

  disconnect() {
    this.manualDisconnect = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this._stopPolling()
    this.arm?.close()
    this.arm = null
    this._state = null
    this._lastRawState = null
    this._cachedNormalizedState = null
    this._setMotionBusy(false)
    this._notifyState()
    this._setStatus('disconnected')
  }

  /** 停止当前运动（急停）。只停当前动作，不做任何状态锁存：
   *  服务端每条新运动指令会自动清除停止标志，前端无需维护"恢复"状态。 */
  requestStop() {
    this.arm?.requestStop()
  }

  /** 回零（所有关节回零位，绕开关节限位与路径碰撞检查）——运动中禁止再次发起。 */
  async home(opts?: { speed?: number; settle_s?: number; max_cycles?: number }): Promise<boolean> {
    return this._guardMotion(() => {
      if (!this.arm) throw new Error('机械臂未连接')
      return this.arm.home(opts)
    })
  }

  /** 关节运动——运动中禁止再次发起，避免并发指令竞态。 */
  async movej(q: number[], opts?: { speed?: number; settle_s?: number; allow_start_collision_recovery?: boolean }): Promise<boolean> {
    return this._guardMotion(() => {
      if (!this.arm) throw new Error('机械臂未连接')
      return this.arm.movej(q, opts)
    })
  }

  /** 笛卡尔直线运动——运动中禁止再次发起。 */
  async movel(pose: Pose, opts?: { speed?: number; settle_s?: number }): Promise<boolean> {
    return this._guardMotion(() => {
      if (!this.arm) throw new Error('机械臂未连接')
      return this.arm.movel(pose, opts)
    })
  }

  /** 轨迹回放——运动中禁止再次发起。
   *  trajectory 传相对服务端 cwd 的 JSON 路径（如 `trajectories/trajectory_001.json`）。 */
  async playTrajectory(
    trajectory: Record<string, unknown> | string,
    opts?: { speed?: number; goto_start?: boolean; goto_speed?: number },
  ): Promise<boolean> {
    return this._guardMotion(() => {
      if (!this.arm) throw new Error('机械臂未连接')
      return this.arm.playTrajectory(trajectory, opts)
    })
  }

  /** 关节路径回放——运动中禁止再次发起。 */
  async replayJointPath(
    qPath: number[][],
    opts?: { speed?: number; settle_s?: number; goto_start?: boolean; goto_speed?: number },
  ): Promise<boolean> {
    return this._guardMotion(() => {
      if (!this.arm) throw new Error('机械臂未连接')
      return this.arm.replayJointPath(qPath, opts)
    })
  }

  /** Direct access to the connected device proxy (hand/gripper/...), or null while disconnected. */
  device(deviceId: string) {
    return this.arm?.device(deviceId) ?? null
  }

  /** 列出服务端内置的可用末端设备类型。 */
  listDeviceTypes(): Promise<DeviceTypeInfo[]> {
    return this.withArm((arm) => arm.listDeviceTypes())
  }

  /** 连接末端设备，服务端会按需拉起对应 device daemon 并持久化。 */
  connectDevice(
    category: string,
    subtype: string,
    opts?: { deviceId?: string; canIface?: string; config?: Record<string, unknown> },
  ): Promise<{ ok: boolean; device_id?: string; error?: string }> {
    return this.withArm(async (arm) => {
      const res = await arm.connectDevice(category, subtype, opts)
      if (!res.ok && res.error) {
        return { ...res, error: formatArmError(res.error) }
      }
      return res
    })
  }

  /** 断开当前末端设备。 */
  disconnectDevice(deviceId?: string): Promise<{ ok: boolean }> {
    return this.withArm((arm) => arm.disconnectDevice(deviceId))
  }

  /** 查询当前末端设备状态。 */
  getActiveDevice(deviceId?: string): Promise<ActiveDeviceInfo> {
    return this.withArm((arm) => arm.getActiveDevice(deviceId))
  }

  /** 查询当前末端设备的控制面板 manifest，未连接时返回 null。 */
  getDeviceManifest(deviceId?: string): Promise<any | null> {
    return this.withArm((arm) => arm.getDeviceManifest(deviceId))
  }

  /** 获取控制器 YAML 配置文件内容 */
  getConfigYaml(): Promise<{ yaml_content: string; file_path?: string; parsed?: Record<string, unknown> }> {
    return this.withArm((arm) => arm.getConfigYaml())
  }

  /** 更新控制器 YAML 配置文件内容并生效 */
  setConfigYaml(content: string): Promise<{ ok: boolean; error?: string }> {
    return this.withArm((arm) => arm.setConfigYaml(content))
  }

  /** Run an arbitrary SDK call against the live connection; rejects while disconnected. */
  withArm<T>(fn: (arm: Arm) => Promise<T>): Promise<T> {
    if (!this.arm) return Promise.reject(new Error('机械臂未连接'))
    try {
      return Promise.resolve(fn(this.arm))
    } catch (err) {
      return Promise.reject(err)
    }
  }

  private _openSocket() {
    this._stopPolling()
    this.arm?.close()
    this._state = null
    this._lastRawState = null
    this._cachedNormalizedState = null
    this._notifyState()
    // 新连接会作废所有在途 RPC（旧 socket 的 pending 不会被 reject），
    // 因此运动锁必须在这里释放，否则会永久卡在 busy。
    this._setMotionBusy(false)
    this._setStatus(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting')
    const arm = new Arm(this.endpoint, this.token)
    this.arm = arm
    arm
      .connect()
      .then(() => {
        if (this.arm !== arm) return // superseded by a later connect()/disconnect()
        this.reconnectAttempt = 0
        this._lastError = null
        this._setStatus('connected')
        this._startPolling()
      })
      .catch((err: unknown) => {
        if (this.arm !== arm) return
        this._lastError = formatArmError(err)
        this._setStatus('error')
        this._scheduleReconnect()
      })
  }

  private _scheduleReconnect() {
    if (this.manualDisconnect) return
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      if (this.manualDisconnect) return
      this._openSocket()
    }, delay)
  }

  private _startPolling() {
    const tick = () => {
      const arm = this.arm
      if (!arm) return
      if (!arm.connected) {
        this._stopPolling()
        this._state = null
        this._lastRawState = null
        this._cachedNormalizedState = null
        this._notifyState()
        if (!this.manualDisconnect) {
          this._setStatus('reconnecting')
          this._scheduleReconnect()
        }
        return
      }
      const rawNext = arm.getState()
      if (rawNext !== this._lastRawState) {
        this._lastRawState = rawNext
        this._cachedNormalizedState = normalizeRobotState(rawNext)
      }
      const next = this._cachedNormalizedState
      if (next !== this._state) {
        const prev = this._state
        this._state = next
        // 高速消费方（3D 预览）每帧跟随，不受降频影响。
        for (const l of this.stateFastListeners) l()
        // 安全相关字段（状态机/驱动故障/看门狗/反馈超时）变化要立即通知，
        // 普通遥测最多每 100ms 通知一次，避免 60Hz 全页重渲染。
        const now = performance.now()
        const significant =
          !prev ||
          !next ||
          prev.state !== next.state ||
          !arraysEqual(prev.errs, next.errs) ||
          prev.watchdog?.tripped !== next.watchdog?.tripped ||
          !arraysEqual(prev.feedback?.staleJoints, next.feedback?.staleJoints)
        if (significant || now - this._lastStateNotify >= ArmClient.STATE_NOTIFY_INTERVAL_MS) {
          this._lastStateNotify = now
          this._notifyState()
        }
      }
      this.pollHandle = requestAnimationFrame(tick)
    }
    this.pollHandle = requestAnimationFrame(tick)
  }

  private _stopPolling() {
    if (this.pollHandle != null) {
      cancelAnimationFrame(this.pollHandle)
      this.pollHandle = null
    }
  }

  private _setStatus(s: ConnectionStatus) {
    if (this._status === s) return
    this._status = s
    for (const l of this.statusListeners) l()
  }

  private _notifyState() {
    for (const l of this.stateListeners) l()
  }

  /**
   * 运动互斥：上一运动 RPC 未返回时拒绝新的运动指令。
   * 竞态来源是 UI 在 movej/movel/回放进行中仍可再次下发指令，
   * 服务端会收到并发的运动请求；这里在客户端直接拦截。
   * 注意锁的持有时间 = RPC 生命周期：服务端 movej/movel 默认带 settle_s
   * （到位后额外持位验证），机械臂物理上已停稳但 RPC 未返回时锁仍占用。
   * 因此 UI 驱动的短运动（滑条/回零点/点动）应显式传 settle_s: 0，
   * 让锁在"物理到位"那一刻释放，而不是等默认的 1s 持位期结束。
   */
  private async _guardMotion<T>(fn: () => Promise<T>): Promise<T> {
    if (this._motionPending) {
      throw new Error('机械臂正在运动，请等待当前动作完成')
    }
    this._setMotionBusy(true)
    try {
      return await fn()
    } finally {
      this._setMotionBusy(false)
    }
  }

  private _setMotionBusy(v: boolean) {
    if (this._motionPending === v) return
    this._motionPending = v
    for (const l of this.motionListeners) l()
  }
}

/** Single app-wide connection — mirrors the SDK's own one-arm-per-page-session model. */
export const armClient = new ArmClient()
export type { RobotState }

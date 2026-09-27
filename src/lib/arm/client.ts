import { formatArmError } from './errors'
import type { DaemonErrorInfo } from './errors'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'

/** daemon `conn` 帧的连接信息（计划 3.1）。 */
export type ConnInfo = {
  status: string
  port: string | null
  firmware: string
  n: number
  cart: boolean
  error: string | null
}

/** daemon `state` 帧归一化后的机械臂状态（计划 3.3）。 */
export type RobotState = {
  q: number[]
  dq: number[]
  tau: number[]
  errs: number[]
  temps: { mosTemp: number; coilTemp: number }[]
  fault: { joint: number; errCode: number }[]
  mode: number
  modeName: string
  flags: number
  flagNames: string[]
  jointFault: number
  faultAxes: number[]
  enabled: boolean
  cartBusy: boolean
  faulted: boolean
  faultDetail: string
  seq: number
  state: string
}

/** SDK 原生 6 元组 `[x, y, z, rx, ry, rz]`（计划 3.4）。 */
export type Pose6 = [number, number, number, number, number, number]

/** `get_joint_params` 单轴参数（键名与 SDK 一致，snake_case）。 */
export type JointParams = {
  idx: number
  kp: number
  kd: number
  tau_max: number
  q_min: number
  q_max: number
}

type Listener = () => void

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000]

function arraysEqual(a: number[] | undefined, b: number[] | undefined) {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function num(v: unknown): number {
  return typeof v === 'number' && !Number.isNaN(v) ? v : 0
}

function numArray(v: unknown): number[] {
  return Array.isArray(v) ? v.map(num) : []
}

/**
 * 归一化 daemon 的 `state` 帧：保证消费方拿到的数组与数值字段均有效存在，
 * 缺失字段退化为空数组/零，杜绝渲染崩溃。daemon 正常情况下字段齐全。
 */
export function normalizeRobotState(raw: RobotState | null | undefined): RobotState | null {
  if (!raw) return null
  return {
    q: numArray(raw.q),
    dq: numArray(raw.dq),
    tau: numArray(raw.tau),
    errs: numArray(raw.errs),
    temps: Array.isArray(raw.temps)
      ? raw.temps.map((t) => ({ mosTemp: num(t?.mosTemp), coilTemp: num(t?.coilTemp) }))
      : [],
    fault: Array.isArray(raw.fault)
      ? raw.fault.map((f) => ({ joint: num(f?.joint), errCode: num(f?.errCode) }))
      : [],
    mode: num(raw.mode),
    modeName: typeof raw.modeName === 'string' ? raw.modeName : '',
    flags: num(raw.flags),
    flagNames: Array.isArray(raw.flagNames) ? raw.flagNames.map(String) : [],
    jointFault: num(raw.jointFault),
    faultAxes: numArray(raw.faultAxes),
    enabled: raw.enabled === true,
    cartBusy: raw.cartBusy === true,
    faulted: raw.faulted === true,
    faultDetail: typeof raw.faultDetail === 'string' ? raw.faultDetail : '',
    seq: num(raw.seq),
    state: typeof raw.state === 'string' ? raw.state : 'disabled',
  }
}

/** 从当前页面推导本地 daemon 的 WebSocket 地址（https 页面用 wss）。 */
function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws`
}

/** 命令被 daemon 拒绝时抛出的 Error，`err` 携带结构化错误信息。 */
export type ArmCommandError = Error & { err: DaemonErrorInfo }

/**
 * 拥有全应用唯一的 daemon WebSocket 连接：
 * 下行接收 hello/conn/state/res，上行发送 connect/disconnect/cmd。
 * status 与 state 两个独立的订阅通道，只关心连接状态的 UI（TopBar）不会
 * 因为每个状态帧重渲染。
 */
export class ArmClient {
  private socket: WebSocket | null = null
  private manualDisconnect = true
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  private _lastStateNotify = 0
  private _lastRawState: unknown = null
  private _cachedNormalizedState: RobotState | null = null

  /** 遥测状态（关节角/温度/力矩等）的最大通知频率：daemon 约 10Hz 推送，
   *  安全相关字段（状态串/故障）变化立即通知，其余最多每 100ms 一次。 */
  private static readonly STATE_NOTIFY_INTERVAL_MS = 100

  private _status: ConnectionStatus = 'disconnected'
  private _conn: ConnInfo | null = null
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
  get conn() {
    return this._conn
  }
  get state() {
    return this._state
  }
  get lastError() {
    return this._lastError
  }

  /** True while a motion command (home/movej/movel) is in flight. */
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

  /** 每个状态帧触发的订阅，只给命令式消费方用（如 3D 预览），不进 React 渲染循环。 */
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

  /** 连接本地 daemon（无参：URL 由当前页面推导）。 */
  connect() {
    // 已连接/连接中时忽略重复点击；重连退避期间（reconnecting）允许取消
    // 当前定时器并立即重试，用户点击「连接」不必等最长 30s 的退避结束。
    if (
      !this.manualDisconnect &&
      (this._status === 'connecting' || this._status === 'connected')
    ) {
      return
    }
    this.manualDisconnect = false
    this.reconnectAttempt = 0
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this._openSocket()
  }

  /** 断开：通知 daemon 断开机械臂，并关闭本地 WebSocket。 */
  disconnect() {
    this.manualDisconnect = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const ws = this.socket
    if (ws && ws.readyState === WebSocket.OPEN) {
      this._sendFrame({ t: 'disconnect' })
    }
    this._closeSocket()
    this._rejectAllPending('连接已断开')
    this._clearState()
    this._setMotionBusy(false)
    this._conn = null
    this._setStatus('disconnected')
  }

  /**
   * 停止当前运动（急停）：降能量方向，永远可达。
   *
   * ⚠ **不许在这里吞掉拒绝**：`.catch(() => {})` 会让「按住 STOP 但 daemon 拒绝
   * （未连接 / 运动互斥 / 链路故障）」变成完全静默 —— 操作员以为停了，其实没停。
   * 调用方（`useArmConnection`）负责把拒绝变成可见提示。
   */
  requestStop(): Promise<unknown> {
    return this._sendCmd('estop')
  }

  // ─────────────────────────── 命令方法 ───────────────────────────

  async enable(): Promise<unknown> {
    return this._sendCmd('enable')
  }

  async disable(): Promise<unknown> {
    return this._sendCmd('disable')
  }

  async estop(): Promise<unknown> {
    return this._sendCmd('estop')
  }

  async clearFaults(): Promise<unknown> {
    return this._sendCmd('clear_faults')
  }

  async reset(): Promise<unknown> {
    return this._sendCmd('reset')
  }

  /** 固件低速度回零——运动中禁止再次发起。 */
  home(): Promise<unknown> {
    return this._guardMotion(() => this._sendCmd('home'))
  }

  /** 关节运动——运动中禁止再次发起，避免并发指令竞态。 */
  movej(q: number[], speed?: number): Promise<unknown> {
    return this._guardMotion(() => this._sendCmd('movej', speed == null ? { q } : { q, speed }))
  }

  /** 笛卡尔直线运动（6 元组位姿），运动中禁止再次发起。 */
  movel(pose: Pose6, speed?: number): Promise<unknown> {
    return this._guardMotion(() => this._sendCmd('movel', speed == null ? { pose } : { pose, speed }))
  }

  async setSpeed(percent: number): Promise<unknown> {
    return this._sendCmd('set_speed', { percent: Math.round(percent) })
  }

  getTcpPose(): Promise<Pose6> {
    return this._sendCmd('get_tcp') as Promise<Pose6>
  }

  ik(pose: Pose6): Promise<Pose6> {
    return this._sendCmd('ik', { pose }) as Promise<Pose6>
  }

  async zeroGStart(): Promise<unknown> {
    return this._sendCmd('zero_g_start')
  }

  async zeroGStop(): Promise<unknown> {
    return this._sendCmd('zero_g_stop')
  }

  getJointParams(): Promise<JointParams[]> {
    return this._sendCmd('get_joint_params') as Promise<JointParams[]>
  }

  // ───────────────── 参数 / 标定 / 自检（设置页用，计划 §5「直接接线」） ─────────────────
  // ⚠ 前馈 item 编号不是猜的（见 daemon `session.py` 与 SDK `arm.py`）：
  //   4 = 载荷质量, 5 = 质心(sub 0..2), 6 = 重力向量(sub 0..2),
  //   7 = 重力系数(7 值), 8 = 惯量系数(7 值)。

  /** 载荷质量 + 质心。⚠ 固件会**静默钳幅**（质量夹到 0、质心夹到 ±1），
   *  要拿到真正生效的值必须读回 —— 见 `readPayload()`。 */
  async setPayload(mass: number, com: [number, number, number]): Promise<unknown> {
    return this._sendCmd('set_payload', { mass, com })
  }

  /** 读回生效的载荷质量与质心（固件钳幅后的真值）。 */
  async readPayload(): Promise<{ mass: number; com: [number, number, number] }> {
    const [mass, x, y, z] = await Promise.all([
      this._ffScalar(4, 0),
      this._ffScalar(5, 0),
      this._ffScalar(5, 1),
      this._ffScalar(5, 2),
    ])
    return { mass, com: [x, y, z] }
  }

  async setGravityScale(values: number[]): Promise<unknown> {
    return this._sendCmd('set_gravity_scale', { values })
  }

  async readGravityScale(): Promise<number[]> {
    return this._ffVec(7)
  }

  async setInertiaScale(values: number[]): Promise<unknown> {
    return this._sendCmd('set_inertia_scale', { values })
  }

  async readInertiaScale(): Promise<number[]> {
    return this._ffVec(8)
  }

  async setGravityVector(g: [number, number, number]): Promise<unknown> {
    return this._sendCmd('set_gravity_vector', { g })
  }

  async readGravityVector(): Promise<[number, number, number]> {
    const [x, y, z] = await Promise.all([
      this._ffScalar(6, 0),
      this._ffScalar(6, 1),
      this._ffScalar(6, 2),
    ])
    return [x, y, z]
  }

  /** 逐轴 MIT 刚度/阻尼/力矩钳幅（RAM，需 `saveParams()` 才持久化）。 */
  async setJointParam(idx: number, kp: number, kd: number, tau_max: number): Promise<unknown> {
    return this._sendCmd('set_joint_param', { idx, kp, kd, tau_max })
  }

  /** 逐轴软限位（RAM，需 `saveParams()` 才持久化）。 */
  async setJointLimits(idx: number, qMin: number, qMax: number): Promise<unknown> {
    return this._sendCmd('set_joint_limits', { idx, q_min: qMin, q_max: qMax })
  }

  /** 持久化到 flash。⚠ 固件要求**失能态**；daemon 不代劳 `disable()`，拒绝会原样回传。 */
  async saveParams(): Promise<unknown> {
    return this._sendCmd('save_params')
  }

  /** 恢复出厂参数。⚠ 同上，固件要求失能态。 */
  async resetFactoryParams(): Promise<unknown> {
    return this._sendCmd('reset_factory_params')
  }

  /** 固件运动学自检 + 链路诊断计数（CRC 错、FIFO 丢帧）。 */
  kinBench(): Promise<unknown> {
    return this._sendCmd('kin_bench')
  }

  private async _ffScalar(item: number, sub: number): Promise<number> {
    const v = await this._sendCmd('get_ff_scalar', { item, sub })
    return typeof v === 'number' ? v : Number(v) || 0
  }

  private async _ffVec(item: number): Promise<number[]> {
    const v = await this._sendCmd('get_ff_vec', { item })
    return Array.isArray(v) ? v.map((x) => (typeof x === 'number' ? x : Number(x) || 0)) : []
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  private _openSocket() {
    this._closeSocket()
    this._clearState()
    // 新连接会作废所有在途 RPC，运动锁必须在这里释放，否则会永久卡在 busy。
    this._setMotionBusy(false)
    this._setStatus(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting')

    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl())
    } catch (err) {
      this._lastError = formatArmError(err)
      this._setStatus('error')
      this._scheduleReconnect()
      return
    }
    this.socket = ws

    ws.onopen = () => {
      if (this.socket !== ws) return
      // 请求 daemon 连接机械臂；失败原因由后续 `conn` 帧的 error 字段报告。
      this._sendFrame({ t: 'connect' })
    }
    ws.onmessage = (ev: MessageEvent) => {
      if (this.socket !== ws) return
      this._handleMessage(ev.data)
    }
    ws.onclose = () => {
      if (this.socket !== ws) return
      this.socket = null
      this._rejectAllPending('本地程序连接已断开')
      this._clearState()
      this._setMotionBusy(false)
      if (this.manualDisconnect) {
        this._setStatus('disconnected')
        return
      }
      this._setStatus('reconnecting')
      this._scheduleReconnect()
    }
  }

  private _closeSocket() {
    const ws = this.socket
    this.socket = null
    if (!ws) return
    ws.onopen = null
    ws.onmessage = null
    ws.onclose = null
    try {
      ws.close()
    } catch {
      // 关闭失败无碍：引用已摘除。
    }
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

  private _handleMessage(data: unknown) {
    if (typeof data !== 'string') return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(data) as Record<string, unknown>
    } catch {
      return
    }
    switch (msg.t) {
      case 'hello':
        break
      case 'conn':
        this._applyConn(msg)
        break
      case 'state':
        this._applyState(msg.state as RobotState | null | undefined)
        break
      case 'res':
        this._resolvePending(msg)
        break
      default:
        break
    }
  }

  private _applyConn(msg: Record<string, unknown>) {
    const conn: ConnInfo = {
      status: typeof msg.status === 'string' ? msg.status : 'disconnected',
      port: typeof msg.port === 'string' ? msg.port : null,
      firmware: typeof msg.firmware === 'string' ? msg.firmware : '',
      n: num(msg.n),
      cart: msg.cart === true,
      error: typeof msg.error === 'string' ? msg.error : null,
    }
    this._conn = conn
    if (conn.status === 'connected') {
      this.reconnectAttempt = 0
      this._lastError = null
    } else if (conn.error) {
      this._lastError = conn.error
    }
    const mapped: ConnectionStatus =
      conn.status === 'connected'
        ? 'connected'
        : conn.status === 'connecting'
          ? 'connecting'
          : conn.status === 'error'
            ? 'error'
            : 'disconnected'
    this._setStatus(mapped)
  }

  private _applyState(raw: RobotState | null | undefined) {
    if (raw !== this._lastRawState) {
      this._lastRawState = raw
      this._cachedNormalizedState = normalizeRobotState(raw)
    }
    const next = this._cachedNormalizedState
    if (next === this._state) return
    const prev = this._state
    this._state = next
    // 命令式消费方（3D 预览）每帧跟随。
    for (const l of this.stateFastListeners) l()
    // 状态串/故障变化立即通知，普通遥测最多每 100ms 通知一次。
    const now = performance.now()
    const significant =
      !prev ||
      !next ||
      prev.state !== next.state ||
      prev.faulted !== next.faulted ||
      !arraysEqual(prev.errs, next.errs)
    if (significant || now - this._lastStateNotify >= ArmClient.STATE_NOTIFY_INTERVAL_MS) {
      this._lastStateNotify = now
      this._notifyState()
    }
  }

  private _resolvePending(msg: Record<string, unknown>) {
    const id = msg.id
    if (typeof id !== 'number') return
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    if (msg.ok === true) {
      entry.resolve(msg.v)
      return
    }
    const info = (msg.err && typeof msg.err === 'object' ? msg.err : {}) as DaemonErrorInfo
    const detail = typeof info.msg === 'string' && info.msg ? info.msg : '命令执行失败'
    const error = new Error(detail) as ArmCommandError
    error.err = info
    entry.reject(error)
  }

  private _sendCmd(m: string, p?: Record<string, unknown>): Promise<unknown> {
    const ws = this.socket
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('本地程序未连接'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const sent = this._sendFrame({ t: 'cmd', id, m, p: p ?? {} })
      if (!sent) {
        this.pending.delete(id)
        reject(new Error('本地程序未连接'))
      }
    })
  }

  private _sendFrame(frame: Record<string, unknown>): boolean {
    const ws = this.socket
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    try {
      ws.send(JSON.stringify(frame))
      return true
    } catch {
      return false
    }
  }

  private _rejectAllPending(reason: string) {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) entry.reject(new Error(reason))
  }

  private _clearState() {
    this._state = null
    this._lastRawState = null
    this._cachedNormalizedState = null
    this._notifyState()
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
   * 运动互斥：上一运动命令未返回时拒绝新的运动指令（daemon 侧也有同样的判定，
   * 这里提前拦截，避免 UI 在上一条在途时再下发）。
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

/** 全应用唯一连接。 */
export const armClient = new ArmClient()

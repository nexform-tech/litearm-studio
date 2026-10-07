import { armClient } from './client'
import { DaemonSocket } from './socket'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

/** 夹爪的标定来源（daemon `gripper_conn.source`，§4.1）。 */
export type CalibrationSource = 'measured' | 'template' | 'factory' | 'missing'

/** daemon `gripper_conn` 帧的连接信息（§4.1）。 */
export type GripperConnInfo = {
  status: string
  channel: string
  canId: number
  /** 设备**实际**在跑的方向（从生效的限位读回）。 */
  mount: 'normal' | 'reverse'
  /** 记录里那行声明，与 `mount` 并排显示，好让两者能对比。 */
  declaredMount: 'normal' | 'reverse'
  template: string | null
  source: CalibrationSource | null
  path: string | null
  travelMm: number
  /** 是否已确认「允许出厂标定」（持久化在通道记录里）。 */
  allowFactory: boolean
  /** 生效标定的闭合角（rad），没有可用限位时为 `null`。 */
  closedRad: number | null
  /** 生效标定的张开角（rad）。 */
  openRad: number | null
  /** 文件自带的系数（推导值见状态帧的 mm 读数）。 */
  fileRadToMm: number | null
  error: string | null
  /** 闸门状态：READY / TEMPLATE / FACTORY / BLOCKED。 */
  gate: string | null
  gateReason: string
}

/** daemon `gripper_state` 帧（§4.1）。 */
export type GripperState = {
  /** `null` = 本次使能后还没收到过状态帧；**必须**渲染成"未知"而不是 0。 */
  positionMm: number | null
  forceN: number
  torqueNm: number
  velocityMmS: number
  enabled: boolean
  state: string
  errorCode: number
  temps: { mosTemp: number; coilTemp: number }
  fresh: boolean
  gate: string | null
  gateReason: string
}

/** daemon `gripper_calib` 帧：一次探测的进度（§4.1）。 */
export type GripperCalibProgress = {
  probe: string
  phase: string
  step: number
  total: number
  progress: number
  detail: string
}

/**
 * daemon `gripper_alert` 帧：tick 线程上的拒绝/故障，没有 `res` 可回的那一半。
 *
 * `kind` 是**线上错误类名**（与 `res` 帧的 `err.kind` 同一套）。有它就能翻译；
 * 没有（daemon 推不出可翻译的类别）时显示 `text` —— 诊断原文，中文。
 */
export type GripperAlert = {
  level: 'info' | 'warn' | 'error' | 'fatal' | string
  text: string
  kind?: string
  code?: number
}

/** daemon `gripper_busy` 帧：一次阻塞调用正在进行。 */
export type GripperBusy = { busy: boolean; what: string }

/** `gripper.list_calibrations` 的一项。 */
export type CalibrationCandidate = {
  path: string
  source: CalibrationSource
  provenance: string
  template: string | null
  channel: string
  valid: boolean
  problems: string[]
  warnings: string[]
  closedRad: number | null
  openRad: number | null
  fileRadToMm: number | null
  mount: 'normal' | 'reverse' | null
  selected?: boolean
  /** daemon 说这一份正在生效（不总是候选之一，见 daemon 侧的说明）。 */
  inUse?: boolean
}

/** `gripper.list_dir` 的一项：一个子目录，或一个 `*.json` 文件。 */
export type BrowseEntry = {
  name: string
  path: string
  type: 'dir' | 'file'
  /** 能否进入（目录）/ 能否读取（文件）—— 界面据此置灰、禁点。 */
  readable: boolean
  symlink?: boolean
  /** 仅 `type === 'file'`：文件元数据 + `candidate_dict` 的全部字段。 */
  size?: number
  mtime?: number
  source?: CalibrationSource
  provenance?: string
  template?: string | null
  channel?: string
  valid?: boolean
  problems?: string[]
  warnings?: string[]
  closedRad?: number | null
  openRad?: number | null
  fileRadToMm?: number | null
  mount?: 'normal' | 'reverse' | null
  /** daemon 说这一份正在生效（同 `list_calibrations` 的 `inUse`）。 */
  inUse?: boolean
}

/** `gripper.list_dir` 的答复。 */
export type BrowseListing = {
  /** 实际列举的绝对目录 —— 前端以此为准做导航。 */
  path: string
  /** 上级目录；文件系统根为 `null`。 */
  parent: string | null
  /** 条目数命中上限（daemon 侧截断），界面应告知操作员。 */
  truncated: boolean
  entries: BrowseEntry[]
}

/**
 * 这个条目是不是一份可渲染的标定候选（`type === 'file'` 且带校验结论）。
 *
 * 目录行与文件行的形状不同，靠 `valid` 是否存在来分流 —— `CalibrationRow` 只吃后者。
 */
export function hasCandidate(e: BrowseEntry): e is BrowseEntry & CalibrationCandidate {
  return e.type === 'file' && typeof e.valid === 'boolean'
}

/** `gripper.set_motion` 的答复：**已经生效**的设置。 */
export type MotionSettings = { speedMmS: number; forceN: number }

type Listener = () => void

function num(v: unknown): number {
  return typeof v === 'number' && !Number.isNaN(v) ? v : 0
}

function optionalNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

/** 装配方向没有"未声明"这一态：daemon 永远给一个方向，缺字段时按默认的正装。 */
function mount(v: unknown): 'normal' | 'reverse' {
  return v === 'reverse' ? 'reverse' : 'normal'
}

/** 夹爪状态帧归一化：缺失字段退化为安全默认，`positionMm` 保持 `null` 语义。 */
export function normalizeGripperState(raw: unknown): GripperState | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const temps = (r.temps && typeof r.temps === 'object' ? r.temps : {}) as Record<string, unknown>
  return {
    positionMm: optionalNum(r.positionMm),
    forceN: num(r.forceN),
    torqueNm: num(r.torqueNm),
    velocityMmS: num(r.velocityMmS),
    enabled: r.enabled === true,
    state: str(r.state, 'disabled'),
    errorCode: num(r.errorCode),
    temps: { mosTemp: num(temps.mosTemp), coilTemp: num(temps.coilTemp) },
    fresh: r.fresh === true,
    gate: typeof r.gate === 'string' ? r.gate : null,
    gateReason: str(r.gateReason),
  }
}

/**
 * 夹爪客户端：与 `ArmClient` **共用同一条** daemon socket。
 *
 * daemon 的 `/ws` 是一个连接、一个命令 id 空间（§4.2），所以这里不自己开连接，
 * 只订阅 `gripper_*` 帧并发送 `gripper.*` 命令。连接本身由 `ArmClient` 那侧建立
 * （`main.tsx` 启动时就会连本机 daemon），本客户端只跟着同一条 socket。
 */
export class GripperClient {
  readonly socket: DaemonSocket

  private _conn: GripperConnInfo | null = null
  private _state: GripperState | null = null
  private _calib: GripperCalibProgress | null = null
  private _busy: GripperBusy = { busy: false, what: '' }

  private _lastStateNotify = 0
  private static readonly STATE_NOTIFY_INTERVAL_MS = 100

  private connListeners = new Set<Listener>()
  private stateListeners = new Set<Listener>()
  private calibListeners = new Set<Listener>()
  private alertListeners = new Set<(a: GripperAlert) => void>()
  private busyListeners = new Set<Listener>()

  constructor(socket: DaemonSocket) {
    this.socket = socket
    this.socket.onFrame('gripper_conn', (msg) => this._applyConn(msg))
    this.socket.onFrame('gripper_state', (msg) => this._applyState(msg.state))
    this.socket.onFrame('gripper_calib', (msg) => this._applyCalib(msg))
    this.socket.onFrame('gripper_alert', (msg) => this._emitAlert(msg))
    this.socket.onFrame('gripper_busy', (msg) => this._applyBusy(msg))
    // 传输层一动，夹爪的 conn/state 就都失效了：不保留最后一帧"已连接"，否则页面会
    // 在 daemon 已经断掉之后继续显示读数（重连握手时 daemon 会重发 `gripper_conn`）。
    this.socket.onLifecycle(() => {
      if (!this._conn && !this._state) return
      this._conn = null
      this._state = null
      this._busy = { busy: false, what: '' }
      this._emitConn()
      this._emitState()
    })
  }

  get conn() {
    return this._conn
  }
  get state() {
    return this._state
  }
  get calib() {
    return this._calib
  }
  get busy() {
    return this._busy
  }

  /** 夹爪这一侧的连接状态（`gripper_conn.status`）。 */
  get status(): ConnectionStatus {
    const s = this._conn?.status
    return s === 'connected' || s === 'connecting' || s === 'error' ? s : 'disconnected'
  }

  /** 这一版进程有没有夹爪会话：`gripper_conn` 出现过即为有。 */
  get present() {
    return this._conn != null
  }

  subscribeConn = (cb: Listener) => {
    this.connListeners.add(cb)
    return () => {
      this.connListeners.delete(cb)
    }
  }

  subscribeState = (cb: Listener) => {
    this.stateListeners.add(cb)
    return () => {
      this.stateListeners.delete(cb)
    }
  }

  subscribeCalib = (cb: Listener) => {
    this.calibListeners.add(cb)
    return () => {
      this.calibListeners.delete(cb)
    }
  }

  subscribeAlert = (cb: (a: GripperAlert) => void) => {
    this.alertListeners.add(cb)
    return () => {
      this.alertListeners.delete(cb)
    }
  }

  subscribeBusy = (cb: Listener) => {
    this.busyListeners.add(cb)
    return () => {
      this.busyListeners.delete(cb)
    }
  }

  // ─────────────────────────── 命令方法 ───────────────────────────

  /** 连接夹爪。可选覆盖通道/ID/装配方向（都会持久化到该通道的记录里）。 */
  connect(params: { channel?: string; canId?: number; mstId?: number; mount?: 'normal' | 'reverse' } = {}) {
    return this._cmd('gripper.connect', params)
  }

  disconnect() {
    return this._cmd('gripper.disconnect')
  }

  listChannels(): Promise<string[]> {
    return this._cmd('gripper.list_channels') as Promise<string[]>
  }

  enable() {
    return this._cmd('gripper.enable')
  }

  disable() {
    return this._cmd('gripper.disable')
  }

  clearFault() {
    return this._cmd('gripper.clear_fault')
  }

  open() {
    return this._cmd('gripper.open')
  }

  close() {
    return this._cmd('gripper.close')
  }

  /** 夹取。`holdS` 给定时到点自动放开（零重力，仍使能）。 */
  grasp(params: { forceN?: number; holdS?: number } = {}) {
    return this._cmd('gripper.grasp', params)
  }

  moveTo(targetMm: number, speedMmS?: number) {
    return this._cmd('gripper.move_to', speedMmS == null ? { targetMm } : { targetMm, speedMmS })
  }

  /** 零重力：零力矩、仍使能、可反驱。 */
  release() {
    return this._cmd('gripper.release')
  }

  /** 急停。⚠ daemon 在 WS 读循环上直接处理，不排队（§4.2）。 */
  stop() {
    return this._cmd('gripper.stop')
  }

  resetStop() {
    return this._cmd('gripper.reset_stop')
  }

  setMotion(params: { speedMmS?: number; forceN?: number }): Promise<MotionSettings> {
    return this._cmd('gripper.set_motion', params) as Promise<MotionSettings>
  }

  loadTemplate(mount: 'normal' | 'reverse'): Promise<{ mount: string; source: string }> {
    return this._cmd('gripper.load_template', { mount }) as Promise<{ mount: string; source: string }>
  }

  listCalibrations(): Promise<CalibrationCandidate[]> {
    return this._cmd('gripper.list_calibrations') as Promise<CalibrationCandidate[]>
  }

  importCalibration(path: string): Promise<{ path: string; source: string }> {
    return this._cmd('gripper.import_calibration', { path }) as Promise<{ path: string; source: string }>
  }

  /**
   * 列举**控制机**某个目录下的子目录与 `*.json` 标定，并逐个校验。
   *
   * 不给 `path` → 起始目录是 daemon 用户的家目录。免连接（与 `list_calibrations`
   * 同理：列举是文件系统问题，设置页连接之前就要问）。
   */
  listDir(path?: string): Promise<BrowseListing> {
    return this._cmd('gripper.list_dir', path ? { path } : {}) as Promise<BrowseListing>
  }

  /**
   * 引导式实测。**没有超时**：它要顶两次机械限位，几十秒是正常的，而客户端这条
   * 路径本来就没有 60s 兜底（§4.2 要求客户端不要给它设 60s 超时）。
   */
  zero(travelMm: number): Promise<{
    closedRad: number
    openRad: number
    radToMm: number
    source: string
    warnings: string[]
  }> {
    return this._cmd('gripper.zero', { travelMm }) as Promise<{
      closedRad: number
      openRad: number
      radToMm: number
      source: string
      warnings: string[]
    }>
  }

  setAllowFactory(allow: boolean): Promise<{ allowFactory: boolean }> {
    return this._cmd('gripper.set_allow_factory', { allow }) as Promise<{ allowFactory: boolean }>
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  private _cmd(m: string, p?: Record<string, unknown>): Promise<unknown> {
    return this.socket.sendCmd(m, p)
  }

  private _applyConn(msg: Record<string, unknown>) {
    this._conn = {
      status: str(msg.status, 'disconnected'),
      channel: str(msg.channel),
      canId: num(msg.canId),
      mount: mount(msg.mount),
      declaredMount: mount(msg.declaredMount),
      template: typeof msg.template === 'string' ? msg.template : null,
      source:
        msg.source === 'measured' || msg.source === 'template' || msg.source === 'factory'
          ? msg.source
          : msg.source === 'missing'
            ? 'missing'
            : null,
      path: typeof msg.path === 'string' ? msg.path : null,
      travelMm: num(msg.travelMm),
      allowFactory: msg.allowFactory === true,
      closedRad: optionalNum(msg.closedRad),
      openRad: optionalNum(msg.openRad),
      fileRadToMm: optionalNum(msg.fileRadToMm),
      error: typeof msg.error === 'string' ? msg.error : null,
      gate: typeof msg.gate === 'string' ? msg.gate : null,
      gateReason: str(msg.gateReason),
    }
    this._emitConn()
  }

  private _applyState(raw: unknown) {
    const next = normalizeGripperState(raw)
    const prev = this._state
    if (next === prev) return
    this._state = next
    // 安全相关的字段变化立即通知；其余读数最多每 100ms 一次（50Hz 全灌 React
    // 只会让整页每 20ms 重渲染一次，而操作员看不出差别）。
    const significant =
      !prev ||
      !next ||
      prev.state !== next.state ||
      prev.enabled !== next.enabled ||
      prev.errorCode !== next.errorCode ||
      prev.gate !== next.gate
    const now = performance.now()
    if (significant || now - this._lastStateNotify >= GripperClient.STATE_NOTIFY_INTERVAL_MS) {
      this._lastStateNotify = now
      this._emitState()
    }
  }

  private _applyCalib(msg: Record<string, unknown>) {
    this._calib = {
      probe: str(msg.probe, 'zero'),
      phase: str(msg.phase),
      step: num(msg.step),
      total: num(msg.total),
      progress: num(msg.progress),
      detail: str(msg.detail),
    }
    for (const l of [...this.calibListeners]) l()
  }

  private _applyBusy(msg: Record<string, unknown>) {
    this._busy = { busy: msg.busy === true, what: str(msg.what) }
    for (const l of [...this.busyListeners]) l()
  }

  private _emitAlert(msg: Record<string, unknown>) {
    const alert: GripperAlert = {
      level: str(msg.level, 'info'),
      text: str(msg.text),
      kind: typeof msg.kind === 'string' && msg.kind ? msg.kind : undefined,
      code: typeof msg.code === 'number' ? msg.code : undefined,
    }
    for (const l of [...this.alertListeners]) l(alert)
  }

  private _emitConn() {
    for (const l of [...this.connListeners]) l()
  }

  private _emitState() {
    for (const l of [...this.stateListeners]) l()
  }
}

/**
 * 全应用唯一的夹爪客户端 —— 与 `armClient` **共用一条** socket。
 *
 * 建在这里而不是 `index.ts`：它需要一个已经存在的 `armClient`，而 `client.ts`
 * 反过来不认识夹爪（一个方向的依赖，不会成环）。
 */
export const gripperClient = new GripperClient(armClient.socket)

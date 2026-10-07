import type { CommandError } from './socket'
import { DaemonSocket } from './socket'
import {
  fileToBase64,
  normalizeFirmwareProgress,
  normalizeFirmwareResult,
  normalizeFirmwareStatus,
} from './firmware'
import type {
  FirmwareImageSummary,
  FirmwareProgress,
  FirmwareResult,
  FirmwareStatus,
} from './firmware'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error' | 'upgrading'

/** daemon `conn` 帧的连接信息（计划 3.1）。 */
export type ConnInfo = {
  status: string
  port: string | null
  firmware: string
  n: number
  cart: boolean
  error: string | null
}

/**
 * daemon `hello` 帧的版本信息。
 *
 * ⚠ 它只在**握手时**来一条，所以必须自己存下来 —— 激活时要把它随诊断信息一起发给服务端，
 * 而那时早就过了握手那一刻。
 */
export type HelloInfo = {
  daemon: string
  sdk: string
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

/** 读到了授权记录时的形状（daemon `license` 命令，见 `docs/ACTIVATION.md`）。 */
export type LicenseRecord = {
  supported: true
  /** 固件原生的 state 码：0=未激活 / 1=已激活 / 2=已激活且产线模式。 */
  state: number
  /** `state` 的可读名；认不出的码带原值回（`unknown_state_7`）。 */
  stateName: string
  activated: boolean
  /** `flags` bit0 = 产线码。⚠ 它**不表示**激活与否，别拿它替代 `activated`。 */
  factoryMode: boolean
  /** 记录版本（固件当前 1）。 */
  ver: number
  /** 24 位小写 hex —— **厂商签发凭据时要的就是这一串**。 */
  uid: string
  custId: number
  /** 签发日 `YYYYMMDD`；未激活时恒 0。 */
  issued: number
  flags: number
}

/**
 * 授权记录的三态读取结果。
 *
 * `supported` 刻意**不是一个布尔** —— 三种情况对用户说的话完全不同：
 *  · `true`  —— 读到了记录（未激活也是正常返回，`activated === false`）；
 *  · `false` —— 固件明确回 `ERR{0x2F,0x00}`：这台固件没有授权命令（固件 1.8.0 起才有）；
 *  · `null`  —— 本次没读到。⚠ 今天旧固件走的就是这一条：SDK 的探测帧读不到那条 ERR，
 *              于是等满 1s 抛超时（见 daemon `session._license_dict` 的说明）。
 */
export type LicenseSnapshot = LicenseRecord | { supported: false } | { supported: null }

/**
 * 注册信息 —— 会随设备 UID 一起发给激活服务。
 *
 * ⚠ **字段集合以激活网站的表单为准**（`litearm-activation/src/lib/validation.ts`）：
 * `name` / `organization` 与网站表单的 `contactName` / `company` 是同一个输入框，
 * 其余六个键名与网站逐字相同。改这里必须同时改守护进程 `activation._CONTACT_RULES`
 * 与同意书（`ActivationConsent.tsx`）。
 */
export type ActivationContact = {
  name: string
  phone: string
  organization: string
  wechatId: string
  email: string
  region: string
  industry: string
  purpose: string
}

/**
 * 提交给激活服务的请求体。
 *
 * ⚠ 界面**不再**逐字渲染这个对象（"将要发送的内容"预览已去掉），字段的披露改由
 * 《激活注册信息同意书》逐项列出来承担（`ActivationConsent.tsx` 的 `CONSENT_ITEMS`）：
 * 字段增减必须同时改那份文案，不许在这里偷偷加东西。内网地址/主机名**刻意不采集** ——
 * IP 由服务端在收到请求时自己记，比客户端自报可信。
 */
export type ActivationRequest = {
  uid: string
  contact: ActivationContact
  /**
   * 只有**一份**同意（激活注册信息同意书），它覆盖请求里的每一项 —— 所以这里没有逐项开关。
   * `granted: false` 的请求会被本地程序当场拒（`consent_required`）：同意是硬门禁，判在
   * 守护进程那一层，界面上的按钮禁用只是方便。
   */
  consent: { granted: boolean }
  /** 版本号这类环境信息，与联系人字段在同一份同意书里逐项列出。 */
  diagnostics: { studio: string; sdk: string; firmware: string }
  /** 预留：订单号/激活码那一层。今天界面上没有这个输入框。 */
  code?: string
}

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

/** 命令被 daemon 拒绝时抛出的 Error，`err` 携带结构化错误信息。 */
export type ArmCommandError = CommandError

/**
 * 归一化 daemon 的 `license` 应答：认不出的形状一律折成"没读到"（`supported: null`）。
 *
 * ⚠ 判据是 `supported` 这个**显式**字段，不是"有没有 uid" —— 未激活的记录也回 UID，
 * 拿字段有无当判据会把"未激活"读成"读不到"。
 */
export function normalizeLicense(raw: unknown): LicenseSnapshot {
  if (!raw || typeof raw !== 'object') return { supported: null }
  const r = raw as Record<string, unknown>
  if (r.supported === false) return { supported: false }
  if (r.supported !== true) return { supported: null }
  return {
    supported: true,
    state: num(r.state),
    stateName: typeof r.stateName === 'string' ? r.stateName : '',
    activated: r.activated === true,
    factoryMode: r.factoryMode === true,
    ver: num(r.ver),
    uid: typeof r.uid === 'string' ? r.uid : '',
    custId: num(r.custId),
    issued: num(r.issued),
    flags: num(r.flags),
  }
}

/**
 * 拥有全应用唯一的 daemon WebSocket 连接：
 * 下行接收 hello/conn/state/res，上行发送 connect/disconnect/cmd。
 * status 与 state 两个独立的订阅通道，只关心连接状态的 UI（TopBar）不会
 * 因为每个状态帧重渲染。
 */
export class ArmClient {
  private _status: ConnectionStatus = 'disconnected'
  private _conn: ConnInfo | null = null
  private _state: RobotState | null = null
  private _motionPending = false

  private _lastStateNotify = 0
  private _lastRawState: unknown = null
  private _cachedNormalizedState: RobotState | null = null

  /** 遥测状态（关节角/温度/力矩等）的最大通知频率：daemon 约 10Hz 推送，
   *  安全相关字段（状态串/故障）变化立即通知，其余最多每 100ms 一次。 */
  private static readonly STATE_NOTIFY_INTERVAL_MS = 100

  private statusListeners = new Set<Listener>()
  private stateListeners = new Set<Listener>()
  private stateFastListeners = new Set<Listener>()
  private motionListeners = new Set<Listener>()
  // 固件升级的进度/终局走**广播帧**（不是 RPC 应答）—— 烧录可能几十秒，超过
  // daemon 的命令超时，而且进 DFU 之后没有会话可问。所以这里与 `state` 同形：
  // 一组订阅者，帧到了就通知。
  private firmwareProgressListeners = new Set<(p: FirmwareProgress) => void>()
  private firmwareResultListeners = new Set<(r: FirmwareResult) => void>()

  /** `hello` 帧只来一条，存下来供激活时填写诊断信息（见 `versions`）。 */
  private _hello: HelloInfo | null = null

  /** 操作员在端口下拉里选的口；`null` = 交给 daemon 自己解析。 */
  private _pendingPort: string | null = null

  /** 共用的 daemon socket。默认自建一条，`armClient` 用默认值；夹爪注入同一条。 */
  readonly socket: DaemonSocket

  constructor(socket: DaemonSocket = new DaemonSocket()) {
    this.socket = socket
    // 一次连接上就请求连接机械臂（夹爪不自动连：它由页面显式连）。
    // ⚠ 走 `_connectFrame()` 而不是写死 `{t:'connect'}`：socket 还没打开时操作员先选了
    //   口再点连接，这次选择会存在 `_pendingPort` 里，等到这一帧才发出去 —— 否则那次
    //   选择会被静默丢掉，daemon 连的是自动发现到的另一台。
    this.socket.onOpen(() => {
      this.socket.sendFrame(this._connectFrame())
    })
    this.socket.onFrame('conn', (msg) => this._applyConn(msg))
    this.socket.onFrame('hello', (msg) => this._applyHello(msg))
    this.socket.onFrame('state', (msg) => this._applyState(msg.state as RobotState | null | undefined))
    this.socket.onFrame('firmware_progress', (msg) => {
      const p = normalizeFirmwareProgress(msg)
      for (const l of [...this.firmwareProgressListeners]) l(p)
    })
    this.socket.onFrame('firmware_result', (msg) => {
      const r = normalizeFirmwareResult(msg)
      for (const l of [...this.firmwareResultListeners]) l(r)
    })
    this.socket.onLifecycle((s) => {
      if (s === 'connecting' || s === 'reconnecting' || s === 'error' || s === 'disconnected') {
        // 传输层一动，臂这边的状态就作废：daemon 会在下一次握手时重发 `conn`/`state`，
        // 在那之前最后一帧姿态属于一条没人在说话的链路。重构前这里也清（`_openSocket`
        // 开头 + `onclose`）—— 一个看起来"实时"的旧姿态/故障位比空白更危险，而
        // `GripperClient` 出于同样的理由也在清。
        this._clearState()
        this._setMotionBusy(false)
        this._setStatus(s)
      }
    })
  }

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
    return this.socket.lastError
  }

  /**
   * daemon 的版本信息（`hello` 帧）。
   *
   * ⚠ 只存不推：它一个进程生命周期里只有一条，没有订阅价值 —— 需要它的地方（激活时的
   * 诊断信息）在用到的那一刻现读。
   */
  get versions(): HelloInfo | null {
    return this._hello
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

  /** 连接本地 daemon（无参：URL 由当前页面推导）。
   *
   *  `port` = **界面上选的那个串口**，随 `connect` 帧发给 daemon，只对这一次连接生效
   *  （daemon 侧把它当作"明确指定"：连不上会响亮报错，不会偷偷换成自动发现到的另一个
   *  设备 —— 见 daemon 的 `Session._connect_candidates`）。不传 = 交给 daemon 自己决定
   *  （记住的口 → 自动发现）。
   */
  connect(port?: string) {
    this._pendingPort = port?.trim() || null
    // 传输层已经通着，说明失败的是 daemon 那边的 connect（没找到 CDC 设备、串口被占）：
    // 原地重发一次就是重试。拆掉重开不会多试任何东西，还会顺手弄断共用这条 socket 的
    // 夹爪会话。
    if (this.socket.open) {
      this.socket.sendFrame(this._connectFrame())
      return
    }
    this.socket.connect()
  }

  /**
   * 候选串口（`list_ports`）—— 顶栏端口下拉的数据源。
   *
   * ⚠ 这条命令**不要求已连接**（选端口本来就发生在连接之前），daemon 侧是
   * session-free 的。旧版 daemon 没有这条命令，会回 `UnknownCommandError`；调用方
   * （`useArmPorts`）据此退回"只能自动发现"，而不是把界面卡住。
   */
  async listPorts(): Promise<string[]> {
    const value = await this._sendCmd('list_ports')
    return Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string') : []
  }

  /** 打开 socket 时自动发的 connect 帧 —— 带上操作员选过的口（如果有）。 */
  private _connectFrame(): { t: 'connect'; port?: string } {
    return this._pendingPort ? { t: 'connect', port: this._pendingPort } : { t: 'connect' }
  }

  /** 断开：通知 daemon 断开机械臂，并关闭本地 WebSocket。 */
  disconnect() {
    const open = this.socket.open
    if (open) this.socket.sendFrame({ t: 'disconnect' })
    this.socket.disconnect()
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

  // ─────────────────────────── 授权 / 激活（只读） ───────────────────────────

  /**
   * 读设备授权记录（是否已激活 + 设备 UID）。
   *
   * ⚠ **未激活不是错误**：`activated === false` 是正常返回值 —— 未激活的臂除 ENABLE 外
   * 一切照常。只有真读不到时才由 `supported` 表达（见 `LicenseSnapshot`）。
   */
  async license(): Promise<LicenseSnapshot> {
    return normalizeLicense(await this._sendCmd('license'))
  }

  /**
   * 把注册信息提交给激活服务, 拿回本机凭据并写进设备 —— **全应用唯一出网的一条命令**。
   *
   * 请求体由界面逐字展示给用户看（见 `ActivationForm` 的"将要发送的内容"），所以这里
   * **不加任何字段**：界面上没显示的东西，不许偷偷发出去。
   *
   * ⚠ 设备必须**失能**：固件要求写授权记录时电机不在无监督下保持使能（会回 `0x3F/0x04`）。
   * 本地程序**不代劳** `disable()` —— 什么时候可以下电是操作员的决定。
   *
   * 返回的是**写入后回读**的授权记录（成功的 ACK 只说明固件答应了）。
   */
  async activate(request: ActivationRequest): Promise<LicenseSnapshot> {
    return normalizeLicense(await this._sendCmd('activate', { ...request }))
  }

  // ─────────────────────────── 固件升级（USB DFU） ───────────────────────────
  //
  // 三步：**校验镜像 → 确认 → 开始**。校验单独一步是刻意的 —— 操作员要在动手之前
  // 看见"这是哪个版本、多大、会不会碰到许可证扇区"，而校验失败必须发生在**任何
  // 硬件动作之前**（见 daemon `session._inspect_image`）。
  //
  // ⚠ 开始之后**不要**等这个 Promise 出结果：它只回一个 job 号，真正的进度与终局
  // 走 `onFirmwareProgress` / `onFirmwareResult`。

  /** 离线校验一份镜像（浏览器选的文件**整体上传**给守护进程；前端不解析 HEX）。 */
  async firmwareInspect(file: File): Promise<FirmwareImageSummary> {
    const data = await fileToBase64(file)
    return (await this._sendCmd('firmware_inspect', {
      name: file.name,
      data,
    })) as FirmwareImageSummary
  }

  /**
   * 开始升级 —— `token` 来自 {@link firmwareInspect}。
   *
   * `confirm` 是硬门禁（守护进程判，不是界面禁用按钮）：升级会先失能，机械臂失去
   * 支撑会下垂。
   */
  async firmwareUpgrade(token: string): Promise<{ job: string; phase: string }> {
    return (await this._sendCmd('firmware_upgrade', {
      token,
      confirm: true,
    })) as { job: string; phase: string }
  }

  /** 当前升级快照 —— 页面重开/重连之后靠它把进度条接回去。 */
  async firmwareStatus(): Promise<FirmwareStatus> {
    return normalizeFirmwareStatus(await this._sendCmd('firmware_status'))
  }

  /** 请求取消。**只在可取消的相位生效**：进了擦写就无效（擦一半比烧完更糟）。 */
  async firmwareCancel(): Promise<{ cancelled: boolean }> {
    return (await this._sendCmd('firmware_cancel')) as { cancelled: boolean }
  }

  /** 订阅进度帧。返回退订函数。 */
  onFirmwareProgress(cb: (p: FirmwareProgress) => void): () => void {
    this.firmwareProgressListeners.add(cb)
    return () => {
      this.firmwareProgressListeners.delete(cb)
    }
  }

  /** 订阅终局帧。返回退订函数。 */
  onFirmwareResult(cb: (r: FirmwareResult) => void): () => void {
    this.firmwareResultListeners.add(cb)
    return () => {
      this.firmwareResultListeners.delete(cb)
    }
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

  private _applyHello(msg: Record<string, unknown>) {
    this._hello = {
      daemon: typeof msg.daemon === 'string' ? msg.daemon : '',
      sdk: typeof msg.sdk === 'string' ? msg.sdk : '',
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
      this.socket.setLastError(null)
    } else if (conn.error) {
      this.socket.setLastError(conn.error)
    }
    const mapped: ConnectionStatus =
      conn.status === 'connected'
        ? 'connected'
        : conn.status === 'connecting'
          ? 'connecting'
          : conn.status === 'upgrading'
            // ⚠ 升级期间设备在 ROM bootloader 里，daemon 报的就是这个状态。单独一档
            //   而不是并进 `disconnected`：那会让顶栏说"已断开"，操作员以为掉线了，
            //   而真相是**我们自己**把设备交出去烧录。
            ? 'upgrading'
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

  private _sendCmd(m: string, p?: Record<string, unknown>): Promise<unknown> {
    return this.socket.sendCmd(m, p)
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

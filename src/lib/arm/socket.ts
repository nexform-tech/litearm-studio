import type { DaemonErrorInfo } from './errors'

type Listener = () => void

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000]

/** 命令被 daemon 拒绝时抛出的 Error，`err` 携带结构化错误信息。 */
export type CommandError = Error & { err: DaemonErrorInfo }

/** 传输层生命周期：连接中 / 重连中 / 已断开 / 出错。 */
export type SocketLifecycle = 'connecting' | 'reconnecting' | 'disconnected' | 'error'

/** 从当前页面推导本地 daemon 的 WebSocket 地址（https 页面用 wss）。 */
export function daemonWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws`
}

/**
 * 拥有全应用唯一的 daemon WebSocket：握手、命令 id 空间、在途 RPC、退避重连。
 *
 * 为什么单独成类：`ArmClient` 与 `GripperClient` 是两个设备，但它们**共用一个
 * socket** —— daemon 的 `/ws` 是一个连接、一个命令 id 空间（§4.2），两个客户端
 * 各自持一条连接只会让"客户端数量"与心跳变成两件事。标签分发（`onFrame`）让每个
 * 设备只处理自己那一半帧，互不知道对方存在。
 *
 * ⚠ 位移逻辑（退避表、握手帧、断开时拒绝在途命令）与原 `ArmClient` 逐字一致：
 * 那是被测试钉住的行为，不是可以顺手重写的东西。
 */
export class DaemonSocket {
  private socket: WebSocket | null = null
  private manualDisconnect = true
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  private frameHandlers = new Map<string, Set<(msg: Record<string, unknown>) => void>>()
  private lifecycleListeners = new Set<(s: SocketLifecycle) => void>()
  private openListeners = new Set<Listener>()

  private _status: SocketLifecycle = 'disconnected'
  private _lastError: string | null = null

  get status() {
    return this._status
  }

  get lastError() {
    return this._lastError
  }

  get open() {
    return this.socket != null && this.socket.readyState === WebSocket.OPEN
  }

  setLastError(message: string | null) {
    this._lastError = message
  }

  /** 订阅某一类下行帧（`t` 的值）。返回退订函数。 */
  onFrame(tag: string, handler: (msg: Record<string, unknown>) => void): () => void {
    let set = this.frameHandlers.get(tag)
    if (!set) {
      set = new Set()
      this.frameHandlers.set(tag, set)
    }
    set.add(handler)
    return () => {
      set?.delete(handler)
    }
  }

  /** 订阅传输层生命周期变化。 */
  onLifecycle(cb: (s: SocketLifecycle) => void): () => void {
    this.lifecycleListeners.add(cb)
    return () => {
      this.lifecycleListeners.delete(cb)
    }
  }

  /** 每次 socket 打开时触发（用于发送握手帧）。 */
  onOpen(cb: Listener): () => void {
    this.openListeners.add(cb)
    return () => {
      this.openListeners.delete(cb)
    }
  }

  /** 连接本地 daemon（无参：URL 由当前页面推导）。 */
  connect() {
    // 已连接/连接中时忽略重复点击；重连退避期间（reconnecting）允许取消
    // 当前定时器并立即重试，用户点击「连接」不必等最长 30s 的退避结束。
    if (!this.manualDisconnect && (this._status === 'connecting' || this.open)) {
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

  /** 关闭本地 WebSocket（不发送任何设备命令）。 */
  disconnect() {
    this.manualDisconnect = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this._closeSocket()
    this._rejectAllPending('连接已断开')
    this._setStatus('disconnected')
  }

  /** 发送一条 `cmd` 帧并等待同 id 的 `res`。socket 未开时立即拒绝。 */
  sendCmd(m: string, p?: Record<string, unknown>): Promise<unknown> {
    const ws = this.socket
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('本地程序未连接'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const sent = this.sendFrame({ t: 'cmd', id, m, p: p ?? {} })
      if (!sent) {
        this.pending.delete(id)
        reject(new Error('本地程序未连接'))
      }
    })
  }

  /** 发送一条原始帧。返回是否真的写进了 socket。 */
  sendFrame(frame: Record<string, unknown>): boolean {
    const ws = this.socket
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    try {
      ws.send(JSON.stringify(frame))
      return true
    } catch {
      return false
    }
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  private _openSocket() {
    this._closeSocket()
    this._setStatus(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting')

    let ws: WebSocket
    try {
      ws = new WebSocket(daemonWsUrl())
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err)
      this._setStatus('error')
      this._scheduleReconnect()
      return
    }
    this.socket = ws

    ws.onopen = () => {
      if (this.socket !== ws) return
      for (const l of this.openListeners) l()
    }
    ws.onmessage = (ev: MessageEvent) => {
      if (this.socket !== ws) return
      this._handleMessage(ev.data)
    }
    ws.onclose = () => {
      if (this.socket !== ws) return
      this.socket = null
      this._rejectAllPending('本地程序连接已断开')
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
    if (msg.t === 'res') {
      this._resolvePending(msg)
      return
    }
    const tag = typeof msg.t === 'string' ? msg.t : ''
    const handlers = this.frameHandlers.get(tag)
    if (!handlers) return
    for (const handler of [...handlers]) handler(msg)
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
    const error = new Error(detail) as CommandError
    error.err = info
    entry.reject(error)
  }

  private _rejectAllPending(reason: string) {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) entry.reject(new Error(reason))
  }

  private _setStatus(s: SocketLifecycle) {
    if (this._status === s) return
    this._status = s
    for (const l of [...this.lifecycleListeners]) l(s)
  }
}

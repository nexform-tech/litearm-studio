import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** 最小可用的假 WebSocket：测试手动控制 open/message/close。 */
class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: FakeWebSocket[] = []

  url: string
  readyState = FakeWebSocket.CONNECTING
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  sent: string[] = []

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
  }

  // ── 测试助手 ──
  open() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.({} as Event)
  }

  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent)
  }

  drop() {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({} as CloseEvent)
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>)
  }

  lastFrame(m?: string): Record<string, unknown> | undefined {
    const frames = this.frames()
    for (let i = frames.length - 1; i >= 0; i--) {
      if (!m || frames[i].t === m) return frames[i]
    }
    return undefined
  }
}

const { ArmClient } = await import('./client')

/** 建一个已通过 WS 握手、daemon 报 connected 的客户端。 */
function connectedClient() {
  const client = new ArmClient()
  client.connect()
  const ws = FakeWebSocket.instances.at(-1)!
  ws.open()
  ws.receive({ t: 'hello', daemon: '0.1.0', sdk: '2.1.0' })
  ws.receive({ t: 'conn', status: 'connected', port: '/dev/ttyACM0', firmware: 'Litearm1.8.0-7J', n: 7, cart: true, error: null })
  return { client, ws }
}

/**
 * 运动互斥的**释放**路径与两条未断言的节流/退避行为。
 *
 * client.test.ts 只钉住成功时释放互斥；这里的价值在于失败路径：`_guardMotion` 的
 * `finally`、掉线与 `disconnect()` 都必须把 `motionBusy` 放回 false，否则一次失败
 * 就会让 UI 永久拒绝之后的每一条运动指令。
 */
describe('ArmClient motion mutex and notify throttle', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    FakeWebSocket.instances = []
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('releases the motion mutex when the daemon discards the motion', async () => {
    const { client, ws } = connectedClient()
    const discarded = client.movej([0.1])
    expect(client.motionBusy).toBe(true)

    const frame = ws.lastFrame('cmd')!
    ws.receive({ t: 'res', id: frame.id, ok: false, err: { kind: 'MotionBusyError', msg: '已有运动在途' } })
    await expect(discarded).rejects.toThrow()

    // ok:false 走的是 throw 路径，不是 resolve：互斥必须在 finally 里释放，否则
    // 下一条运动会被本地的"正在运动"直接挡掉，UI 从此拒绝一切指令。
    expect(client.motionBusy).toBe(false)

    // 放行后必须真的能再下发一条，而不是只把标志位改回 false。
    const next = client.movej([0.2])
    expect(client.motionBusy).toBe(true)
    const nextFrame = ws.lastFrame('cmd')!
    expect(nextFrame).toMatchObject({ m: 'movej', p: { q: [0.2] } })
    ws.receive({ t: 'res', id: nextFrame.id, ok: true, v: null })
    await next
    expect(client.motionBusy).toBe(false)
  })

  it('releases the motion mutex when the socket drops mid-motion', async () => {
    vi.useFakeTimers()
    const { client, ws } = connectedClient()
    const inFlight = client.movel([0, 0, 0, 0, 0, 0])
    expect(client.motionBusy).toBe(true)

    ws.drop()

    // 传输层一动，在途运动就作废：不释放的话，重连回来后 UI 仍会拒绝下一条运动。
    expect(client.status).toBe('reconnecting')
    expect(client.motionBusy).toBe(false)
    await expect(inFlight).rejects.toThrow()

    // 退避后重连，下一条运动必须发得出去，而不是被"正在运动"拦下。
    await vi.advanceTimersByTimeAsync(1000)
    const ws2 = FakeWebSocket.instances.at(-1)!
    ws2.open()
    ws2.receive({ t: 'conn', status: 'connected', port: null, firmware: '', n: 7, cart: true, error: null })

    const next = client.movej([0.3])
    const frame = ws2.lastFrame('cmd')!
    expect(frame).toMatchObject({ m: 'movej', p: { q: [0.3] } })
    ws2.receive({ t: 'res', id: frame.id, ok: true, v: null })
    await next
  })

  it('releases the motion mutex when disconnect() interrupts a motion', async () => {
    const { client } = connectedClient()
    const inFlight = client.home()
    expect(client.motionBusy).toBe(true)

    client.disconnect()

    expect(client.status).toBe('disconnected')
    expect(client.motionBusy).toBe(false)
    await expect(inFlight).rejects.toThrow()
  })

  it('coalesces ordinary telemetry inside the 100ms notify window', () => {
    const { client, ws } = connectedClient()
    let notifications = 0
    client.subscribeState(() => notifications++)
    let fast = 0
    client.subscribeStateFast(() => fast++)

    const now = vi.spyOn(performance, 'now')
    now.mockReturnValue(1_000)

    // 首帧一定通知（前一个状态为空）。
    ws.receive({ t: 'state', state: { q: [1], errs: [1], state: 'ready' } })
    expect(notifications).toBe(1)

    now.mockReturnValue(1_050)
    ws.receive({ t: 'state', state: { q: [2], errs: [1], state: 'ready' } })
    // 状态本身已更新，命令式消费方（3D 预览）每帧跟随；但 React 侧的订阅被 100ms
    // 节流挡住，窗口内的普通遥测不重复通知 —— 否则 10Hz 广播会把整页反复重渲染。
    expect(client.state?.q).toEqual([2])
    expect(fast).toBe(2)
    expect(notifications).toBe(1)

    now.mockReturnValue(1_100)
    ws.receive({ t: 'state', state: { q: [3], errs: [1], state: 'ready' } })
    // 到窗口边界（>=100ms）就放行：节流是"合并窗口内的"，不是把遥测永久停掉。
    expect(client.state?.q).toEqual([3])
    expect(fast).toBe(3)
    expect(notifications).toBe(2)
  })

  it('walks the reconnect backoff up to the 30s clamp', async () => {
    vi.useFakeTimers()
    const { client, ws } = connectedClient()
    ws.drop()
    expect(client.status).toBe('reconnecting')

    // RECONNECT_DELAYS_MS 的完整台阶，末两档都落在 30s 上限上。
    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000]
    for (const delay of delays) {
      const before = FakeWebSocket.instances.length
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(FakeWebSocket.instances).toHaveLength(before)
      await vi.advanceTimersByTimeAsync(1)
      expect(FakeWebSocket.instances).toHaveLength(before + 1)
      // 让刚建立的连接再次失败，进入下一档退避。
      FakeWebSocket.instances.at(-1)!.drop()
    }
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RobotState } from './client'

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

describe('ArmClient (daemon WebSocket)', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    FakeWebSocket.instances = []
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('starts disconnected', () => {
    const client = new ArmClient()
    expect(client.status).toBe('disconnected')
    expect(client.state).toBeNull()
    expect(client.conn).toBeNull()
  })

  it('derives ws://host/ws and on open asks the daemon to connect', () => {
    const client = new ArmClient()
    client.connect()
    expect(client.status).toBe('connecting')
    const ws = FakeWebSocket.instances.at(-1)!
    expect(ws.url).toBe('ws://localhost:3000/ws')

    ws.open()
    expect(ws.lastFrame('connect')).toMatchObject({ t: 'connect' })
  })

  it('goes connecting → connected on the daemon conn frame and notifies status listeners', () => {
    const client = new ArmClient()
    const statuses: string[] = []
    client.subscribeStatus(() => statuses.push(client.status))

    client.connect()
    const ws = FakeWebSocket.instances.at(-1)!
    ws.open()
    expect(client.status).toBe('connecting')

    ws.receive({ t: 'conn', status: 'connected', port: '/dev/ttyACM0', firmware: 'Litearm1.8.0-7J', n: 7, cart: true, error: null })
    expect(client.status).toBe('connected')
    expect(statuses).toContain('connected')
    expect(client.conn).toMatchObject({ port: '/dev/ttyACM0', firmware: 'Litearm1.8.0-7J', n: 7, cart: true })
    expect(client.lastError).toBeNull()
  })

  it('surfaces conn.error as lastError and error status', () => {
    const client = new ArmClient()
    client.connect()
    const ws = FakeWebSocket.instances.at(-1)!
    ws.open()
    ws.receive({ t: 'conn', status: 'error', port: null, firmware: '', n: 0, cart: false, error: '未发现 STM32 CDC 设备' })
    expect(client.status).toBe('error')
    expect(client.lastError).toBe('未发现 STM32 CDC 设备')
  })

  it('applies state frames and notifies state listeners', () => {
    const { client, ws } = connectedClient()
    const seen: Array<RobotState | null> = []
    client.subscribeState(() => seen.push(client.state))

    ws.receive({ t: 'state', stamp: 1, state: { q: [1, 2], dq: [], tau: [], errs: [1, 1], state: 'ready' } })
    expect(client.state?.q).toEqual([1, 2])
    expect(seen).toHaveLength(1)

    // 状态串变化立即通知（不受 100ms 节流限制）
    ws.receive({ t: 'state', stamp: 2, state: { q: [1, 2], dq: [], tau: [], errs: [1, 1], state: 'fault', faulted: true } })
    expect(client.state?.state).toBe('fault')
    expect(seen).toHaveLength(2)
  })

  it('fast state subscribers fire on every frame', () => {
    const { client, ws } = connectedClient()
    let fast = 0
    client.subscribeStateFast(() => fast++)
    ws.receive({ t: 'state', stamp: 1, state: { q: [1], state: 'ready' } })
    ws.receive({ t: 'state', stamp: 2, state: { q: [2], state: 'ready' } })
    expect(fast).toBe(2)
  })

  it('resolves a command from an ok res frame and sends an auto-increment id', async () => {
    const { client, ws } = connectedClient()
    const promise = client.enable()
    const frame = ws.lastFrame('cmd')!
    expect(frame).toMatchObject({ t: 'cmd', id: 1, m: 'enable', p: {} })

    ws.receive({ t: 'res', id: 1, ok: true, v: null })
    await expect(promise).resolves.toBeNull()
  })

  it('rejects with the daemon err object on an ok:false res frame', async () => {
    const { client, ws } = connectedClient()
    const promise = client.movej([0, 0, 0])
    const frame = ws.lastFrame('cmd')!
    ws.receive({ t: 'res', id: frame.id, ok: false, err: { kind: 'MotionBusyError', msg: '已有运动在途' } })

    await expect(promise).rejects.toMatchObject({ err: { kind: 'MotionBusyError', msg: '已有运动在途' } })
  })

  it('sends the whitelisted command methods with the documented params', async () => {
    const { client, ws } = connectedClient()

    const cases: Array<[() => Promise<unknown>, Record<string, unknown>]> = [
      [() => client.disable(), { m: 'disable', p: {} }],
      [() => client.clearFaults(), { m: 'clear_faults', p: {} }],
      [() => client.reset(), { m: 'reset', p: {} }],
      [() => client.setSpeed(42), { m: 'set_speed', p: { percent: 42 } }],
      [() => client.getTcpPose(), { m: 'get_tcp', p: {} }],
      [() => client.ik([0, 0, 0, 0, 0, 0]), { m: 'ik', p: { pose: [0, 0, 0, 0, 0, 0] } }],
      [() => client.zeroGStart(), { m: 'zero_g_start', p: {} }],
      [() => client.zeroGStop(), { m: 'zero_g_stop', p: {} }],
      [() => client.getJointParams(), { m: 'get_joint_params', p: {} }],
      [() => client.setPayload(1.2, [0.01, 0.02, 0.03]), { m: 'set_payload', p: { mass: 1.2, com: [0.01, 0.02, 0.03] } }],
      [() => client.setGravityScale([1, 1, 1, 1, 1, 1, 1]), { m: 'set_gravity_scale', p: { values: [1, 1, 1, 1, 1, 1, 1] } }],
      [() => client.setInertiaScale([1, 1, 1, 1, 1, 1, 1]), { m: 'set_inertia_scale', p: { values: [1, 1, 1, 1, 1, 1, 1] } }],
      [() => client.setGravityVector([0, 0, -1]), { m: 'set_gravity_vector', p: { g: [0, 0, -1] } }],
      [() => client.setJointParam(2, 50, 2, 10), { m: 'set_joint_param', p: { idx: 2, kp: 50, kd: 2, tau_max: 10 } }],
      [() => client.setJointLimits(2, -1.5, 1.5), { m: 'set_joint_limits', p: { idx: 2, q_min: -1.5, q_max: 1.5 } }],
      [() => client.saveParams(), { m: 'save_params', p: {} }],
      [() => client.resetFactoryParams(), { m: 'reset_factory_params', p: {} }],
      [() => client.kinBench(), { m: 'kin_bench', p: {} }],
    ]
    for (const [run, expected] of cases) {
      const p = run()
      const frame = ws.lastFrame('cmd')!
      expect(frame).toMatchObject(expected)
      ws.receive({ t: 'res', id: frame.id, ok: true, v: null })
      await p
    }
  })

  it('readPayload() reads back mass (item 4) and com (item 5 sub 0..2)', async () => {
    const { client, ws } = connectedClient()
    const promise = client.readPayload()
    const frames = ws.frames().filter((f) => f.t === 'cmd')
    expect(frames.map((f) => f.p)).toEqual([
      { item: 4, sub: 0 },
      { item: 5, sub: 0 },
      { item: 5, sub: 1 },
      { item: 5, sub: 2 },
    ])
    // 固件把负质量静默钳成 0 —— 读回的必须是生效值。
    const values = [0, -0.25, 0.1, 1]
    frames.forEach((f, i) => ws.receive({ t: 'res', id: f.id, ok: true, v: values[i] }))
    await expect(promise).resolves.toEqual({ mass: 0, com: [-0.25, 0.1, 1] })
  })

  it('readGravityScale() asks for feed-forward vector item 7', async () => {
    const { client, ws } = connectedClient()
    const promise = client.readGravityScale()
    const frame = ws.lastFrame('cmd')!
    expect(frame).toMatchObject({ m: 'get_ff_vec', p: { item: 7 } })
    ws.receive({ t: 'res', id: frame.id, ok: true, v: [1, 2, 3, 4, 5, 6, 7] })
    await expect(promise).resolves.toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('rejects commands while the socket is not open', async () => {
    const client = new ArmClient()
    await expect(client.enable()).rejects.toThrow('本地程序未连接')
  })

  it('requestStop() sends estop', async () => {
    const { client, ws } = connectedClient()
    const promise = client.requestStop()
    const frame = ws.lastFrame('cmd')!
    expect(frame).toMatchObject({ m: 'estop' })
    ws.receive({ t: 'res', id: frame.id, ok: true, v: null })
    await promise
  })

  it('requestStop() surfaces a rejection instead of swallowing it', async () => {
    const { client, ws } = connectedClient()
    const promise = client.requestStop()
    const frame = ws.lastFrame('cmd')!
    ws.receive({ t: 'res', id: frame.id, ok: false, err: { kind: 'MotionBusyError', msg: '已有运动在途' } })
    await expect(promise).rejects.toMatchObject({ err: { kind: 'MotionBusyError' } })
  })

  it('rejects a second motion while the first is still in flight', async () => {
    const { client, ws } = connectedClient()
    const first = client.movej([0.1])
    expect(client.motionBusy).toBe(true)

    await expect(client.movej([0.2])).rejects.toThrow('正在运动')

    const frame = ws.lastFrame('cmd')!
    ws.receive({ t: 'res', id: frame.id, ok: true, v: null })
    await first
    expect(client.motionBusy).toBe(false)
  })

  it('disconnect() sends the disconnect frame, closes, and clears state', async () => {
    const { client, ws } = connectedClient()
    ws.receive({ t: 'state', stamp: 1, state: { q: [1], state: 'ready' } })

    client.disconnect()
    expect(ws.lastFrame('disconnect')).toMatchObject({ t: 'disconnect' })
    expect(client.status).toBe('disconnected')
    expect(client.state).toBeNull()
  })

  it('a redundant connect() while connecting/connected is a no-op', () => {
    const { client } = connectedClient()
    client.connect()
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('retries the arm link in place when the daemon reported an error', () => {
    const { client, ws } = connectedClient()
    ws.receive({
      t: 'conn', status: 'error', port: null, firmware: '', n: 0, cart: false,
      error: '未发现 STM32 CDC 设备',
    })
    expect(client.status).toBe('error')

    const sent = ws.frames().length
    client.connect()

    // 传输层没动（不重开 socket），但 daemon 那边重新收到了一次 connect ——
    // 否则按钮可点却什么都不发生，只能先断开再连接。
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(ws.frames()).toHaveLength(sent + 1)
    expect(ws.frames().at(-1)).toMatchObject({ t: 'connect' })
  })

  it('clears the arm state when the socket drops', () => {
    const { client, ws } = connectedClient()
    ws.receive({ t: 'state', stamp: 1, state: { q: [1, 2, 3], state: 'ready' } })
    expect(client.state).not.toBeNull()

    ws.drop()

    // 掉线走的是 reconnecting。旧姿态/故障位留在屏幕上看起来和"实时"一模一样，
    // 而重连失败时会一直留着。
    expect(client.status).toBe('reconnecting')
    expect(client.state).toBeNull()
  })

  it('reconnects with the backoff after the socket drops', async () => {
    vi.useFakeTimers()
    const { client, ws } = connectedClient()
    ws.drop()
    expect(client.status).toBe('reconnecting')
    expect(FakeWebSocket.instances).toHaveLength(1)

    // 第一次退避 1000ms
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('does not reconnect after an explicit disconnect()', async () => {
    vi.useFakeTimers()
    const { client, ws } = connectedClient()
    client.disconnect()
    ws.drop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('rejects in-flight commands when the socket drops', async () => {
    const { client, ws } = connectedClient()
    const pending = client.enable()
    ws.drop()
    await expect(pending).rejects.toThrow('本地程序连接已断开')
  })

  it('connect() after a drop cancels the backoff and retries immediately', async () => {
    vi.useFakeTimers()
    const { client, ws } = connectedClient()
    ws.drop()
    expect(client.status).toBe('reconnecting')

    client.connect()
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(client.status).toBe('connecting')

    // 被取消的退避定时器不应再触发第三次连接
    await vi.advanceTimersByTimeAsync(5000)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('does not choke on malformed frames', () => {
    const { client, ws } = connectedClient()
    expect(() => ws.onmessage?.({ data: 'not json' } as MessageEvent)).not.toThrow()
    expect(client.status).toBe('connected')
  })

  it('ignores res frames with an unknown id', () => {
    const { client } = connectedClient()
    expect(() => client.state).not.toThrow()
  })

  it('parses a full daemon state frame into RobotState', () => {
    const { client, ws } = connectedClient()
    ws.receive({
      t: 'state',
      stamp: 1.5,
      state: {
        q: [0.1], dq: [0.2], tau: [0.3], errs: [1], temps: [{ mosTemp: 40, coilTemp: 35 }],
        fault: [], mode: 3, modeName: 'MOVE_J', flags: 1, flagNames: ['ENABLED'], jointFault: 0,
        faultAxes: [], enabled: true, cartBusy: false, faulted: false, faultDetail: '', seq: 12, state: 'ready',
      },
    })
    expect(client.state).toEqual({
      q: [0.1], dq: [0.2], tau: [0.3], errs: [1], temps: [{ mosTemp: 40, coilTemp: 35 }],
      fault: [], mode: 3, modeName: 'MOVE_J', flags: 1, flagNames: ['ENABLED'], jointFault: 0,
      faultAxes: [], enabled: true, cartBusy: false, faulted: false, faultDetail: '', seq: 12, state: 'ready',
    })
  })
})

describe('normalizeRobotState', () => {
  it('handles null and undefined', async () => {
    const { normalizeRobotState } = await import('./client')
    expect(normalizeRobotState(null)).toBeNull()
    expect(normalizeRobotState(undefined)).toBeNull()
  })

  it('fills missing fields with safe defaults', async () => {
    const { normalizeRobotState } = await import('./client')
    const res = normalizeRobotState({} as RobotState)
    expect(res?.q).toEqual([])
    expect(res?.dq).toEqual([])
    expect(res?.tau).toEqual([])
    expect(res?.errs).toEqual([])
    expect(res?.fault).toEqual([])
    expect(res?.temps).toEqual([])
    expect(res?.flagNames).toEqual([])
    expect(res?.faultAxes).toEqual([])
    expect(res?.enabled).toBe(false)
    expect(res?.faulted).toBe(false)
    expect(res?.state).toBe('disabled')
  })

  it('fills empty temperature objects with zeros', async () => {
    const { normalizeRobotState } = await import('./client')
    const res = normalizeRobotState({ temps: [{}, { mosTemp: 42 }] } as unknown as RobotState)
    expect(res?.temps).toEqual([
      { mosTemp: 0, coilTemp: 0 },
      { mosTemp: 42, coilTemp: 0 },
    ])
  })
})

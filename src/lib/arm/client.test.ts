import { waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeWebSocket } from '@/test/fakeWebSocket'
import type { RobotState } from './client'

const { ArmClient } = await import('./client')

/** 激活请求体 —— 字段就是同意书里逐项列出的那些（与激活网站的表单同集），这里逐字比对。 */
const ACTIVATION_REQUEST = {
  uid: '101112131415161718191a1b',
  contact: {
    name: '张三',
    phone: '13800000000',
    organization: '某大学',
    wechatId: 'zhangsan_wx',
    email: 'z@example.com',
    region: '上海',
    industry: '教育',
    purpose: '科研教学',
  },
  consent: { granted: true },
  diagnostics: { studio: '0.1.0', sdk: '2.1.0', firmware: 'Litearm1.8.0-7J' },
}

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

  it('carries the chosen serial port on the connect frame, and omits it when none is chosen', () => {
    // ⚠ 帧上**有**port 与**没有**port 是两件事: 有 = "就这一台, 连不上就报错"; 没有 =
    //   "按 daemon 自己的顺序来" (上次连上的口 → 自动发现)。所以空选择不能发成 `port: ''`。
    const { client, ws } = connectedClient()

    client.connect('/dev/ttyACM7')
    expect(ws.lastFrame('connect')).toMatchObject({ t: 'connect', port: '/dev/ttyACM7' })

    client.connect()
    const auto = ws.lastFrame('connect')!
    expect(auto).toMatchObject({ t: 'connect' })
    expect(auto).not.toHaveProperty('port')
  })

  it('keeps a port chosen before the socket is open', () => {
    // 启动时传输层还在开, 这时操作员先选了口再点连接 —— 那次选择不能丢, 否则连上的是
    // 自动发现到的另一台, 而界面上显示的是他选的那个。
    const client = new ArmClient()
    client.connect('/dev/ttyACM7')
    const ws = FakeWebSocket.instances.at(-1)!

    ws.open()
    expect(ws.lastFrame('connect')).toMatchObject({ t: 'connect', port: '/dev/ttyACM7' })
  })

  it('gives the connect frame an id and surfaces a refused connect as error + lastError', async () => {
    // ⚠ 已连着时指另一个口, daemon 只回一条 `ok:false` 的 `res`（没有 conn 帧）——
    //   帧带 id 就是为了认领这条拒绝。丢掉它, 操作员看到的是"点了没反应", 链路却还在
    //   原来的口上 (issue #70 review 的 blocker 1)。
    const { client, ws } = connectedClient()

    client.connect('/dev/ttyACM0')
    const frame = ws.lastFrame('connect')!
    expect(typeof frame.id).toBe('number')

    ws.receive({
      t: 'res', id: frame.id, ok: false,
      err: {
        kind: 'PortChangeWhileConnectedError',
        msg: '已连接 /dev/ttyACM1；换口请先断开 (本次请求的 /dev/ttyACM0 未生效)',
      },
    })

    await waitFor(() => expect(client.status).toBe('error'))
    // 文案随界面语言（zh/en），但两种都必须告诉操作员"先断开"。
    expect(client.lastError).toMatch(/断开|Disconnect/)
  })

  it('lists candidate ports through list_ports and drops entries that are not paths', async () => {
    const { client, ws } = connectedClient()
    const pending = client.listPorts()
    const cmd = ws.lastFrame('cmd')!

    ws.receive({ t: 'res', id: cmd.id, ok: true, v: ['/dev/ttyACM0', 42, '/dev/ttyUSB0'] })
    await expect(pending).resolves.toEqual(['/dev/ttyACM0', '/dev/ttyUSB0'])
  })

  it('resolves list_ports to an empty list when the daemon answers something else', async () => {
    // 「答了但不是数组」与「拒绝」都要落到空列表上 —— 下拉拿到 `undefined` 会当场炸。
    const { client, ws } = connectedClient()
    const pending = client.listPorts()
    const cmd = ws.lastFrame('cmd')!

    ws.receive({ t: 'res', id: cmd.id, ok: true, v: null })
    await expect(pending).resolves.toEqual([])
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
    // ⚠ id 从一个共享计数器来, `connect` 帧也占一个 —— 不断言具体数字, 只钉形状。
    expect(frame).toMatchObject({ t: 'cmd', m: 'enable', p: {} })
    expect(typeof frame.id).toBe('number')

    ws.receive({ t: 'res', id: frame.id, ok: true, v: null })
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
      [() => client.license(), { m: 'license', p: {} }],
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

  it('license() sends the read-only command and keeps the UID the signer needs', async () => {
    const { client, ws } = connectedClient()
    const promise = client.license()
    const frame = ws.lastFrame('cmd')!
    expect(frame).toMatchObject({ m: 'license', p: {} })
    ws.receive({
      t: 'res',
      id: frame.id,
      ok: true,
      v: {
        supported: true,
        state: 0,
        stateName: 'not_activated',
        activated: false,
        factoryMode: false,
        ver: 1,
        // 未激活也回 UID —— 签发凭据用的就是这一串。
        uid: '101112131415161718191a1b',
        custId: 0,
        issued: 0,
        flags: 0,
      },
    })
    await expect(promise).resolves.toMatchObject({
      supported: true,
      activated: false,
      state: 0,
      uid: '101112131415161718191a1b',
    })
  })

  it('license() keeps "no such command" apart from "not read this time"', async () => {
    // 三态刻意不是一个布尔：对用户说的三句话完全不同（固件太旧 / 没读到 / 记录在这里）。
    const { client, ws } = connectedClient()

    const unsupported = client.license()
    const f1 = ws.lastFrame('cmd')!
    ws.receive({ t: 'res', id: f1.id, ok: true, v: { supported: false } })
    await expect(unsupported).resolves.toEqual({ supported: false })

    const unreadable = client.license()
    const f2 = ws.lastFrame('cmd')!
    ws.receive({ t: 'res', id: f2.id, ok: true, v: { supported: null } })
    await expect(unreadable).resolves.toEqual({ supported: null })

    // 认不出的形状一律折成"没读到"：绝不猜成"已激活"（那会让一台锁着的臂看起来能用）。
    const garbage = client.license()
    const f3 = ws.lastFrame('cmd')!
    ws.receive({ t: 'res', id: f3.id, ok: true, v: { uid: 'aa' } })
    await expect(garbage).resolves.toEqual({ supported: null })
  })

  it('activate() sends the request body verbatim and returns the read-back record', async () => {
    const { client, ws } = connectedClient()
    const promise = client.activate(ACTIVATION_REQUEST)
    const frame = ws.lastFrame('cmd')!
    // ⚠ `p` 的字段集与同意书逐项列出的内容一致，**一个字段都不许多**。
    expect(frame).toEqual({ t: 'cmd', id: frame.id, m: 'activate', p: ACTIVATION_REQUEST })

    ws.receive({
      t: 'res',
      id: frame.id,
      ok: true,
      v: { supported: true, state: 1, stateName: 'activated', activated: true,
           factoryMode: false, ver: 1, uid: ACTIVATION_REQUEST.uid,
           custId: 1042, issued: 20260929, flags: 0 },
    })
    await expect(promise).resolves.toMatchObject({ supported: true, activated: true, custId: 1042 })
  })

  it('keeps the hello versions — the activation request carries them as diagnostics', () => {
    const { client } = connectedClient()
    // hello 帧只在握手时来一条；激活发生在很久之后，所以要能一直读到它。
    expect(client.versions).toEqual({ daemon: '0.1.0', sdk: '2.1.0' })
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

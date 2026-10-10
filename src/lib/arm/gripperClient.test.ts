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
      if (!m || frames[i].m === m || frames[i].t === m) return frames[i]
    }
    return undefined
  }
}

const { DaemonSocket } = await import('./socket')
const { GripperClient, normalizeGripperState } = await import('./gripperClient')

function connected() {
  const socket = new DaemonSocket()
  const client = new GripperClient(socket)
  socket.connect()
  const ws = FakeWebSocket.instances.at(-1)!
  ws.open()
  ws.receive({ t: 'hello', daemon: '0.1.0', sdk: '2.1.0' })
  ws.receive({
    t: 'gripper_conn',
    status: 'connected',
    channel: 'can0',
    canId: 8,
    mount: 'reverse',
    declaredMount: 'reverse',
    template: 'reverse',
    source: 'template',
    path: '/tmp/reverse.json',
    travelMm: 85,
    closedRad: -1.491,
    openRad: 0.114,
    fileRadToMm: 74.8,
    error: null,
    gate: 'TEMPLATE',
    gateReason: '标称模板',
  })
  return { socket, client, ws }
}

describe('GripperClient (daemon WebSocket)', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    FakeWebSocket.instances = []
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is absent until a gripper_conn frame arrives', () => {
    const socket = new DaemonSocket()
    const client = new GripperClient(socket)
    expect(client.present).toBe(false)
    expect(client.status).toBe('disconnected')
  })

  it('routes gripper_conn into the documented fields', () => {
    const { client } = connected()
    expect(client.present).toBe(true)
    expect(client.status).toBe('connected')
    expect(client.conn).toMatchObject({
      channel: 'can0',
      canId: 8,
      mount: 'reverse',
      declaredMount: 'reverse',
      template: 'reverse',
      source: 'template',
      travelMm: 85,
      closedRad: -1.491,
      openRad: 0.114,
      gate: 'TEMPLATE',
    })
  })

  it('routes gripper_state and keeps a missing position as unknown, not zero', () => {
    const { client, ws } = connected()
    const seen: Array<number | null> = []
    client.subscribeState(() => seen.push(client.state?.positionMm ?? null))

    ws.receive({ t: 'gripper_state', stamp: 1, state: { positionMm: null, enabled: false, state: 'disabled' } })
    expect(client.state?.positionMm).toBeNull()
    ws.receive({
      t: 'gripper_state',
      stamp: 2,
      state: {
        positionMm: 41.25,
        forceN: 3.5,
        torqueNm: 0.35,
        velocityMmS: -1.2,
        enabled: true,
        state: 'holding',
        errorCode: 1,
        temps: { mosTemp: 31, coilTemp: 34 },
        fresh: true,
        gate: 'READY',
        gateReason: '',
      },
    })
    expect(client.state).toMatchObject({
      positionMm: 41.25,
      forceN: 3.5,
      enabled: true,
      state: 'holding',
      temps: { mosTemp: 31, coilTemp: 34 },
      gate: 'READY',
    })
    // 安全相关的字段变化立即通知，不受 100ms 节流影响。
    expect(seen.length).toBeGreaterThanOrEqual(2)
  })

  it('routes gripper_calib progress and gripper_busy', () => {
    const { client, ws } = connected()
    const phases: string[] = []
    client.subscribeCalib(() => phases.push(client.calib?.phase ?? ''))

    ws.receive({ t: 'gripper_calib', probe: 'zero', phase: 'close', step: 12, total: 80, progress: 0.15, detail: '寻找闭合限位' })
    expect(client.calib).toMatchObject({ probe: 'zero', phase: 'close', step: 12, total: 80 })
    expect(phases).toEqual(['close'])

    ws.receive({ t: 'gripper_busy', busy: true, what: '正在连接夹爪…' })
    expect(client.busy).toEqual({ busy: true, what: '正在连接夹爪…' })
  })

  it('delivers gripper_alert with its level and text', () => {
    const { client, ws } = connected()
    const alerts: Array<{ level: string; text: string }> = []
    client.subscribeAlert((a) => alerts.push({ level: a.level, text: a.text }))

    ws.receive({ t: 'gripper_alert', level: 'warn', text: '「闭合」被拒绝：标定未就绪' })
    expect(alerts).toEqual([{ level: 'warn', text: '「闭合」被拒绝：标定未就绪' }])
  })

  it('sends the documented command names and params', async () => {
    const { client, ws } = connected()
    const pending = [
      client.connect({ channel: 'can1', canId: 9, mount: 'reverse' }),
      client.disconnect(),
      client.listChannels(),
      client.enable(),
      client.disable(),
      client.clearFault(),
      client.open(),
      client.close(),
      client.grasp({ forceN: 20, holdS: 2 }),
      client.moveTo(40, 60),
      client.release(),
      client.stop(),
      client.resetStop(),
      client.setMotion({ speedMmS: 30, forceN: 12 }),
      client.loadTemplate('normal'),
      client.listDir('/tmp'),
      client.importCalibration('/tmp/x.json'),
      client.writeZero(),
      client.setAllowFactory(true),
    ]
    const methods = ws.frames().filter((f) => f.t === 'cmd').map((f) => f.m)
    expect(methods).toEqual([
      'gripper.connect',
      'gripper.disconnect',
      'gripper.list_channels',
      'gripper.enable',
      'gripper.disable',
      'gripper.clear_fault',
      'gripper.open',
      'gripper.close',
      'gripper.grasp',
      'gripper.move_to',
      'gripper.release',
      'gripper.stop',
      'gripper.reset_stop',
      'gripper.set_motion',
      'gripper.load_template',
      'gripper.list_dir',
      'gripper.import_calibration',
      'gripper.write_zero',
      'gripper.set_allow_factory',
    ])
    expect(ws.lastFrame('gripper.move_to')!.p).toEqual({ targetMm: 40, speedMmS: 60 })
    expect(ws.lastFrame('gripper.connect')!.p).toEqual({ channel: 'can1', canId: 9, mount: 'reverse' })
    expect(ws.lastFrame('gripper.grasp')!.p).toEqual({ forceN: 20, holdS: 2 })
    // 给了路径就带 `path`，不给就是 `{}`（daemon 侧落到家目录）。
    expect(ws.lastFrame('gripper.list_dir')!.p).toEqual({ path: '/tmp' })

    // 让在途 RPC 收尾（daemon 的 res：id 就是帧里的 id）。
    for (const frame of ws.frames().filter((f) => f.t === 'cmd')) {
      ws.receive({ t: 'res', id: frame.id, ok: true, v: null })
    }
    await Promise.all(pending)
  })

  it('listDir without a path sends an empty param object', async () => {
    const { client, ws } = connected()
    const promise = client.listDir()
    const frame = ws.lastFrame('gripper.list_dir')!
    expect(frame.p).toEqual({})
    ws.receive({ t: 'res', id: frame.id, ok: true, v: null })
    await promise
  })

  it('rejects with the daemon error object, kinds included', async () => {
    const { client, ws } = connected()
    const promise = client.moveTo(20)
    const frame = ws.lastFrame('gripper.move_to')!
    ws.receive({
      t: 'res',
      id: frame.id,
      ok: false,
      err: { kind: 'GripperCalibrationError', msg: '标称模板', method: 'gripper.move_to' },
    })
    await expect(promise).rejects.toMatchObject({
      err: { kind: 'GripperCalibrationError' },
    })
  })

  it('clears the connection when the transport drops', () => {
    const { client, ws } = connected()
    ws.drop()
    expect(client.conn).toBeNull()
    expect(client.state).toBeNull()
    expect(client.present).toBe(false)
  })

  it('shares one socket with another device client', () => {
    const socket = new DaemonSocket()
    const first = new GripperClient(socket)
    const second = new GripperClient(socket)
    socket.connect()
    const ws = FakeWebSocket.instances.at(-1)!
    ws.open()
    ws.receive({ t: 'gripper_conn', status: 'disconnected', channel: 'can0', canId: 8, travelMm: 85 })
    expect(first.conn?.channel).toBe('can0')
    expect(second.conn?.channel).toBe('can0')
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})

describe('normalizeGripperState', () => {
  it('handles null and junk', () => {
    expect(normalizeGripperState(null)).toBeNull()
    expect(normalizeGripperState('nope')).toBeNull()
  })

  it('fills missing fields with safe defaults and keeps position unknown', () => {
    const state = normalizeGripperState({})
    expect(state).toMatchObject({
      positionMm: null,
      forceN: 0,
      enabled: false,
      state: 'disabled',
      errorCode: 0,
      temps: { mosTemp: 0, coilTemp: 0 },
      fresh: false,
      gate: null,
    })
  })
})

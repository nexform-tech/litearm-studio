import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RobotState } from './client'

const connectMock = vi.fn()
const closeMock = vi.fn()
const requestStopMock = vi.fn()
const clearStopMock = vi.fn()
const homeMock = vi.fn()
const movejMock = vi.fn()
const deviceMock = vi.fn()
const getStateMock = vi.fn()
const listDeviceTypesMock = vi.fn()
const connectDeviceMock = vi.fn()
const disconnectDeviceMock = vi.fn()
const getActiveDeviceMock = vi.fn()
const getDeviceManifestMock = vi.fn()
let connectedFlag = false

vi.mock('litearm-js/browser', () => ({
  Arm: class MockArm {
    endpoint: string
    token?: string
    constructor(endpoint: string, token?: string) {
      this.endpoint = endpoint
      this.token = token
    }
    connect = connectMock
    close = closeMock
    requestStop = requestStopMock
    clearStop = clearStopMock
    home = homeMock
    movej = movejMock
    device = deviceMock
    getState = getStateMock
    listDeviceTypes = listDeviceTypesMock
    connectDevice = connectDeviceMock
    disconnectDevice = disconnectDeviceMock
    getActiveDevice = getActiveDeviceMock
    getDeviceManifest = getDeviceManifestMock
    get connected() {
      return connectedFlag
    }
  },
}))

const { ArmClient } = await import('./client')

describe('ArmClient', () => {
  let client: InstanceType<typeof ArmClient>

  beforeEach(() => {
    vi.useFakeTimers()
    connectMock.mockReset()
    closeMock.mockReset()
    requestStopMock.mockReset()
    clearStopMock.mockReset()
    homeMock.mockReset()
    movejMock.mockReset()
    deviceMock.mockReset()
    getStateMock.mockReset()
    listDeviceTypesMock.mockReset()
    connectDeviceMock.mockReset()
    disconnectDeviceMock.mockReset()
    getActiveDeviceMock.mockReset()
    getDeviceManifestMock.mockReset()
    // Mirrors the real Arm: once connect() resolves, `.connected` reads true
    // until close()/network-drop — the client's rAF poll loop relies on this
    // to decide whether it's still live.
    connectedFlag = true
    client = new ArmClient()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts disconnected', () => {
    expect(client.status).toBe('disconnected')
    expect(client.state).toBeNull()
  })

  it('goes connecting → connected on a successful connect(), and notifies status listeners', async () => {
    connectMock.mockResolvedValue(undefined)
    const statuses: string[] = []
    client.subscribeStatus(() => statuses.push(client.status))

    client.connect('192.168.1.10:7449', 'tok')
    expect(client.status).toBe('connecting')

    await vi.waitFor(() => expect(client.status).toBe('connected'))
    expect(statuses).toContain('connected')
    expect(client.lastError).toBeNull()
  })

  it('polls getState() once connected and notifies state listeners on change', async () => {
    connectMock.mockResolvedValue(undefined)
    connectedFlag = true
    const state1 = { q: [1] } as any
    getStateMock.mockReturnValue(state1)

    const stateNotifications: unknown[] = []
    client.subscribeState(() => stateNotifications.push(client.state))

    client.connect('endpoint')
    await vi.waitFor(() => expect(client.status).toBe('connected'))

    // rAF-driven polling loop needs the fake clock nudged forward.
    await vi.advanceTimersByTimeAsync(50)
    expect(client.state).toMatchObject(state1)
    expect(stateNotifications[stateNotifications.length - 1]).toMatchObject(state1)
  })

  it('fast state subscribers get every frame while regular subscribers are throttled', async () => {
    connectMock.mockResolvedValue(undefined)
    connectedFlag = true
    let frame = 0
    // 每帧返回新对象（模拟真机 50Hz 广播 decode），但安全字段不变。
    getStateMock.mockImplementation(() => ({ q: [frame++] } as any))
    let fast = 0
    let slow = 0
    client.subscribeStateFast(() => fast++)
    client.subscribeState(() => slow++)

    client.connect('endpoint')
    await vi.waitFor(() => expect(client.status).toBe('connected'))
    await vi.advanceTimersByTimeAsync(500)

    // 高速通道按帧触发（500ms ≈ 30 帧），普通通道被限制在 ~10Hz。
    expect(fast).toBeGreaterThan(20)
    expect(slow).toBeLessThanOrEqual(8)
  })

  it('goes to error and schedules a reconnect when connect() rejects', async () => {
    connectMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined)

    client.connect('endpoint')
    await vi.waitFor(() => expect(client.status).toBe('error'))
    expect(client.lastError).toBe('boom')
    expect(connectMock).toHaveBeenCalledTimes(1)

    // First reconnect delay is 1000ms.
    await vi.advanceTimersByTimeAsync(1000)
    expect(connectMock).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(client.status).toBe('connected'))
  })

  it('disconnect() closes the socket, clears state, and cancels any pending reconnect', async () => {
    connectMock.mockRejectedValue(new Error('boom'))
    client.connect('endpoint')
    await vi.waitFor(() => expect(client.status).toBe('error'))

    client.disconnect()
    expect(client.status).toBe('disconnected')
    expect(client.state).toBeNull()

    // No reconnect should fire after disconnecting.
    await vi.advanceTimersByTimeAsync(5000)
    expect(connectMock).toHaveBeenCalledTimes(1)
  })

  it('connect() during reconnect backoff cancels the timer and retries immediately', async () => {
    connectMock.mockResolvedValue(undefined)
    client.connect('endpoint')
    await vi.waitFor(() => expect(client.status).toBe('connected'))
    expect(connectMock).toHaveBeenCalledTimes(1)

    // 模拟连接后断流：poll 发现 socket 已死，进入 reconnecting 并挂起退避定时器
    connectedFlag = false
    await vi.advanceTimersByTimeAsync(50)
    expect(client.status).toBe('reconnecting')
    expect(connectMock).toHaveBeenCalledTimes(1)

    // 用户点击「连接」：应取消退避并立即重连，而不是等 1s 定时器
    connectedFlag = true // 新 socket 建立后 .connected 恢复为 true
    client.connect('endpoint')
    expect(client.status).toBe('connecting')
    await vi.waitFor(() => expect(client.status).toBe('connected'))
    expect(connectMock).toHaveBeenCalledTimes(2)

    // 被取消的退避定时器不应再触发一次多余的连接
    await vi.advanceTimersByTimeAsync(5000)
    expect(connectMock).toHaveBeenCalledTimes(2)
  })

  it('disconnect() closes the live arm', async () => {
    connectMock.mockResolvedValue(undefined)
    client.connect('endpoint')
    await vi.waitFor(() => expect(client.status).toBe('connected'))

    client.disconnect()
    expect(closeMock).toHaveBeenCalledTimes(1)
  })

  it('requestStop() is a no-op while disconnected, and delegates once connected', async () => {
    expect(() => client.requestStop()).not.toThrow()
    expect(requestStopMock).not.toHaveBeenCalled()

    connectMock.mockResolvedValue(undefined)
    client.connect('endpoint')
    await vi.waitFor(() => expect(client.status).toBe('connected'))

    client.requestStop()
    expect(requestStopMock).toHaveBeenCalledTimes(1)
  })

  it('home() rejects while disconnected', async () => {
    await expect(client.home()).rejects.toThrow('机械臂未连接')
    expect(homeMock).not.toHaveBeenCalled()
  })

  it('home() delegates to the live arm once connected', async () => {
    connectMock.mockResolvedValue(undefined)
    homeMock.mockResolvedValue(true)
    client.connect('endpoint')
    await vi.waitFor(() => expect(client.status).toBe('connected'))

    await expect(client.home({ speed: 0.3, settle_s: 0 })).resolves.toBe(true)
    expect(homeMock).toHaveBeenCalledWith({ speed: 0.3, settle_s: 0 })
  })

  it('movej() rejects while disconnected', async () => {
    await expect(client.movej([0, 0, 0])).rejects.toThrow('机械臂未连接')
    expect(movejMock).not.toHaveBeenCalled()
  })

  it('movej() delegates to the live arm once connected', async () => {
    connectMock.mockResolvedValue(undefined)
    movejMock.mockResolvedValue(true)
    client.connect('endpoint')
    await vi.waitFor(() => expect(client.status).toBe('connected'))

    await expect(client.movej([1, 2, 3], { speed: 0.5 })).resolves.toBe(true)
    expect(movejMock).toHaveBeenCalledWith([1, 2, 3], { speed: 0.5 })
  })

  it('device() returns null while disconnected and the proxy once connected', async () => {
    expect(client.device('gripper_0')).toBeNull()

    connectMock.mockResolvedValue(undefined)
    const proxy = { setWidth: vi.fn() }
    deviceMock.mockReturnValue(proxy)
    client.connect('endpoint')
    await vi.waitFor(() => expect(client.status).toBe('connected'))

    expect(client.device('gripper_0')).toBe(proxy)
    expect(deviceMock).toHaveBeenCalledWith('gripper_0')
  })

  it('delegates the new end-effector management APIs once connected', async () => {
    connectMock.mockResolvedValue(undefined)
    listDeviceTypesMock.mockResolvedValue([{ category: 'gripper', subtype: 'litegrip', name: '夹爪', icon: 'x' }])
    connectDeviceMock.mockResolvedValue({ ok: true })
    disconnectDeviceMock.mockResolvedValue({ ok: true })
    getActiveDeviceMock.mockResolvedValue({ online: true, category: 'gripper' })
    getDeviceManifestMock.mockResolvedValue({ name: 'gripper' })

    client.connect('endpoint')
    await vi.waitFor(() => expect(client.status).toBe('connected'))

    await expect(client.listDeviceTypes()).resolves.toHaveLength(1)
    await expect(client.connectDevice('gripper', 'litegrip', { deviceId: 'end_0' })).resolves.toEqual({ ok: true })
    await expect(client.disconnectDevice('end_0')).resolves.toEqual({ ok: true })
    await expect(client.getActiveDevice('end_0')).resolves.toMatchObject({ online: true, category: 'gripper' })
    await expect(client.getDeviceManifest('end_0')).resolves.toEqual({ name: 'gripper' })

    expect(listDeviceTypesMock).toHaveBeenCalledTimes(1)
    expect(connectDeviceMock).toHaveBeenCalledWith('gripper', 'litegrip', { deviceId: 'end_0' })
    expect(disconnectDeviceMock).toHaveBeenCalledWith('end_0')
    expect(getActiveDeviceMock).toHaveBeenCalledWith('end_0')
    expect(getDeviceManifestMock).toHaveBeenCalledWith('end_0')
  })

  it('withArm() rejects while disconnected and runs the callback once connected', async () => {
    await expect(client.withArm((a) => a.close() as any)).rejects.toThrow('机械臂未连接')

    connectMock.mockResolvedValue(undefined)
    client.connect('endpoint')
    await vi.waitFor(() => expect(client.status).toBe('connected'))

    const fn = vi.fn().mockResolvedValue('ok')
    await expect(client.withArm(fn)).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('withArm() converts a synchronous callback throw into a rejected promise', async () => {
    connectMock.mockResolvedValue(undefined)
    client.connect('endpoint')
    await vi.waitFor(() => expect(client.status).toBe('connected'))

    await expect(client.withArm(() => {
      throw new Error('removed SDK method')
    })).rejects.toThrow('removed SDK method')
  })

  it('a redundant connect() to the same endpoint while already connecting/connected is a no-op', async () => {
    connectMock.mockResolvedValue(undefined)
    client.connect('endpoint')
    client.connect('endpoint')
    await vi.waitFor(() => expect(client.status).toBe('connected'))
    expect(connectMock).toHaveBeenCalledTimes(1)
  })

  it('connect() from error state cancels the pending reconnect timer and opens a single fresh socket', async () => {
    connectMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined)
    client.connect('endpoint')
    await vi.waitFor(() => expect(client.status).toBe('error'))
    expect(connectMock).toHaveBeenCalledTimes(1)

    // A remount/HMR reconnect lands before the 1000ms reconnect timer fires.
    client.connect('endpoint')
    expect(connectMock).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(client.status).toBe('connected'))

    // The superseded timer must not open a third socket.
    await vi.advanceTimersByTimeAsync(5000)
    expect(connectMock).toHaveBeenCalledTimes(2)
  })

  it('connect() to a new endpoint closes the superseded socket', async () => {
    connectMock.mockResolvedValue(undefined)
    client.connect('first')
    await vi.waitFor(() => expect(client.status).toBe('connected'))

    client.connect('second')
    expect(closeMock).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(client.status).toBe('connected'))
    expect(connectMock).toHaveBeenCalledTimes(2)
  })

  it('rejects a second motion while the first is still in flight', async () => {
    connectMock.mockResolvedValue(undefined)
    let settleFirst!: (v: boolean) => void
    movejMock.mockImplementation(() => new Promise<boolean>((res) => { settleFirst = res }))
    client.connect('endpoint')
    await vi.waitFor(() => expect(client.status).toBe('connected'))

    const first = client.movej([0.1], { speed: 0.1 })
    expect(client.motionBusy).toBe(true)

    await expect(client.movej([0.2], { speed: 0.1 })).rejects.toThrow('正在运动')
    expect(movejMock).toHaveBeenCalledTimes(1)

    settleFirst(true)
    await expect(first).resolves.toBe(true)
    expect(client.motionBusy).toBe(false)
  })

  it('allows a new motion after the previous one completes', async () => {
    connectMock.mockResolvedValue(undefined)
    let settle!: (v: boolean) => void
    let calls = 0
    movejMock.mockImplementation(() => {
      calls += 1
      if (calls === 1) return new Promise<boolean>((res) => { settle = res })
      return Promise.resolve(true)
    })
    client.connect('endpoint')
    await vi.waitFor(() => expect(client.status).toBe('connected'))

    const first = client.movej([0.1], {})
    settle(true)
    await first

    await expect(client.movej([0.2], {})).resolves.toBe(true)
    expect(client.motionBusy).toBe(false)
  })

  it('releases the motion lock when the connection drops mid-motion', async () => {
    connectMock.mockResolvedValue(undefined)
    // 模拟运动 RPC 永不返回（网络断开时底层 pending 不会 settle）。
    movejMock.mockImplementation(() => new Promise<boolean>(() => {}))
    client.connect('endpoint')
    await vi.waitFor(() => expect(client.status).toBe('connected'))

    void client.movej([0.1], {})
    expect(client.motionBusy).toBe(true)

    client.disconnect()
    expect(client.motionBusy).toBe(false)
  })
})

describe('normalizeRobotState', () => {
  it('handles null and undefined', async () => {
    const { normalizeRobotState } = await import('./client')
    expect(normalizeRobotState(null)).toBeNull()
    expect(normalizeRobotState(undefined)).toBeNull()
  })

  it('fills empty objects in temps with zero temperatures (protobuf defaults)', async () => {
    const { normalizeRobotState } = await import('./client')
    const raw = {
      temps: [{}, { mosTemp: 42 }, { coilTemp: 55 }],
    } as unknown as RobotState
    const res = normalizeRobotState(raw)
    expect(res?.temps).toEqual([
      { mosTemp: 0, coilTemp: 0 },
      { mosTemp: 42, coilTemp: 0 },
      { mosTemp: 0, coilTemp: 55 },
    ])
  })

  it('guarantees arrays for q, dq, tau, errs, fault', async () => {
    const { normalizeRobotState } = await import('./client')
    const res = normalizeRobotState({} as any)
    expect(res?.q).toEqual([])
    expect(res?.dq).toEqual([])
    expect(res?.tau).toEqual([])
    expect(res?.errs).toEqual([])
    expect(res?.fault).toEqual([])
    expect(res?.temps).toEqual([])
    expect(res?.state).toBe('idle')
  })
})

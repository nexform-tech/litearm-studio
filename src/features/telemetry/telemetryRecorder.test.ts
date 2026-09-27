import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => {
  const stateListeners = new Set<() => void>()
  const statusListeners = new Set<() => void>()
  return {
    stateListeners,
    statusListeners,
    armStatus: 'disconnected',
    armState: null as null | Record<string, unknown>,
    armConn: { status: 'disconnected', port: null as string | null, firmware: '', n: 0, cart: false, error: null },
  }
})

vi.mock('@/lib/arm/client', () => ({
  armClient: {
    get status() {
      return mock.armStatus
    },
    get state() {
      return mock.armState
    },
    get conn() {
      return mock.armConn
    },
    subscribeState: (cb: () => void) => {
      mock.stateListeners.add(cb)
      return () => mock.stateListeners.delete(cb)
    },
    subscribeStatus: (cb: () => void) => {
      mock.statusListeners.add(cb)
      return () => mock.statusListeners.delete(cb)
    },
  },
}))

import { telemetryDb } from './telemetryDb'
import { telemetryRecorder } from './telemetryRecorder'

function setConnected() {
  mock.armStatus = 'connected'
  mock.armConn = { status: 'connected', port: '/dev/ttyACM0', firmware: 'Litearm1.8.0-7J', n: 7, cart: true, error: null }
  mock.armState = {
    q: [0.1, 0.2],
    dq: [0, 0],
    tau: [0.5, -0.2],
    temps: [],
    errs: [],
    fault: [],
    state: 'ready',
  }
  for (const cb of [...mock.statusListeners]) cb()
}

function emitStates(n: number) {
  for (let i = 0; i < n; i++) {
    for (const cb of [...mock.stateListeners]) cb()
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('telemetryRecorder', () => {
  beforeEach(async () => {
    await telemetryDb.clearAll()
    localStorage.clear()
    mock.armStatus = 'disconnected'
    mock.armState = null
    telemetryRecorder.start()
  })

  afterEach(() => {
    telemetryRecorder.stop()
  })

  it('opens a session on connect and persists samples', async () => {
    setConnected()
    emitStates(12)
    await wait(1200) // 等 1s 定时批量落盘

    const sessions = await telemetryDb.listSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].endedAt).toBeNull()
    expect(sessions[0].port).toBe('/dev/ttyACM0')
    expect(await telemetryDb.totalSamples()).toBe(12)
  })

  it('reuses the session when reconnecting within 30s', async () => {
    setConnected()
    emitStates(10)
    await wait(1200)

    mock.armStatus = 'disconnected'
    for (const cb of [...mock.statusListeners]) cb()
    setConnected()
    emitStates(5)
    await wait(1200)

    const sessions = await telemetryDb.listSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].endedAt).toBeNull()
    expect(await telemetryDb.totalSamples()).toBe(15)
  })

  it('ends the session on stop', async () => {
    setConnected()
    emitStates(5)
    await wait(1200)

    telemetryRecorder.stop()
    await wait(100)

    const sessions = await telemetryDb.listSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].endedAt).not.toBeNull()
  })

  it('applies a user-configured retention cap and clamps it to the allowed range', () => {
    expect(telemetryRecorder.getStatus().maxBytes).toBe(10 * 1024 * 1024)

    expect(telemetryRecorder.setRetentionMb(20)).toBe(20)
    expect(telemetryRecorder.getStatus().maxBytes).toBe(20 * 1024 * 1024)

    expect(telemetryRecorder.setRetentionMb(1)).toBe(10)
    expect(telemetryRecorder.getStatus().maxBytes).toBe(10 * 1024 * 1024)
  })

  it('keeps its receiver when invoked through a detached reference (hook exposure)', () => {
    // useTelemetryState 把 recorder 方法以引用形式暴露给组件调用，
    // 方法必须不依赖调用方的 this（否则保存上限时会抛 this.maybePrune is not a function）。
    const exposed = { setRetentionMb: telemetryRecorder.setRetentionMb }
    expect(() => exposed.setRetentionMb(30)).not.toThrow()
    expect(telemetryRecorder.getStatus().maxBytes).toBe(30 * 1024 * 1024)
  })
})

import 'fake-indexeddb/auto'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/arm/useArmConnection', () => ({
  useArmConnection: () => ({
    status: 'connected',
    conn: { status: 'connected', port: '/dev/ttyACM0', firmware: 'Litearm1.8.0-7J', n: 7, cart: true, error: null },
  }),
}))

import { telemetryDb } from './telemetryDb'
import { useTelemetryState } from './useTelemetryState'

function sample(ts: number) {
  return {
    ts,
    state: 'holding',
    q: [0.1, 0.2],
    dq: [0, 0],
    tau: [0.5, -0.2],
    temps: [],
    errs: [],
    faults: [],
  }
}

describe('useTelemetryState', () => {
  beforeEach(async () => {
    await telemetryDb.clearAll()
  })

  it('retries and shows samples once a new session gets data', async () => {
    // 模拟刚打开上位机：新会话已建但记录器还没落盘任何采样
    const id = await telemetryDb.addSession(Date.now() / 1000, '/dev/ttyACM0', 'GENERIC-V4')

    const { result } = renderHook(() => useTelemetryState())
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    expect(result.current.selectedId).toBe(id)
    expect(result.current.samples).toHaveLength(0)

    // 记录器随后写入采样
    await telemetryDb.addSamples(id, [sample(Date.now() / 1000)])

    // 下一个自动刷新周期（3s）应把采样带出来，而不是一直停在"该会话暂无采样"
    await waitFor(() => expect(result.current.samples.length).toBeGreaterThan(0), {
      timeout: 7000,
    })
    expect(result.current.samples[0].state).toBe('holding')
  })

  it('loadOlder keeps advancing past the view cap and retains the oldest window', async () => {
    const id = await telemetryDb.addSession(Date.now() / 1000, '/dev/ttyACM0', 'GENERIC-V4')
    await telemetryDb.addSamples(
      id,
      Array.from({ length: 2100 }, (_, i) => sample(i + 1)),
    )

    const { result } = renderHook(() => useTelemetryState())
    await waitFor(() => expect(result.current.samples).toHaveLength(200), { timeout: 5000 })
    expect(result.current.hasMore).toBe(true)

    // 9 次翻页后视图恰好到达 2000 条上限
    for (let i = 0; i < 9; i++) {
      act(() => result.current.loadOlder())
      await waitFor(() => expect(result.current.samples).toHaveLength(200 + (i + 1) * 200), { timeout: 5000 })
    }

    // 第 10 次翻页追加 100 条后超出上限：应从头部裁掉最新部分，而不是丢弃新加载的旧数据
    act(() => result.current.loadOlder())
    await waitFor(() => expect(result.current.hasMore).toBe(false), { timeout: 5000 })
    const rows = result.current.samples
    expect(rows).toHaveLength(2000)
    expect(rows[0].ts).toBe(2000)
    expect(rows[rows.length - 1].ts).toBe(1)
  }, 15000)

  it('keeps the selected newest session after saving the retention cap', async () => {
    const old = await telemetryDb.addSession(Date.now() / 1000 - 100, '/dev/ttyACM0', 'GENERIC-V4')
    await telemetryDb.addSamples(old, [sample(Date.now() / 1000 - 99)])
    // 最新会话刚建立、还没有采样（当前记录会话）
    const newest = await telemetryDb.addSession(Date.now() / 1000, '/dev/ttyACM0', 'GENERIC-V4')

    const { result } = renderHook(() => useTelemetryState())
    await waitFor(() => expect(result.current.selectedId).toBe(newest))

    // 保存保留上限会立即触发裁剪：不能把正在记录的最新会话当空会话删掉
    act(() => result.current.setRetentionMb(50))

    // 等一个完整刷新周期：若裁剪误删了最新会话，自动跟随会跳到旧会话
    await new Promise((resolve) => setTimeout(resolve, 3500))
    expect(result.current.selectedId).toBe(newest)
    expect((await telemetryDb.listSessions()).map((s) => s.id)).toContain(newest)
  }, 15000)
})

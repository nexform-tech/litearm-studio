import 'fake-indexeddb/auto'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'

vi.mock('@/lib/arm/useArmConnection', () => ({
  useArmConnection: () => ({
    status: 'connected',
    conn: { status: 'connected', port: '/dev/ttyACM0', firmware: 'Litearm1.8.0-7J', n: 7, cart: true, error: null },
  }),
}))

vi.mock('@/lib/export', () => ({
  exportFile: vi.fn(async () => ({ kind: 'saved', path: '/tmp/telemetry.csv' })),
}))

import { exportFile } from '@/lib/export'
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

/** 指定轴数的采样 —— 用来造"同一个会话里换过台架"的那种文件。 */
function axisSample(ts: number, axes: number) {
  return {
    ts,
    state: 'holding',
    q: Array.from({ length: axes }, (_, i) => 0.1 * (i + 1)),
    dq: Array.from({ length: axes }, () => 0),
    tau: Array.from({ length: axes }, (_, i) => 0.5 * (i + 1)),
    temps: [],
    errs: [0, 1],
    faults: [],
  }
}

/** 按 CSV 规则切一行：引号里的逗号不是分隔符（`errs` 是 JSON，天然带逗号）。 */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else quoted = false
      } else cur += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

describe('useTelemetryState', () => {
  beforeEach(async () => {
    await telemetryDb.clearAll()
  })

  afterEach(async () => {
    await i18n.changeLanguage('zh')
  })

  it('retries and shows samples once a new session gets data', async () => {
    // 模拟刚打开上位机：新会话已建但记录器还没落盘任何采样
    const id = await telemetryDb.addSession(Date.now() / 1000, '/dev/ttyACM0')

    const { result } = renderHook(() => useTelemetryState())
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    expect(result.current.selectedId).toBe(id)
    expect(result.current.samples).toHaveLength(0)

    // 记录器随后写入采样
    await telemetryDb.addSamples(id, [sample(Date.now() / 1000)])

    // 下一个自动刷新周期（3s）应把采样带出来，而不是一直停在"该会话暂无采样"
    await waitFor(() => expect(result.current.samples.length).toBeGreaterThan(0), {
      timeout: 15000,
    })
    expect(result.current.samples[0].state).toBe('holding')
  })

  it('loadOlder keeps advancing past the view cap and retains the oldest window', async () => {
    const id = await telemetryDb.addSession(Date.now() / 1000, '/dev/ttyACM0')
    await telemetryDb.addSamples(
      id,
      Array.from({ length: 2100 }, (_, i) => sample(i + 1)),
    )

    const { result } = renderHook(() => useTelemetryState())
    await waitFor(() => expect(result.current.samples).toHaveLength(200), { timeout: 30000 })
    expect(result.current.hasMore).toBe(true)

    // 9 次翻页后视图恰好到达 2000 条上限
    for (let i = 0; i < 9; i++) {
      act(() => result.current.loadOlder())
      await waitFor(() => expect(result.current.samples).toHaveLength(200 + (i + 1) * 200), { timeout: 30000 })
    }

    // 第 10 次翻页追加 100 条后超出上限：应从头部裁掉最新部分，而不是丢弃新加载的旧数据
    act(() => result.current.loadOlder())
    await waitFor(() => expect(result.current.hasMore).toBe(false), { timeout: 30000 })
    const rows = result.current.samples
    expect(rows).toHaveLength(2000)
    expect(rows[0].ts).toBe(2000)
    expect(rows[rows.length - 1].ts).toBe(1)
    // 这条用例要翻满 10 页才越过 2000 条视图上限，每页实测约 0.8s（其中数据库查询约
    // 0.35s，其余是 React + waitFor 的开销）——正常 ~9s，机器满载时更长。上限按最坏
    // 情况给，判据一个字没动。
  }, 60000)

  it('keeps the selected newest session after saving the retention cap', async () => {
    const old = await telemetryDb.addSession(Date.now() / 1000 - 100, '/dev/ttyACM0')
    await telemetryDb.addSamples(old, [sample(Date.now() / 1000 - 99)])
    // 最新会话刚建立、还没有采样（当前记录会话）
    const newest = await telemetryDb.addSession(Date.now() / 1000, '/dev/ttyACM0')

    const { result } = renderHook(() => useTelemetryState())
    await waitFor(() => expect(result.current.selectedId).toBe(newest))

    // 保存保留上限会立即触发裁剪：不能把正在记录的最新会话当空会话删掉
    act(() => result.current.setRetentionMb(50))

    // 等一个完整刷新周期：若裁剪误删了最新会话，自动跟随会跳到旧会话
    await new Promise((resolve) => setTimeout(resolve, 3500))
    expect(result.current.selectedId).toBe(newest)
    expect((await telemetryDb.listSessions()).map((s) => s.id)).toContain(newest)
  }, 15000)

  // 存储层抛出的那句话也会被直接摆到界面上（面板显示 `err.message`），所以它必须跟着
  // 界面语言走，而不是一句写死的中文。
  it('reports a missing session in the interface language', async () => {
    await i18n.changeLanguage('en')
    const { result } = renderHook(() => useTelemetryState())

    await act(async () => {
      await result.current.exportSession(999_999)
    })

    expect(result.current.error).toBe('that session no longer exists')
  })

  // ⚠ 会话在断线 30s 内重连就延续（见 telemetryRecorder），中途换过台架（7J → 1J）的
  // 会话里因此有**两种宽度的行**。表头只写一次，它必须取整段会话的上限 —— 按第一帧
  // 定宽的话，窄的那一行会整段左移，`errs` 又落到 `dq4` 底下，正是这次要修的东西。
  it('exports one header wide enough for every sample in the session', async () => {
    const id = await telemetryDb.addSession(Date.now() / 1000, '/dev/ttyACM0')
    // 窄的在前：只看第一帧的话，表头写出来就是 3 轴，后两行会多出 4 列。
    await telemetryDb.addSamples(id, [
      axisSample(1700000000, 3),
      axisSample(1700000001, 7),
      axisSample(1700000002, 3),
    ])

    const { result } = renderHook(() => useTelemetryState())
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    await act(async () => {
      await result.current.exportSession(id)
    })

    const calls = vi.mocked(exportFile).mock.calls
    const blob = calls[calls.length - 1][0]
    const lines = (await blob.text()).split('\n').filter((l) => l.length > 0)
    const rows = lines.map(splitCsvLine)

    // 表头按整段会话定宽（7 轴），每一行都与它同宽
    expect(rows[0]).toContain('q7')
    for (const row of rows.slice(1)) expect(row).toHaveLength(rows[0].length)

    // 窄的那两行：缺的轴留白，`errs` 仍落在自己的标题下面
    const at = (row: string[], name: string) => row[rows[0].indexOf(name)]
    for (const row of [rows[1], rows[3]]) {
      expect(at(row, 'q3')).toBe('0.30000000000000004')
      expect(at(row, 'q4')).toBe('')
      expect(at(row, 'errs')).toBe('[0,1]')
    }
    // 宽的那一行铺满，尾部不漏
    expect(at(rows[2], 'q7')).toBe('0.7000000000000001')
    expect(at(rows[2], 'errs')).toBe('[0,1]')
  })
})

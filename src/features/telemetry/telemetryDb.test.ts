import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { estimateSampleBytes, telemetryDb, type NewTelemetrySample } from './telemetryDb'

function sample(ts: number): NewTelemetrySample {
  return {
    ts,
    state: 'holding',
    q: [0.1, 0.2],
    dq: [0, 0],
    tau: [0.5, -0.2],
    temps: [
      { mosTemp: 33, coilTemp: 27 },
      { mosTemp: 30, coilTemp: 28 },
    ],
    errs: [1, 1],
    faults: [],
  }
}

describe('telemetryDb', () => {
  beforeEach(async () => {
    await telemetryDb.clearAll()
  })

  it('adds sessions and samples, lists sessions with counts', async () => {
    const id = await telemetryDb.addSession(1000, '127.0.0.1:7449', 'GENERIC-V4')
    await telemetryDb.addSamples(id, [sample(1), sample(2)])

    const sessions = await telemetryDb.listSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].id).toBe(id)
    expect(sessions[0].endpoint).toBe('127.0.0.1:7449')
    expect(sessions[0].sampleCount).toBe(2)
    expect(await telemetryDb.totalSamples()).toBe(2)
  })

  it('returns samples newest-first and filters by before/after ts', async () => {
    const id = await telemetryDb.addSession(0, 'x', '')
    await telemetryDb.addSamples(id, [sample(1), sample(2), sample(3)])

    expect((await telemetryDb.getSamples(id)).map((s) => s.ts)).toEqual([3, 2, 1])
    expect((await telemetryDb.getSamples(id, { afterTs: 2 })).map((s) => s.ts)).toEqual([3, 2])
    expect((await telemetryDb.getSamples(id, { beforeTs: 3 })).map((s) => s.ts)).toEqual([2, 1])
  })

  it('queries samples only within the selected session', async () => {
    const a = await telemetryDb.addSession(0, 'x', '')
    const b = await telemetryDb.addSession(1, 'y', '')
    await telemetryDb.addSamples(a, [sample(1), sample(3), sample(5)])
    await telemetryDb.addSamples(b, [sample(2), sample(4)])

    expect((await telemetryDb.getSamples(a)).map((s) => s.ts)).toEqual([5, 3, 1])
    expect((await telemetryDb.getSamples(b)).map((s) => s.ts)).toEqual([4, 2])
    expect((await telemetryDb.getSamples(a, { beforeTs: 5 })).map((s) => s.ts)).toEqual([3, 1])
    expect((await telemetryDb.getSamples(a, { afterTs: 1 })).map((s) => s.ts)).toEqual([5, 3, 1])
  })

  it('pages ascending samples with exact (ts, id) boundaries', async () => {
    const id = await telemetryDb.addSession(0, 'x', '')
    // 含相同 ts 的采样：分页边界必须不重不漏
    await telemetryDb.addSamples(id, [sample(1), sample(1), sample(2), sample(2), sample(2), sample(3)])

    const page1 = await telemetryDb.getSamplesAsc(id, { limit: 3 })
    expect(page1.map((s) => s.ts)).toEqual([1, 1, 2])
    const last1 = page1[page1.length - 1]
    const page2 = await telemetryDb.getSamplesAsc(id, { limit: 3, after: { ts: last1.ts, id: last1.id as number } })
    expect(page2.map((s) => s.ts)).toEqual([2, 2, 3])
    const last2 = page2[page2.length - 1]
    const page3 = await telemetryDb.getSamplesAsc(id, { limit: 3, after: { ts: last2.ts, id: last2.id as number } })
    expect(page3).toHaveLength(0)
  })

  it('estimates sample bytes deterministically', () => {
    expect(estimateSampleBytes(sample(1))).toBe(272)
    const big = sample(1)
    big.faults = [{ joint: 2, errCode: 1001 }]
    expect(estimateSampleBytes(big)).toBeGreaterThan(272)
  })

  it('prunes to max estimated bytes keeping the newest data', async () => {
    const perSample = estimateSampleBytes(sample(1))
    const id = await telemetryDb.addSession(0, 'x', '')
    await telemetryDb.addSamples(
      id,
      Array.from({ length: 50 }, (_, i) => sample(i + 1)),
    )
    expect((await telemetryDb.getSession(id))?.estimatedBytes).toBe(50 * perSample)

    const deleted = await telemetryDb.pruneToMaxBytes(10 * perSample)

    expect(deleted).toBe(40)
    expect(await telemetryDb.totalSamples()).toBe(10)
    expect((await telemetryDb.getSession(id))?.estimatedBytes).toBe(10 * perSample)
    expect((await telemetryDb.getSamples(id)).map((s) => s.ts).sort((a, b) => a - b)).toEqual([
      41, 42, 43, 44, 45, 46, 47, 48, 49, 50,
    ])
  })

  it('drops whole oldest sessions before trimming within a session', async () => {
    const old = await telemetryDb.addSession(0, 'x', '')
    const newer = await telemetryDb.addSession(1, 'y', '')
    const perSample = estimateSampleBytes(sample(1))
    await telemetryDb.addSamples(old, Array.from({ length: 10 }, (_, i) => sample(i + 1)))
    await telemetryDb.addSamples(newer, Array.from({ length: 10 }, (_, i) => sample(100 + i)))

    // 预算只够最新会话的一半：应整删旧会话后，再从最新会话裁剪最旧采样
    const deleted = await telemetryDb.pruneToMaxBytes(5 * perSample)

    expect(deleted).toBe(15)
    const sessions = await telemetryDb.listSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].id).toBe(newer)
    expect(sessions[0].sampleCount).toBe(5)
    expect((await telemetryDb.getSamples(newer)).map((s) => s.ts).sort((a, b) => a - b)).toEqual([
      105, 106, 107, 108, 109,
    ])
  })

  it('caps sessions and drops sessions left without samples', async () => {
    const ids: number[] = []
    for (let i = 0; i < 5; i++) ids.push(await telemetryDb.addSession(i, 'x', ''))
    await telemetryDb.addSamples(ids[4], [sample(1)])
    // 生产流程中记录器启动时会先收尾上次异常退出的遗留会话（转为已结束）
    await telemetryDb.finalizeOpenSessions()

    await telemetryDb.pruneToMaxBytes(100_000, 3)

    const sessions = await telemetryDb.listSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].id).toBe(ids[4])
  })

  it('keeps the open recording session even when it has no samples yet', async () => {
    const old = await telemetryDb.addSession(0, 'x', '')
    await telemetryDb.addSamples(old, [sample(1)])
    // 最新会话刚建立、采样尚未落盘（正在记录中，endedAt 为 null）
    const newest = await telemetryDb.addSession(1, 'y', '')

    await telemetryDb.pruneToMaxBytes(100_000, 200)

    const sessions = await telemetryDb.listSessions()
    expect(sessions.map((s) => s.id)).toContain(newest)
  })

  it('drops finalized empty sessions but keeps the recording one', async () => {
    // 已结束的空会话：快速断开遗留，不应保留
    const closedEmpty = await telemetryDb.addSession(0, 'x', '')
    await telemetryDb.endSession(closedEmpty, 1)
    // 仍在记录的空会话：刚建立、采样尚未落盘
    const openEmpty = await telemetryDb.addSession(2, 'y', '')

    await telemetryDb.pruneToMaxBytes(100_000, 200)

    const sessions = await telemetryDb.listSessions()
    expect(sessions.map((s) => s.id)).not.toContain(closedEmpty)
    expect(sessions.map((s) => s.id)).toContain(openEmpty)
  })

  it('finalizes open sessions left by an abnormal exit', async () => {
    const open = await telemetryDb.addSession(10, 'x', '')
    await telemetryDb.finalizeOpenSessions()
    expect((await telemetryDb.getSession(open))?.endedAt).not.toBeNull()
  })
})

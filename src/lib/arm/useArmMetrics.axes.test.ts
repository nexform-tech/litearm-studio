import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'

// 指标面板以前按写死的 7 色建芯片与曲线，`{1J}` 台架上 6 个芯片恒为 `—`（issue #37）。
// 这里从 `conn` 帧的 `n` 出发，钉住"画几个轴"这件事。
const mocks = vi.hoisted(() => ({
  status: 'connected' as string,
  conn: null as unknown,
  armState: null as unknown,
}))

vi.mock('./useArmConnection', () => ({
  useArmConnection: () => ({ status: mocks.status, conn: mocks.conn }),
}))
vi.mock('./useArmState', () => ({ useArmState: () => mocks.armState }))

const { useArmMetrics } = await import('./useArmMetrics')

const conn = (n: number) => ({ status: 'connected', port: null, firmware: '', n, cart: true, error: null }) as never

/** 带 `count` 路温度/速度/力矩的广播帧，每路的读数即它的序号，便于断言一一对应。 */
const armWith = (count: number) => ({
  q: Array.from({ length: count }, () => 0),
  dq: Array.from({ length: count }, (_, i) => i + 1),
  tau: Array.from({ length: count }, (_, i) => i + 1),
  temps: Array.from({ length: count }, (_, i) => ({ mosTemp: i + 1 })),
  errs: Array.from({ length: count }, () => 0),
}) as never

describe('useArmMetrics axis count', () => {
  beforeEach(() => {
    mocks.status = 'connected'
    mocks.conn = conn(7)
    mocks.armState = armWith(7)
  })

  it('renders one chip per reported axis', () => {
    mocks.conn = conn(1)
    mocks.armState = armWith(1)

    const { result } = renderHook(() => useArmMetrics({ real: true }))

    expect(result.current.chips.map((c) => c.k)).toEqual(['J1'])
    // 读数不再挂在芯片上，而是按指标分开：温度那一路的 J1 读数就是它的序号。
    expect(result.current.metricSeries.find((m) => m.id === 'temp')?.live).toEqual(['1'])
    // 「全选」只能选出存在的轴。
    act(() => result.current.selectAll())
    expect(result.current.shown).toEqual([0])
  })

  it('renders the full arm when the daemon reports seven', () => {
    const { result } = renderHook(() => useArmMetrics({ real: true }))

    expect(result.current.chips.map((c) => c.k)).toEqual(['J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'J7'])
    expect(result.current.metricSeries.find((m) => m.id === 'temp')?.live?.[6]).toBe('7')
    act(() => result.current.selectAll())
    expect(result.current.shown).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('exposes the four metrics in priority order', () => {
    const { result } = renderHook(() => useArmMetrics({ real: true }))

    // 顺序即优先级：右列放不下时从后往前丢（跟踪误差最先让位）。
    expect(result.current.metricSeries.map((m) => m.id)).toEqual(['temp', 'dq', 'tau', 'err'])
    expect(result.current.metricSeries.map((m) => m.unit)).toEqual(['°C', 'rad/s', 'Nm', 'rad'])
  })

  it('marks the metric the real broadcast does not carry as having no data', () => {
    const { result } = renderHook(() => useArmMetrics({ real: true }))

    const err = result.current.metricSeries.find((m) => m.id === 'err')
    expect(err?.noData).toBe(true)
    // 实机不伪造跟踪误差曲线：读数为 null，图内显示「暂无数据」。
    expect(err?.live).toBeNull()
    expect(result.current.metricSeries.find((m) => m.id === 'temp')?.noData).toBe(false)
  })

  it('gives every axis its own colour and cycles the palette past seven', () => {
    mocks.conn = conn(9)
    mocks.armState = armWith(9)

    const { result } = renderHook(() => useArmMetrics({ real: true }))

    expect(result.current.chips).toHaveLength(9)
    const colors = result.current.chips.map((c) => c.color)
    expect(new Set(colors.slice(0, 7)).size).toBe(7)
    // 调色板是配色而不是轴数上限：第 8、9 个关节循环复用，不必新增颜色。
    expect(colors[7]).toBe(colors[0])
    expect(colors[8]).toBe(colors[1])
  })

  it('keeps the built-in arm in simulation mode', () => {
    mocks.conn = conn(1)

    const { result } = renderHook(() => useArmMetrics({ real: false }))

    expect(result.current.chips).toHaveLength(7)
    expect(result.current.simMode).toBe(true)
  })
})

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// `n` 来自 daemon 的 `conn` 帧，广播状态是拿不到它时的兜底 —— 这里同时钉住两条来源
// 和"仿真模式不跟着实机轴数变"这条规则。
const mocks = vi.hoisted(() => ({
  status: 'connected' as string,
  conn: null as unknown,
  armState: null as unknown,
}))

vi.mock('./useArmConnection', () => ({
  useArmConnection: () => ({ status: mocks.status, conn: mocks.conn }),
}))
vi.mock('./useArmState', () => ({ useArmState: () => mocks.armState }))

const { DEFAULT_JOINT_COUNT, MAX_JOINT_COUNT, jointIndexes, resolveJointCount, useJointCount } =
  await import('./axes')

const conn = (n: unknown) => ({ status: 'connected', port: null, firmware: '', n, cart: true, error: null }) as never
const state = (joints: number) => ({ q: Array.from({ length: joints }, () => 0) }) as never

describe('resolveJointCount', () => {
  beforeEach(() => {
    mocks.status = 'connected'
    mocks.conn = null
    mocks.armState = null
  })

  it('takes the count the daemon reported, whatever it is', () => {
    expect(resolveJointCount(conn(1), null)).toBe(1)
    expect(resolveJointCount(conn(7), null)).toBe(7)
    expect(resolveJointCount(conn(12), null)).toBe(12)
  })

  it('prefers the reported count over the broadcast, even mid-connect', () => {
    // `conn` 帧先于第一批 state 帧到达，此时广播可能还是空的。
    expect(resolveJointCount(conn(1), state(7))).toBe(1)
  })

  it('falls back to the broadcast length when n is missing, zero, or malformed', () => {
    for (const bogus of [undefined, null, 0, -3, Number.NaN, '4']) {
      expect(resolveJointCount(conn(bogus), state(3))).toBe(3)
    }
  })

  it('falls back to the built-in arm when nothing is known yet', () => {
    expect(resolveJointCount(null, null)).toBe(DEFAULT_JOINT_COUNT)
    expect(resolveJointCount(conn(0), state(0))).toBe(DEFAULT_JOINT_COUNT)
  })

  it('truncates a fractional count and refuses to build an absurd number of axes', () => {
    expect(resolveJointCount(conn(2.7), null)).toBe(2)
    expect(resolveJointCount(conn(1e6), null)).toBe(MAX_JOINT_COUNT)
  })
})

describe('jointIndexes', () => {
  it('lists exactly the axes that exist', () => {
    expect(jointIndexes(1)).toEqual([0])
    expect(jointIndexes(3)).toEqual([0, 1, 2])
  })

  it('never returns an empty or unbounded list', () => {
    expect(jointIndexes(0)).toEqual([0])
    expect(jointIndexes(-4)).toEqual([0])
    expect(jointIndexes(1e6)).toHaveLength(MAX_JOINT_COUNT)
  })
})

describe('useJointCount', () => {
  beforeEach(() => {
    mocks.status = 'connected'
    mocks.conn = conn(1)
    mocks.armState = null
  })

  it('follows the reported count in real mode', () => {
    expect(renderHook(() => useJointCount(true)).result.current).toBe(1)
  })

  it('keeps the built-in arm in simulation mode', () => {
    // 仿真姿态是前端自己造的（设计稿 7 轴），不该因为实机是 {1J} 就变成 1 根滑条。
    expect(renderHook(() => useJointCount(false)).result.current).toBe(DEFAULT_JOINT_COUNT)
  })

  it('settles on the broadcast length before the count is known', () => {
    mocks.conn = conn(0)
    mocks.armState = state(2)
    expect(renderHook(() => useJointCount(true)).result.current).toBe(2)
  })
})

import { describe, expect, it } from 'vitest'
import { describeArmFault, normalizeTrajList, type TrajRecord } from './soloUtils'

describe('normalizeTrajList', () => {
  it('sorts timestamped trajectories newest first regardless of server order', () => {
    const raw = [
      { id: 'trajectory_003', name: 'c', created_at: '2026-09-04T10:00:00Z' },
      { id: 'trajectory_001', name: 'a', created_at: '2026-09-04T08:00:00Z' },
      { id: 'trajectory_002', name: 'b', created_at: '2026-09-04T09:00:00Z' },
    ]
    expect(normalizeTrajList(raw).map((t) => t.id)).toEqual([
      'trajectory_003',
      'trajectory_002',
      'trajectory_001',
    ])
  })

  it('places records without a valid created_at after timestamped ones', () => {
    const raw = [
      { id: 'trajectory_010', created_at: 'garbage' },
      { id: 'trajectory_002', created_at: '2026-09-04T08:00:00Z' },
      { id: 'trajectory_001' },
    ]
    expect(normalizeTrajList(raw).map((t) => t.id)).toEqual([
      'trajectory_002',
      'trajectory_010',
      'trajectory_001',
    ])
  })

  it('falls back to numeric id order for legacy records without timestamps', () => {
    const raw = [
      { id: 'trajectory_2' },
      { id: 'trajectory_10' },
      { id: 'trajectory_1' },
    ]
    expect(normalizeTrajList(raw).map((t) => t.id)).toEqual([
      'trajectory_10',
      'trajectory_2',
      'trajectory_1',
    ])
  })

  it('accepts wrapped {trajectories} payloads and skips entries without an id', () => {
    const raw = {
      total: 2,
      trajectories: [
        { id: 'trajectory_002', created_at: '2026-09-04T09:00:00Z' },
        { frames: [] },
      ],
    }
    const list: TrajRecord[] = normalizeTrajList(raw)
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('trajectory_002')
  })
})

describe('describeArmFault with dry-run/empty states', () => {
  it('handles null, empty objects, and states with omitted repeated fields gracefully', () => {
    // 模拟 dry-run 或缺失 repeated 字段的空状态（如 protobuf.toJSON() 省略了空数组）
    expect(describeArmFault(null)).toBeNull()
    expect(describeArmFault({} as any)).toBeNull()
    expect(
      describeArmFault({
        state: 'ready',
        robotSerial: 'DRY-RUN',
      } as any),
    ).toBeNull()
  })
})


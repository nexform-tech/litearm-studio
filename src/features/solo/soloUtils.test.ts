import { describe, expect, it } from 'vitest'
import {
  JOINT_LIMITS,
  SEED_JOINT_PCT,
  describeArmFault,
  fitJointPct,
  fitJoints,
  jointRangeLabel,
  pctToRadNum,
} from './soloUtils'

describe('fitting per-axis values to the reported joint count', () => {
  it('trims a longer list and pads a shorter one', () => {
    expect(fitJoints([1, 2, 3], 2)).toEqual([1, 2])
    expect(fitJoints([1, 2, 3], 1)).toEqual([1])
    expect(fitJoints([1], 3)).toEqual([1, 0, 0])
    expect(fitJoints([], 2, 7)).toEqual([7, 7])
  })

  it('keeps a single-axis arm at one value', () => {
    expect(fitJoints([0, 0.5, 0, -1, 0, 0.6, 0], 1)).toEqual([0])
    expect(fitJointPct(SEED_JOINT_PCT, 1)).toEqual([SEED_JOINT_PCT[0]])
  })

  it('pads percentages with the built-in seeds instead of zero', () => {
    expect(fitJointPct([50], 3)).toEqual([50, SEED_JOINT_PCT[1], SEED_JOINT_PCT[2]])
    // 轴数超过内置表长时也不会变短（补 50%）
    expect(fitJointPct(SEED_JOINT_PCT, 9)).toHaveLength(9)
  })
})

describe('jointRangeLabel', () => {
  it('names the range without writing "J1–J1" for a single-axis arm', () => {
    expect(jointRangeLabel(1)).toBe('J1')
    expect(jointRangeLabel(2)).toBe('J1–J2')
    expect(jointRangeLabel(7)).toBe('J1–J7')
  })
})

describe('fallback joint limits', () => {
  //: 固件出厂默认的 7J 软限位。抄自 `litearm-tool-for-stm32/presets/current_master_defaults.yaml`
  //: （由固件 `defaults.c` 的 7J 表生成）与 `pylitearm/src/pylitearm/config/litearm.yaml` ——
  //: 就是说，回退量程必须**不比固件允许的范围宽**，否则滑条推到底就是在要求一个固件会拒绝
  //: 或钳住的角度（issue #133）。
  const FIRMWARE_SOFT_LIMITS: [number, number][] = [
    [-2.809547, 2.809547],
    [-1.727547, 1.727547],
    [-2.809547, 2.809547],
    [-3.071547, 0.017547],
    [-2.809547, 2.809547],
    [-1.553547, 1.553547],
    [-1.553547, 1.553547],
  ]

  it('is the firmware default table, axis by axis', () => {
    expect(JOINT_LIMITS).toHaveLength(FIRMWARE_SOFT_LIMITS.length)
    JOINT_LIMITS.forEach((range, i) => {
      expect([range.min, range.max]).toEqual(FIRMWARE_SOFT_LIMITS[i])
    })
  })

  it('maps a slider at 100% onto the firmware limit, not past it', () => {
    // 最坏的一轴：旧表给到 0.647 rad（37°），而固件在 0.017547 rad（1°）就停下。
    JOINT_LIMITS.forEach((_range, i) => {
      expect(pctToRadNum(0, i)).toBeCloseTo(FIRMWARE_SOFT_LIMITS[i][0], 9)
      expect(pctToRadNum(100, i)).toBeCloseTo(FIRMWARE_SOFT_LIMITS[i][1], 9)
      // 端点用浮点算出来会差最后一位（`min + (max - min)` 不保证退回 max），所以给个容差。
      expect(pctToRadNum(100, i)).toBeLessThanOrEqual(FIRMWARE_SOFT_LIMITS[i][1] + 1e-9)
      expect(pctToRadNum(0, i)).toBeGreaterThanOrEqual(FIRMWARE_SOFT_LIMITS[i][0] - 1e-9)
    })
    expect(JOINT_LIMITS[3].max).toBeLessThan(0.02)
  })
})

describe('describeArmFault with daemon state shapes', () => {
  it('handles null, empty objects, and state with omitted repeated fields gracefully', () => {
    expect(describeArmFault(null)).toBeNull()
    expect(describeArmFault({} as any)).toBeNull()
    expect(describeArmFault({ state: 'ready', seq: 1 } as any)).toBeNull()
  })

  it('reports the faulted flag with its detail string', () => {
    expect(describeArmFault({ faulted: true, faultDetail: '到位超时' } as any)).toBe('控制器故障：到位超时')
    expect(describeArmFault({ faulted: true, faultDetail: '' } as any)).toBe('控制器处于故障状态')
  })

  it('maps per-joint driver fault codes to human labels', () => {
    expect(describeArmFault({ fault: [{ joint: 3, errCode: 0xa }], errs: [] } as any)).toBe('关节 3 驱动过流')
    expect(describeArmFault({ fault: [{ joint: 2, errCode: 99 }], errs: [] } as any)).toBe('关节 2 驱动故障（状态码 99）')
  })

  it('falls back to the per-axis errs and the jointFault bitmap', () => {
    expect(describeArmFault({ errs: [1, 9], fault: [] } as any)).toBe('关节 2 驱动欠压')
    expect(describeArmFault({ errs: [], jointFault: 2 } as any)).toBe('关节故障位图：0x2')
  })
})

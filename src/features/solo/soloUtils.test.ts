import { describe, expect, it } from 'vitest'
import { describeArmFault } from './soloUtils'

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

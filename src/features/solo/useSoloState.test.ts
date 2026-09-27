import { beforeEach, describe, expect, it } from 'vitest'
import { JOINT_LIMITS, normalizeLimits, pctToRad, pctToRadNum, radToPct, readStoredSpeed } from './useSoloState'

describe('normalizeLimits', () => {
  it('accepts {min,max} objects and [min,max] arrays', () => {
    expect(normalizeLimits({ limits: [{ min: -1, max: 1 }, [0, 2]] })).toEqual([
      { min: -1, max: 1 },
      { min: 0, max: 2 },
    ])
  })

  it('returns null for missing/empty/invalid limits', () => {
    expect(normalizeLimits(null)).toBeNull()
    expect(normalizeLimits({ limits: [] })).toBeNull()
    expect(normalizeLimits({ limits: [{ min: 1, max: 0 }] })).toBeNull()
    expect(normalizeLimits({ limits: [{ min: 'x', max: 1 }] })).toBeNull()
    expect(normalizeLimits({ limits: [null] })).toBeNull()
  })
})

describe('readStoredSpeed', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to 50 when nothing is stored', () => {
    expect(readStoredSpeed()).toBe(50)
  })

  it('reads the persisted speed', () => {
    localStorage.setItem('litearm.solo.speed', '75')
    expect(readStoredSpeed()).toBe(75)
  })

  it('clamps out-of-range values into [0, 100]', () => {
    localStorage.setItem('litearm.solo.speed', '180')
    expect(readStoredSpeed()).toBe(100)
    localStorage.setItem('litearm.solo.speed', '-5')
    expect(readStoredSpeed()).toBe(1)
  })

  it('falls back to the default for invalid values', () => {
    localStorage.setItem('litearm.solo.speed', 'not-a-number')
    expect(readStoredSpeed()).toBe(50)
  })
})

describe('pctToRadNum', () => {
  it('maps 0% to each joint q_min and 100% to q_max', () => {
    for (let i = 0; i < JOINT_LIMITS.length; i++) {
      expect(pctToRadNum(0, i)).toBeCloseTo(JOINT_LIMITS[i].min, 10)
      expect(pctToRadNum(100, i)).toBeCloseTo(JOINT_LIMITS[i].max, 10)
    }
  })

  it('maps 50% to the mid-range of an asymmetric joint (J4)', () => {
    const mid = (JOINT_LIMITS[3].min + JOINT_LIMITS[3].max) / 2
    expect(pctToRadNum(50, 3)).toBeCloseTo(mid, 10)
  })
})

describe('pctToRad', () => {
  it('formats to 3 decimal places', () => {
    expect(pctToRad(0, 0)).toBe(JOINT_LIMITS[0].min.toFixed(3))
    expect(pctToRad(100, 0)).toBe(JOINT_LIMITS[0].max.toFixed(3))
  })
})

describe('radToPct', () => {
  it('is the inverse of pctToRadNum across the slider range', () => {
    for (let i = 0; i < JOINT_LIMITS.length; i++) {
      for (const pct of [0, 12.5, 25, 50, 75, 100]) {
        expect(radToPct(pctToRadNum(pct, i), i)).toBeCloseTo(pct, 6)
      }
    }
  })

  it('clamps out-of-range radians into [0, 100]', () => {
    expect(radToPct(-10, 0)).toBe(0)
    expect(radToPct(10, 0)).toBe(100)
    // J4 上限只有 +0.647 rad：超过即钳到 100
    expect(radToPct(1, 3)).toBe(100)
    expect(radToPct(-4, 3)).toBe(0)
  })
})

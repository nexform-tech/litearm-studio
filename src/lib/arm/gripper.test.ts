import { describe, expect, it } from 'vitest'
import {
  forceToNorm,
  GRIPPER_FORCE_MAX_N,
  GRIPPER_FORCE_SET_MAX_N,
  GRIPPER_STROKE_MM,
  strokeToWidthNorm,
  widthNormToStroke,
} from './gripper'

describe('gripper API mapping', () => {
  it('maps stroke mm to normalized width 0..1', () => {
    expect(strokeToWidthNorm(0)).toBe(0)
    expect(strokeToWidthNorm(GRIPPER_STROKE_MM)).toBe(1)
    expect(strokeToWidthNorm(GRIPPER_STROKE_MM / 2)).toBeCloseTo(0.5)
    expect(strokeToWidthNorm(999)).toBe(1)
    expect(strokeToWidthNorm(-5)).toBe(0)
  })

  it('maps normalized width back to stroke mm', () => {
    expect(widthNormToStroke(0)).toBe(0)
    expect(widthNormToStroke(1)).toBe(GRIPPER_STROKE_MM)
    expect(widthNormToStroke(0.5)).toBeCloseTo(GRIPPER_STROKE_MM / 2)
    expect(widthNormToStroke(2)).toBe(GRIPPER_STROKE_MM)
    expect(widthNormToStroke(-1)).toBe(0)
  })

  it('maps force N to normalized 0..1', () => {
    expect(forceToNorm(0)).toBe(0)
    expect(forceToNorm(GRIPPER_FORCE_MAX_N)).toBe(1)
    expect(forceToNorm(GRIPPER_FORCE_MAX_N / 2)).toBeCloseTo(0.5)
    expect(forceToNorm(999)).toBe(1)
  })

  it('pins hardware max to LiteGrip spec (40N) and set_force mapping to 50N', () => {
    expect(GRIPPER_FORCE_MAX_N).toBe(40)
    expect(GRIPPER_FORCE_SET_MAX_N).toBe(50)
    expect(forceToNorm(40, GRIPPER_FORCE_SET_MAX_N)).toBeCloseTo(0.8)
    expect(forceToNorm(25, GRIPPER_FORCE_SET_MAX_N)).toBeCloseTo(0.5)
  })
})

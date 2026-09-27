import { describe, expect, it } from 'vitest'
import { jogPose, type Mat3 } from './geometry'

const IDENTITY: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]

function matMul(a: Mat3, b: Mat3): Mat3 {
  const r: Mat3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let sum = 0
      for (let k = 0; k < 3; k++) sum += a[i][k] * b[k][j]
      r[i][j] = sum
    }
  return r
}

function expectMatClose(a: Mat3, b: Mat3, precision = 6) {
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(a[i][j]).toBeCloseTo(b[i][j], precision)
}

describe('jogPose · translate', () => {
  it('steps along a base-frame axis in world coordinates, leaving rotation untouched', () => {
    const pose: [number[], number[][]] = [[0.3, 0, 0.4], IDENTITY]
    const [pos, rot] = jogPose(pose, 'Y', 'translate', 0.01, 'base')
    expect(pos).toEqual([0.3, 0.01, 0.4])
    expect(rot).toBe(IDENTITY)
  })

  it('negative amount moves the opposite way', () => {
    const pose: [number[], number[][]] = [[0, 0, 0], IDENTITY]
    const [pos] = jogPose(pose, 'X', 'translate', -0.02, 'base')
    expect(pos).toEqual([-0.02, 0, 0])
  })

  it('steps along the tool axis rotated into base frame', () => {
    // R = 90° about Z: tool's local +X axis points along base +Y.
    const R: Mat3 = [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ]
    const pose: [number[], number[][]] = [[1, 1, 1], R]
    const [pos] = jogPose(pose, 'X', 'translate', 0.05, 'tool')
    expect(pos[0]).toBeCloseTo(1, 6)
    expect(pos[1]).toBeCloseTo(1.05, 6)
    expect(pos[2]).toBeCloseTo(1, 6)
  })
})

describe('jogPose · rotate', () => {
  it('base-frame rotation pre-multiplies R (rotates about world axes)', () => {
    const R: Mat3 = [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ]
    const amount = 0.2
    const dR: Mat3 = [
      [Math.cos(amount), -Math.sin(amount), 0],
      [Math.sin(amount), Math.cos(amount), 0],
      [0, 0, 1],
    ]
    const [, rot] = jogPose([[0, 0, 0], R], 'Z', 'rotate', amount, 'base')
    expectMatClose(rot, matMul(dR, R))
  })

  it('tool-frame rotation post-multiplies R (rotates about the end-effector axes)', () => {
    const R: Mat3 = [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ]
    const amount = 0.2
    const dR: Mat3 = [
      [Math.cos(amount), -Math.sin(amount), 0],
      [Math.sin(amount), Math.cos(amount), 0],
      [0, 0, 1],
    ]
    const [, rot] = jogPose([[0, 0, 0], R], 'Z', 'rotate', amount, 'tool')
    expectMatClose(rot, matMul(R, dR))
  })

  it('base and tool rotation agree when the current orientation is identity', () => {
    const amount = 0.3
    const [, baseRot] = jogPose([[0, 0, 0], IDENTITY], 'X', 'rotate', amount, 'base')
    const [, toolRot] = jogPose([[0, 0, 0], IDENTITY], 'X', 'rotate', amount, 'tool')
    expectMatClose(baseRot, toolRot)
  })

  it('leaves position untouched', () => {
    const [pos] = jogPose([[0.1, 0.2, 0.3], IDENTITY], 'Y', 'rotate', 0.4, 'base')
    expect(pos).toEqual([0.1, 0.2, 0.3])
  })
})

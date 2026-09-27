/** Minimal 3x3 rotation-matrix helpers for cartesian jogging (base/tool frame). */

export type Mat3 = number[][]

function rotAxisAngle(axis: 'X' | 'Y' | 'Z', rad: number): Mat3 {
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  if (axis === 'X') return [[1, 0, 0], [0, c, -s], [0, s, c]]
  if (axis === 'Y') return [[c, 0, s], [0, 1, 0], [-s, 0, c]]
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]]
}

function matMul3(a: Mat3, b: Mat3): Mat3 {
  const r: Mat3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let sum = 0
      for (let k = 0; k < 3; k++) sum += a[i][k] * b[k][j]
      r[i][j] = sum
    }
  }
  return r
}

function matVec3(m: Mat3, v: [number, number, number]): [number, number, number] {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ]
}

const AXIS_VEC: Record<'X' | 'Y' | 'Z', [number, number, number]> = {
  X: [1, 0, 0],
  Y: [0, 1, 0],
  Z: [0, 0, 1],
}

/**
 * Apply one jog step to a pose. `translate` steps move along the axis by
 * `amount` meters; `rotate` steps rotate about the axis by `amount` radians.
 * In the tool frame, both translation direction and rotation axis are
 * expressed in the end-effector's own orientation (R), not the base frame.
 */
export function jogPose(
  pose: [number[], number[][]],
  axis: 'X' | 'Y' | 'Z',
  kind: 'translate' | 'rotate',
  amount: number,
  frame: 'base' | 'tool',
): [number[], number[][]] {
  const [pos, rot] = pose
  const R = rot as Mat3
  const p: [number, number, number] = [pos[0], pos[1], pos[2]]

  if (kind === 'translate') {
    const dir = frame === 'base' ? AXIS_VEC[axis] : matVec3(R, AXIS_VEC[axis])
    const newPos: [number, number, number] = [p[0] + dir[0] * amount, p[1] + dir[1] * amount, p[2] + dir[2] * amount]
    return [newPos, R]
  }

  const dR = rotAxisAngle(axis, amount)
  // Base-frame rotation pre-multiplies (rotate about world axes); tool-frame
  // rotation post-multiplies (rotate about the end-effector's own axes).
  const newR = frame === 'base' ? matMul3(dR, R) : matMul3(R, dR)
  return [p, newR]
}

export function rpyToMat3(roll: number, pitch: number, yaw: number): Mat3 {
  const cr = Math.cos(roll), sr = Math.sin(roll)
  const cp = Math.cos(pitch), sp = Math.sin(pitch)
  const cy = Math.cos(yaw), sy = Math.sin(yaw)

  return [
    [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
    [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
    [-sp, cp * sr, cp * cr],
  ]
}

export function mat3ToRpy(R: Mat3): [number, number, number] {
  let roll = 0, pitch = 0, yaw = 0
  if (Math.abs(R[2][0]) < 0.99999) {
    pitch = -Math.asin(Math.max(-1, Math.min(1, R[2][0])))
    roll = Math.atan2(R[2][1] / Math.cos(pitch), R[2][2] / Math.cos(pitch))
    yaw = Math.atan2(R[1][0] / Math.cos(pitch), R[0][0] / Math.cos(pitch))
  } else {
    yaw = 0
    if (R[2][0] <= -0.99999) {
      pitch = Math.PI / 2
      roll = Math.atan2(R[0][1], R[0][2])
    } else {
      pitch = -Math.PI / 2
      roll = Math.atan2(-R[0][1], -R[0][2])
    }
  }
  return [roll, pitch, yaw]
}


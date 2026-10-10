import { describe, expect, it } from 'vitest'
import {
  gravityFromRpy,
  gravityMagnitude,
  INSTALLATION_POSES,
  installationPoseById,
  isStandardMagnitude,
  MAGNITUDE_TOLERANCE_REL,
  matchInstallationPose,
  STANDARD_GRAVITY,
  type InstallationPoseId,
} from './installationPose'

/** 按界面上的 4 位小数取整（`-0` 也归成 `0`）—— 断言的就是操作员看到的那些数。 */
function rounded(rpy: readonly number[]): number[] {
  return gravityFromRpy(rpy).map((v) => {
    const n = Number(v.toFixed(4))
    return Object.is(n, -0) ? 0 : n
  })
}

describe('installationPose', () => {
  it('lists the six presets in the order the panel shows them', () => {
    expect(INSTALLATION_POSES.map((p) => p.id)).toEqual([
      'upright',
      'inverted',
      'sideX',
      'sideNegX',
      'sideY',
      'sideNegY',
    ])
  })

  it('carries the exact vectors the panel promises, in m/s²', () => {
    // ⚠ 量级必须是 9.81, 不是 1: daemon 用例 (`test_session.py::test_gravity_vector_roundtrip`)
    //   与固件默认值都是 `[0, 0, -9.81]`。发单位向量会让重力前馈小 9.81 倍。
    expect(INSTALLATION_POSES.map((p) => p.gravity)).toEqual([
      [0, 0, -9.81],
      [0, 0, 9.81],
      [9.81, 0, 0],
      [-9.81, 0, 0],
      [0, 9.81, 0],
      [0, -9.81, 0],
    ])
    for (const pose of INSTALLATION_POSES) {
      expect(gravityMagnitude(pose.gravity)).toBeCloseTo(STANDARD_GRAVITY, 6)
    }
  })

  it('keeps every preset rpy and vector consistent with the advertised formula', () => {
    // 提示语写着"不确定就用 base_rpy 推导", 所以这两套数必须由
    // g = R(rpy)ᵀ·(0,0,-9.81) 对得上 —— 对不上就是提示在骗人。
    for (const pose of INSTALLATION_POSES) {
      const derived = gravityFromRpy(pose.rpy)
      derived.forEach((v, i) => expect(v).toBeCloseTo(pose.gravity[i], 6))
    }
  })

  it('derives the six mounting directions with the signs the panel shows', () => {
    // 就是图片里那六组: 侧装 +x 的 pitch 是 +π/2 ⇒ gravity x 为正。
    expect(rounded([0, 0, 0])).toEqual([0, 0, -9.81])
    expect(rounded([0, Math.PI, 0])).toEqual([0, 0, 9.81])
    expect(rounded([0, Math.PI / 2, 0])).toEqual([9.81, 0, 0])
    expect(rounded([0, -Math.PI / 2, 0])).toEqual([-9.81, 0, 0])
    expect(rounded([-Math.PI / 2, 0, 0])).toEqual([0, 9.81, 0])
    expect(rounded([Math.PI / 2, 0, 0])).toEqual([0, -9.81, 0])
  })

  it('ignores yaw, because spinning the base about the world vertical does not move gravity', () => {
    expect(rounded([0.3, 0.2, 1.234])).toEqual(rounded([0.3, 0.2, 0]))
  })

  it('round-trips every preset through the matcher', () => {
    for (const pose of INSTALLATION_POSES) {
      expect(matchInstallationPose(pose.gravity)).toBe(pose.id)
    }
  })

  it('tolerates f32 quantization but does not force a custom vector into a preset', () => {
    expect(matchInstallationPose([0, 0, -9.8100004196167])).toBe('upright')
    expect(matchInstallationPose([0, 0.002, -9.81])).toBeNull()
    // 单位向量是**旧面板**发的那种错值, 不能被认成正装。
    expect(matchInstallationPose([0, 0, -1])).toBeNull()
  })

  it('reports "not a preset" before anything has been read or on a short vector', () => {
    // 未读取时 state 里是 [0,0,0]; 它不能被显示成某个装法。
    expect(matchInstallationPose([0, 0, 0])).toBeNull()
    expect(matchInstallationPose(null)).toBeNull()
    expect(matchInstallationPose([0, -9.81])).toBeNull()
  })

  it('hands out the preset itself, not a copy that a caller could mistake for one', () => {
    const pose = installationPoseById('sideX')
    expect(pose.rpy).toEqual([0, Math.PI / 2, 0])
    expect(pose.gravity).toEqual([9.81, 0, 0])
    expect(() => installationPoseById('nope' as InstallationPoseId)).toThrow(/unknown installation pose/)
  })

  it('flags a magnitude that is not standard gravity', () => {
    expect(isStandardMagnitude([0, 0, -9.81])).toBe(true)
    expect(isStandardMagnitude([9.81, 0, 0])).toBe(true)
    // 方向错但量级对: 量级判据只管道量级, 方向由 `matchInstallationPose` 管。
    expect(isStandardMagnitude([3, 4, 8.4401])).toBe(true)
    expect(isStandardMagnitude([0, 0, -1])).toBe(false)
    expect(isStandardMagnitude([0, 0, -13.87])).toBe(false)
    expect(isStandardMagnitude([0, 0, 0])).toBe(false)
  })

  it('draws the magnitude line at 1%, the same place the tool panel does', () => {
    // ⚠ 这条线是**下发前的确认闸**的判据, 不是配色: |g| 落在带内直接发, 出带要二次确认。
    //   带外的典型成因是"只改了一个分量"—— 正装→侧装时 z 没清零 ⇒ 13.87 = 1.41g。
    expect(MAGNITUDE_TOLERANCE_REL).toBe(0.01)
    // 带宽 = 9.81 × 1% = 0.0981 m/s²。
    expect(isStandardMagnitude([0, 0, -9.90])).toBe(true)   // 偏离 0.09
    expect(isStandardMagnitude([0, 0, -9.70])).toBe(false)  // 偏离 0.11
    expect(isStandardMagnitude([0, 0, -13.87])).toBe(false) // 1.41×g, 典型手滑
  })
})

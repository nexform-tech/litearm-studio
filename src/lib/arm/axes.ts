import type { ConnInfo, RobotState } from './client'
import { useArmConnection } from './useArmConnection'
import { useArmState } from './useArmState'

/**
 * 内置臂型的关节数：仿真模式下的虚拟臂，以及 daemon 没有报告 `n` 时的兜底。
 * 设计稿与 `--fake` 桩固件都是整臂 7 轴。
 */
export const DEFAULT_JOINT_COUNT = 7

/**
 * `n` 的合理上限。
 *
 * 真机台架只有 `{1J}` 与 `{7J}` 两种，这个数不是产品约束，而是兜底：`n` 来自 daemon
 * 的 `conn` 帧，一个坏帧（或将来某个字段被写错）不应该让前端去建几十万个关节滑块。
 */
export const MAX_JOINT_COUNT = 32

/**
 * 这台臂有几个轴。
 *
 * **唯一的来源是 daemon 的 `conn` 帧**（`arm_info()["n"]`，即固件装配时的关节数），
 * 前端不许再假定 7：`{1J}` 台架上 7 个指标芯片里 6 个恒为 `—`、7 根滑块里 6 根发出去
 * 的目标角是假的（issue #37）。
 *
 * 兜底顺序（仅用于 `n` 拿不到时，不覆盖它）：
 * 1. `state.q` 的长度 —— 广播里真正在动的关节数；
 * 2. {@link DEFAULT_JOINT_COUNT} —— 未连接/仿真。
 */
export function resolveJointCount(conn: ConnInfo | null, state: RobotState | null): number {
  const reported = conn?.n
  if (typeof reported === 'number' && Number.isFinite(reported) && reported >= 1) {
    return clampJointCount(Math.floor(reported))
  }
  const fromBroadcast = state?.q?.length ?? 0
  if (fromBroadcast >= 1) return clampJointCount(fromBroadcast)
  return DEFAULT_JOINT_COUNT
}

function clampJointCount(n: number): number {
  return Math.min(MAX_JOINT_COUNT, Math.max(1, n))
}

/** `0 … n-1`，用于按轴渲染的列表（指标芯片、关节滑块、曲线）。 */
export function jointIndexes(n: number): number[] {
  return Array.from({ length: clampJointCount(n) }, (_, i) => i)
}

/**
 * 当前该渲染几个轴。
 *
 * 仿真模式固定 {@link DEFAULT_JOINT_COUNT}：那时姿态来自前端虚拟臂（`generateSimSample`
 * 与设计稿都是 7 轴），把实机的轴数带进仿真只会让"切回实机"前后的界面莫名其妙地变。
 */
export function useJointCount(real = true): number {
  const { conn } = useArmConnection()
  const state = useArmState()
  return real ? resolveJointCount(conn, state) : DEFAULT_JOINT_COUNT
}

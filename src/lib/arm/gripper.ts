/**
 * 夹爪 (end_0) API 约定 —— 与当前 LiteGrip 设备 manifest 对齐。
 *
 * 当前 LiteGrip 通过 `get_state` 返回 position_mm/travel_mm/force_n，
 * 位置控制使用 `goto(position_mm, duration)`，开合使用 `open/close`。
 *
 * 后端 damiao 适配器（litearm-device .../adapters/gripper.py）：
 *   - set_width 按 0~1 归一化映射到 pos_closed_rad .. pos_open_rad
 *   - set_force 按 0~1 归一化（内部映射 kp）
 *
 * 当前实机末端 LiteGrip/DM4310（见真机 ~/lite-grip 与 ~/luo/litearm-device）：
 *   - position_mm / travel_mm：实际位置与总行程
 *   - force_n：实际力反馈 = torque_nm × 10（估算，方向随转向约定可为负，界面按绝对值展示）
 *   - goto(position_mm, duration) 是位置控制方法。
 *
 * 力上限说明：
 *   - LiteGrip 硬件规格最大夹持力 40N（README 规格表）；
 *   - 设备 manifest 的 close/grasp force_n 参数范围 0~100 对应 DM4310 最大力矩
 *     10Nm 的理论上限（0.1 Nm/N），不代表机械额定，前端按 40N 限制更安全；
 *   - 后端 set_force 将归一化 0~1 映射到 0~50N（见 gripper.py），
 *     下发时需用 50N 作归一化分母，否则实际力与界面显示不一致。
 */
export const GRIPPER_STROKE_MM = 120
export const GRIPPER_FORCE_MAX_N = 40
/** 后端 set_force 归一化 0~1 → 0~50N 的映射上限（仅用于 set_force 下发）。 */
export const GRIPPER_FORCE_SET_MAX_N = 50

export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

/** 行程 mm → 归一化宽度 (0=闭, 1=开)。 */
export function strokeToWidthNorm(strokeMm: number, strokeMaxMm = GRIPPER_STROKE_MM): number {
  return clamp01(strokeMaxMm <= 0 ? 0 : strokeMm / strokeMaxMm)
}

/** 归一化宽度 (0=闭, 1=开) → 行程 mm。 */
export function widthNormToStroke(widthNorm: number, strokeMaxMm = GRIPPER_STROKE_MM): number {
  return clamp01(widthNorm) * strokeMaxMm
}

/** 夹持力 N → 归一化 0~1。 */
export function forceToNorm(forceN: number, forceMaxN = GRIPPER_FORCE_MAX_N): number {
  return clamp01(forceMaxN <= 0 ? 0 : forceN / forceMaxN)
}

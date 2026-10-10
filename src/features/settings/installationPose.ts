/**
 * 安装方向 ↔ 基座系重力向量的换算 —— 设置页「安装方向」页签用。
 *
 * 谁读这个文件: 要改预设值, 或要核对"某个装法到底该发哪三个数"的人。
 *
 * 固件**没有**"安装姿态"这条命令: 它只收基座系下的重力向量 (`set_gravity_vector`
 * → 前馈标量 item 6, 见 `daemon/src/litearm_studio_daemon/session.py` 的命令表),
 * 所以"机械臂怎么装的"只能由这个向量表达。这一层把六种常见装法折算成向量与
 * base_rpy, 让操作员选装法, 而不是自己推三角函数。
 *
 * ⚠ **单位是 m/s², 不是单位向量**, 量级恒为 `STANDARD_GRAVITY` = 9.81。daemon 用例
 * (`daemon/tests/test_session.py::test_gravity_vector_roundtrip`) 发的就是
 * `[0, 0, -9.81]`; 预设值必须与之一致 —— 发 `[0, 0, -1]` 会让重力前馈小 9.81 倍。
 *
 * ⚠ **约定**: `g_base = R(base_rpy)ᵀ·(0, 0, -9.81)`, `R = Rz(yaw)·Ry(pitch)·Rx(roll)`,
 * 与 pylitearm 的 `robot_model.gravity_from_installation`、固件 `kin.c` 同式。
 * yaw 是绕世界竖直轴的旋转, 它不改变重力在基座系里的方向 —— 字段保留是为了
 * base_rpy 三个分量语义完整, 不是摆设。
 */

export type InstallationPoseId =
  | 'upright'
  | 'inverted'
  | 'sideX'
  | 'sideNegX'
  | 'sideY'
  | 'sideNegY'

export type InstallationPose = {
  id: InstallationPoseId
  /** 该装法的 base_rpy (rad) —— 点预设时填进 rpy 输入框的那组值。 */
  rpy: [number, number, number]
  /** 该装法的基座系重力向量 (m/s²) —— 真正下发给固件的那三个数。 */
  gravity: [number, number, number]
}

/** 标准重力加速度 (m/s²): 预设的量级, 也是 `|g|` 判据的基准。 */
export const STANDARD_GRAVITY = 9.81

/**
 * 六种装法, 顺序就是界面上的顺序 (与「安装方向」页签的按钮一一对应)。
 *
 * rpy 用 `Math.PI` 的表达式写 (不是 1.5708 这样的字面量), 这样"点预设之后改一个
 * 分量再改回来"能回到同一个数; 向量则写成**精确的** ±9.81 与 0 —— 预设下发的就是
 * 这三个数, 不经过三角函数的浮点残差 (见 `gravityFromRpy` 的说明)。
 */
export const INSTALLATION_POSES: readonly InstallationPose[] = [
  { id: 'upright', rpy: [0, 0, 0], gravity: [0, 0, -STANDARD_GRAVITY] },
  { id: 'inverted', rpy: [0, Math.PI, 0], gravity: [0, 0, STANDARD_GRAVITY] },
  { id: 'sideX', rpy: [0, Math.PI / 2, 0], gravity: [STANDARD_GRAVITY, 0, 0] },
  { id: 'sideNegX', rpy: [0, -Math.PI / 2, 0], gravity: [-STANDARD_GRAVITY, 0, 0] },
  { id: 'sideY', rpy: [-Math.PI / 2, 0, 0], gravity: [0, STANDARD_GRAVITY, 0] },
  { id: 'sideNegY', rpy: [Math.PI / 2, 0, 0], gravity: [0, -STANDARD_GRAVITY, 0] },
]

/** 判定"这组读回值属于哪个预设"的容差: 固件按 f32 存, 量化误差远小于它。 */
const POSE_EPSILON = 1e-3

/**
 * `|g|` 相对 9.81 的允许偏差 —— 超过它就二次确认再下发。
 *
 * ⚠ 1% 是**工具侧定下的口径** (见 `litearm-tool-for-stm32` 的「安装方向」页
 * `MAG_TOL_REL`): 抓的是"只改了一个分量"这类看着合理的错 —— 正装改侧装时 z 没清零,
 * 模长就是 13.87 = 1.41g, 而固件照收不误。两个 9.81 都容不下。
 */
export const MAGNITUDE_TOLERANCE_REL = 0.01

/** 单轴重力的可输入上限 (m/s²) —— 固件对 item 6 的范围就是 `[-50, 50]`。 */
export const GRAVITY_AXIS_LIMIT = 50

/** 3×3 行主序矩阵。 */
type Mat3 = [number, number, number, number, number, number, number, number, number]

function multiply(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9).fill(0)
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out[row * 3 + col] =
        a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col]
    }
  }
  return out as Mat3
}

function rotX(a: number): Mat3 {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return [1, 0, 0, 0, c, -s, 0, s, c]
}

function rotY(a: number): Mat3 {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return [c, 0, s, 0, 1, 0, -s, 0, c]
}

function rotZ(a: number): Mat3 {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return [c, -s, 0, s, c, 0, 0, 0, 1]
}

/** `R = Rz(yaw)·Ry(pitch)·Rx(roll)` (基座 → 世界)。 */
export function rpyToRotation(rpy: readonly number[]): Mat3 {
  const [roll, pitch, yaw] = [Number(rpy[0]) || 0, Number(rpy[1]) || 0, Number(rpy[2]) || 0]
  return multiply(multiply(rotZ(yaw), rotY(pitch)), rotX(roll))
}

/**
 * base_rpy → 基座系重力向量 (m/s²)。
 *
 * `g = Rᵀ·(0, 0, -9.81)`, 而 `(Rᵀ·v)_i = Σⱼ R[j][i]·v[j]`, v 只有第 3 项非零 ⇒
 * 结果就是 R 的**第三行**乘 -9.81。
 *
 * ⚠ 预设走的是 `INSTALLATION_POSES` 里的精确值, 不走这里: `pitch = π/2` 时
 * `cos(pitch)` 是 6e-17 而不是 0, 算出来的向量带一个尾数。手改 rpy 才用本函数。
 */
export function gravityFromRpy(rpy: readonly number[]): [number, number, number] {
  const r = rpyToRotation(rpy)
  return [-STANDARD_GRAVITY * r[6], -STANDARD_GRAVITY * r[7], -STANDARD_GRAVITY * r[8]]
}

/** `|g|` (m/s²)。 */
export function gravityMagnitude(gravity: readonly number[] | null | undefined): number {
  if (!gravity || gravity.length < 3) return 0
  const [x, y, z] = [Number(gravity[0]), Number(gravity[1]), Number(gravity[2])]
  return Math.hypot(x, y, z)
}

/** `|g|` 是不是标准重力 (界面上的绿勾)。 */
export function isStandardMagnitude(gravity: readonly number[] | null | undefined): boolean {
  return Math.abs(gravityMagnitude(gravity) - STANDARD_GRAVITY)
    <= STANDARD_GRAVITY * MAGNITUDE_TOLERANCE_REL
}

/** 预设本体 (找不到就抛 —— 调用方给的都是 `InstallationPoseId`)。 */
export function installationPoseById(id: InstallationPoseId): InstallationPose {
  const pose = INSTALLATION_POSES.find((p) => p.id === id)
  if (!pose) throw new Error(`unknown installation pose: ${id}`)
  return pose
}

/**
 * 一个重力向量落在哪个预设上; 都不是 (含未读取时的 `[0, 0, 0]`) 返回 `null`。
 *
 * 用途是把**读回值**翻译成人话 ("设备当前：正装"), 所以按容差逐分量比对, 不做
 * 归一化: 只有量级与方向都对上的预设值才算命中, 自定义向量不会被硬套成某个装法。
 */
export function matchInstallationPose(
  gravity: readonly number[] | null | undefined,
): InstallationPoseId | null {
  if (!gravity || gravity.length < 3) return null
  const hit = INSTALLATION_POSES.find((pose) =>
    pose.gravity.every((g, i) => Math.abs(g - Number(gravity[i])) <= POSE_EPSILON),
  )
  return hit ? hit.id : null
}

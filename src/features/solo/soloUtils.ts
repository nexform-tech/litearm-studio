import type { RobotState } from '@/lib/arm/client'

export type JointLimits = { min: number; max: number }

export type CartAxis = 'X' | 'Y' | 'Z' | 'RX' | 'RY' | 'RZ'

// 全局速度持久化：刷新页面后保留上次的百分比。
export const SOLO_SPEED_STORAGE_KEY = 'litearm.solo.speed'
export const DEFAULT_SPEED = 50

export function readStoredSpeed(): number {
  try {
    const raw = localStorage.getItem(SOLO_SPEED_STORAGE_KEY)
    if (raw == null || raw === '') return DEFAULT_SPEED
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return DEFAULT_SPEED
    // 最小 1%：speed=0 会下发非法参数被拒绝
    return Math.min(100, Math.max(1, parsed))
  } catch {
    return DEFAULT_SPEED
  }
}

export const HOME_JOINTS = [0, 0.5, 0, -1, 0, 0.6, 0]
export const ZERO_JOINTS = [0, 0, 0, 0, 0, 0, 0]

/** 关节滑条的初始百分比（按轴取用，臂比它短时取前 n 个）。 */
export const SEED_JOINT_PCT = [50, 42, 55, 83, 48, 61, 49]

/**
 * 把一组按轴索引的值裁剪/补齐到 `count` 个。
 *
 * 轴数由 daemon 的 `conn` 帧决定（见 `lib/arm/axes.ts`），而这里的常量表是按 7 轴
 * 写的内置默认值 —— 两者长度不必相等：缺的用 `fill` 补上，多的丢掉，好让滑条数量与
 * 下发的目标长度永远等于这台臂真实拥有的轴数（issue #37）。
 */
export function fitJoints(values: number[], count: number, fill = 0): number[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => values[i] ?? fill)
}

/** 同 {@link fitJoints}，但缺的位置用 {@link SEED_JOINT_PCT} 的初始百分比补齐。 */
export function fitJointPct(values: number[], count: number): number[] {
  const seed = fitJoints(SEED_JOINT_PCT, count, 50)
  return fitJoints(values, count, 0).map((v, i) => (i < values.length ? v : seed[i]))
}

/**
 * 关节空间副标题里的轴区间：7 轴写 `J1–J7`，**只有一根轴时不写成 `J1–J1`**。
 * 该串与语言无关（中英文都是 J1–J7），所以不走 i18n。
 */
export function jointRangeLabel(count: number): string {
  return count > 1 ? `J1–J${count}` : 'J1'
}

export const TRANS_STEPS = ['1 mm', '5 mm', '10 mm', '25 mm', '50 mm']
export const ROT_STEPS = ['1 °', '5 °', '10 °', '15 °', '30 °']

// 笛卡尔点动路点数：首段单步为 1 个 step（单击精确单步），续段长按为连续点动。
export const FIRST_SEGMENT_POINTS = 1
export const NEXT_SEGMENT_POINTS = 16

export const JOG_AXIS_MAP: Record<string, CartAxis> = {
  X: 'X', Y: 'Y', Z: 'Z', TX: 'X', TY: 'Y', TZ: 'Z',
  RX: 'RX', RY: 'RY', RZ: 'RZ', RTX: 'RX', RTY: 'RY', RTZ: 'RZ',
}

export function parseJog(label: string): { axis: CartAxis; sign: 1 | -1 } | null {
  const sign = label.endsWith('+') ? 1 : label.endsWith('−') ? -1 : null
  if (sign === null) return null
  const axis = JOG_AXIS_MAP[label.slice(0, -1)]
  return axis ? { axis, sign } : null
}

// 模式切换意图的最长乐观显示时长：daemon 的 zero_g_start 是 ack 式返回，
// 正常几十毫秒内广播就会跟上；超时仍未确认则放弃乐观显示，回到真实状态。
export const MODE_INTENT_TIMEOUT_MS = 3000

// daemon 的派生状态串里表示“已连接且电机使能、可运行”的状态。
export const ARM_OPERATIONAL_STATES = new Set(['ready', 'moving', 'zero_gravity'])

/** 达妙驱动的状态码（与 dm-motor-tool 的表一致）：0/1 是正常的失能/使能，≥8 才是故障。 */
export const MOTOR_ERR_LABEL: Record<number, string> = {
  8: '超压',
  9: '欠压',
  0xa: '过流',
  0xb: 'MOS 过温',
  0xc: '线圈过温',
  0xd: '通讯丢失',
  0xe: '过载',
}

/** 把广播里的故障线索翻成人话——故障灯只给一个布尔值时，现场只能去翻日志。
 *  daemon 保证字段齐全，但缺失时一律按空处理。 */
export function describeArmFault(st: RobotState | null): string | null {
  if (!st) return null
  const reasons: string[] = []
  if (st.faulted) {
    reasons.push(st.faultDetail ? `控制器故障：${st.faultDetail}` : '控制器处于故障状态')
  }
  // fault 是 daemon 由 joint_fault 位图 + 逐轴 err 合并后的去重结果；缺失时退回逐轴 err。
  const errs = Array.isArray(st.errs) ? st.errs : []
  const rawFaults = Array.isArray(st.fault) ? st.fault : []
  const faults = rawFaults.length
    ? rawFaults
    : errs.map((errCode, i) => ({ joint: i + 1, errCode })).filter((f) => f.errCode >= 8)
  for (const f of faults) {
    if (f.errCode >= 8) reasons.push(`关节 ${f.joint} 驱动${MOTOR_ERR_LABEL[f.errCode] ?? `故障（状态码 ${f.errCode}）`}`)
  }
  if (!reasons.length && st.jointFault) reasons.push(`关节故障位图：0x${st.jointFault.toString(16)}`)
  return reasons.length ? reasons.join('；') : null
}

/** 任何安全违例（超速、反馈超时、到位超时）都会把状态机置为 fault，之后所有运动
 *  指令都会被挡掉。而“清错”只调 clear_faults——它清的是驱动的锁存故障，不复位这个
 *  状态机，所以必须把恢复方式直接写在界面上。 */
export const FAULT_STATE_HINT = '控制器处于 fault 状态：任何安全违例都会置位，且「复位」只清驱动锁存故障、清不掉它——需失能后重新使能（机械臂会失力下坠，先扶稳），或重启本地程序'

/** 实机控制器默认配置（GENERIC-V4）的关节角度限位，单位 rad。
 *  各关节范围不同，J4 为非对称区间。0–100 滑条按每个关节自己的范围映射。
 *  连上后优先用 daemon `get_joint_params` 的实际软限位覆盖。 */
export const JOINT_LIMITS: JointLimits[] = [
  { min: -2.82, max: 2.839 },
  { min: -1.78, max: 1.817 },
  { min: -2.83, max: 2.87 },
  { min: -3.1325, max: 0.647 },
  { min: -2.853, max: 2.8587 },
  { min: -1.568, max: 1.619 },
  { min: -1.59, max: 1.623 },
]

/** 把关节限位归一化成 {min,max}[]；兼容 daemon get_joint_params 的
 *  `[{q_min,q_max}, …]`、旧形状的 `{min,max}` / `[min,max]`，以及 `{limits:[…]}` 包装。 */
export function normalizeLimits(raw: unknown): JointLimits[] | null {
  const arr = Array.isArray(raw) ? raw : (raw as { limits?: unknown } | null)?.limits
  if (!Array.isArray(arr) || arr.length === 0) return null
  const out: JointLimits[] = []
  for (const item of arr) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const o = item as Record<string, unknown>
      const min = typeof o.min === 'number' ? o.min : typeof o.q_min === 'number' ? o.q_min : undefined
      const max = typeof o.max === 'number' ? o.max : typeof o.q_max === 'number' ? o.q_max : undefined
      if (min !== undefined && max !== undefined && max > min) {
        out.push({ min, max })
        continue
      }
    }
    if (
      Array.isArray(item) &&
      item.length >= 2 &&
      typeof item[0] === 'number' &&
      typeof item[1] === 'number' &&
      item[1] > item[0]
    ) {
      out.push({ min: item[0], max: item[1] })
      continue
    }
    return null
  }
  return out
}

export function jointRange(joint: number) {
  return JOINT_LIMITS[joint] ?? { min: -Math.PI, max: Math.PI }
}

export function pctToRadNum(pct: number, joint: number) {
  const { min, max } = jointRange(joint)
  return min + ((max - min) * pct) / 100
}

export function pctToRad(pct: number, joint: number) {
  return pctToRadNum(pct, joint).toFixed(3)
}

/** Inverse of pctToRad — real joint radians back to a 0–100 slider position. */
export function radToPct(rad: number, joint: number) {
  const { min, max } = jointRange(joint)
  return Math.min(100, Math.max(0, ((rad - min) / (max - min)) * 100))
}

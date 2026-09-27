import type { RobotState } from '@/lib/arm/client'

/** 服务端轨迹列表的元信息（只抽元数据，绝不把 frames 大数组留进 React state）。 */
export type TrajRecord = { id: string; name?: string; point_count?: number; duration?: number; created_at?: string }

export type JointLimits = { min: number; max: number }

export type CartAxis = 'X' | 'Y' | 'Z' | 'RX' | 'RY' | 'RZ'

// 全局速度持久化：刷新页面后保留上次的百分比（与夹爪速度同款做法）。
export const SOLO_SPEED_STORAGE_KEY = 'litearm.solo.speed'
export const DEFAULT_SPEED = 50

export function readStoredSpeed(): number {
  try {
    const raw = localStorage.getItem(SOLO_SPEED_STORAGE_KEY)
    if (raw == null || raw === '') return DEFAULT_SPEED
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return DEFAULT_SPEED
    // 最小 1%：speed=0 会下发非法参数被服务端拒绝
    return Math.min(100, Math.max(1, parsed))
  } catch {
    return DEFAULT_SPEED
  }
}

export const HOME_JOINTS = [0, 0.5, 0, -1, 0, 0.6, 0]
export const ZERO_JOINTS = [0, 0, 0, 0, 0, 0, 0]

export const TRANS_STEPS = ['1 mm', '5 mm', '10 mm', '25 mm', '50 mm']
export const ROT_STEPS = ['1 °', '5 °', '10 °', '15 °', '30 °']

// 笛卡尔点动路点数：首段单步为 1 个 step（单击精确单步），续段长按为连续稠密平滑路点。
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

// 模式切换意图的最长乐观显示时长：服务端 hold/zero_gravity 是 ack 式返回，
// 正常几十毫秒内广播就会跟上；超时仍未确认则放弃乐观显示，回到真实状态。
export const MODE_INTENT_TIMEOUT_MS = 3000

export const RATES = ['0.25×', '0.5×', '1.0×', '2.0×']

// 拖拽示教（record_trajectory）的采样率，与 pylitearm 默认值一致。
export const RECORD_SAMPLE_HZ = 100

/** 录制文件的存放目录：服务端 handler 的 LITEARM_TRAJ_DIR 默认值 `./trajectories`
 *  （相对 litearm-server 进程的 cwd），pylitearm 的 record_trajectory 默认输出目录
 *  也是它。play_trajectory 接受同样相对服务端 cwd 的 JSON 路径。 */
export const TRAJ_DIR = 'trajectories'
export const trajPath = (id: string) => `${TRAJ_DIR}/${id}.json`

/** 录制/回放都是长任务，可能超过 litearm-js 里硬编码的 120s RPC 超时。超时只是
 *  客户端放弃等待，服务端仍在正常执行，因此这类错误不能当作失败处理。 */
export function isRpcTimeout(err: unknown) {
  return /timeout/i.test(err instanceof Error ? err.message : String(err))
}

export function rateMultiplier(rate: string) {
  return parseFloat(rate) || 1
}

// pylitearm ArmState 中表示“已连接且电机使能、可运行”的状态；
// fault / disabled / disconnected / connecting 均视为未使能。
// stopping 也算使能：request_stop 只让运动指令返回，不切电机模式、不下电，
// 控制器仍在高刚度锁住当前构型（见 pylitearm Arm.request_stop 文档）。
export const ARM_OPERATIONAL_STATES = new Set([
  'ready',
  'moving',
  'holding',
  'zero_gravity',
  'impedance',
  'following',
  'stopping',
])

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

/** 把广播里的故障线索翻成人话——故障灯只给一个布尔值时，现场只能去翻控制器日志。
 *  这些字段广播里本来就有，为空的数组/false 会被 protobuf 省略成 undefined，需防御。 */
export function describeArmFault(st: RobotState | null): string | null {
  if (!st) return null
  const reasons: string[] = []
  // watchdog 锁存：控制周期静默超时后，HAL 会拒绝之后所有 MIT 下发。而 pylitearm 的
  // 恢复路径（latch_hold）自己也要先 send_mit，所以清错、重新使能都救不回来——
  // 只能重启控制器服务。最典型的触发场景是急停一个正在高速运动的轨迹回放。
  if (st.watchdog?.tripped) {
    reasons.push('控制周期超时，watchdog 已锁存接管（清错/重新使能均无效，需重启控制器服务）')
  }
  for (const [i, code] of (st.errs ?? []).entries()) {
    if (code >= 8) reasons.push(`关节 ${i + 1} 驱动${MOTOR_ERR_LABEL[code] ?? `故障（状态码 ${code}）`}`)
  }
  const stale = st.feedback?.staleJoints ?? []
  if (stale.length) reasons.push(`关节反馈超时：${stale.map((j) => `J${j}`).join(' / ')}`)
  return reasons.length ? reasons.join('；') : null
}

/** 任何安全违例（超速、反馈超时、到位超时）都会把 Arm 状态机置为 fault，之后所有运动
 *  指令都会被 _require_connected 挡掉。而“清错”只调 clear_faults——它清的是驱动的锁存
 *  故障，不复位这个状态机（实测清完仍是 fault），所以必须把恢复方式直接写在界面上。 */
export const FAULT_STATE_HINT = '控制器处于 fault 状态：任何安全违例都会置位，且「清错」只清驱动锁存故障、复位不了它——需失能后重新使能（机械臂会失力下坠，先扶稳），或重启控制器服务'

/** 实机控制器默认配置（GENERIC-V4，pylitearm litearm.yaml）的关节角度限位，单位 rad。
 *  各关节范围不同，J4 为非对称区间。0–100 滑条按每个关节自己的范围映射。 */
export const JOINT_LIMITS: JointLimits[] = [
  { min: -2.82, max: 2.839 },
  { min: -1.78, max: 1.817 },
  { min: -2.83, max: 2.87 },
  { min: -3.1325, max: 0.647 },
  { min: -2.853, max: 2.8587 },
  { min: -1.568, max: 1.619 },
  { min: -1.59, max: 1.623 },
]

/** 把 getJointLimits 的返回值归一化成 {min,max}[]；支持 {min,max} 或 [min,max] 两种形状。 */
export function normalizeLimits(raw: unknown): JointLimits[] | null {
  const arr = (raw as { limits?: unknown } | null)?.limits
  if (!Array.isArray(arr) || arr.length === 0) return null
  const out: JointLimits[] = []
  for (const item of arr) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const o = item as Record<string, unknown>
      if (typeof o.min === 'number' && typeof o.max === 'number' && o.max > o.min) {
        out.push({ min: o.min, max: o.max })
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

export function fmtDuration(s?: number) {
  if (s == null) return '0:00.0'
  const m = Math.floor(s / 60)
  const rest = (s % 60).toFixed(1)
  return `${m}:${rest.padStart(4, '0')}`
}

export function fmtDate(iso?: string) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 从文件名/ID 末尾提取数字序号（trajectory_012 → 12），无数字时返回 NaN。 */
function trajNumber(id: string): number {
  const m = /(\d+)$/.exec(id)
  return m ? Number(m[1]) : NaN
}

/** list_trajectories 把目录里每个 JSON 原样返回，条目是 pylitearm 的 JointTrajectory
 *  （schema pylitearm.joint_trajectory.v1）：frames[{t,q,dq,tau}] + duration_s / name /
 *  created_at，id 由服务端补成文件名。
 *
 *  注意 frames 极大——100Hz 采样下 1 秒就是 100 帧、约 46 KB 传输量——这里只抽元信息，
 *  绝不把 frames 留进 React state。
 *
 *  SDK 把返回值标成泛型 Record，所以同时兼容裸数组和 `{trajectories}` / `{items}` 包装，
 *  字段也兼容旧 handler 的 point_count / duration 命名。
 *
 *  服务端只是按目录扫描返回，顺序不稳定；这里统一按创建时间从新到旧排序，
 *  缺少/非法 created_at 的旧条目按 ID 末尾数字倒序排在有时间戳条目之后，保证列表稳定。 */
export function normalizeTrajList(raw: unknown): TrajRecord[] {
  const wrapper = (raw ?? {}) as { trajectories?: unknown; items?: unknown }
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray(wrapper.trajectories)
      ? wrapper.trajectories
      : Array.isArray(wrapper.items)
        ? wrapper.items
        : []
  const list = arr
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => {
      const frames = Array.isArray(x.frames) ? (x.frames as Array<{ t?: number }>) : null
      const lastT = frames && frames.length > 0 ? frames[frames.length - 1]?.t : undefined
      return {
        id: String(x.id ?? x.name ?? ''),
        name: typeof x.name === 'string' ? x.name : undefined,
        point_count: frames?.length ?? (typeof x.point_count === 'number' ? x.point_count : undefined),
        duration:
          typeof x.duration_s === 'number'
            ? x.duration_s
            : typeof x.duration === 'number'
              ? x.duration
              : lastT,
        created_at: typeof x.created_at === 'string' ? x.created_at : undefined,
      }
    })
    .filter((t: TrajRecord) => t.id)

  const timeOf = (t: TrajRecord): number | null => {
    if (!t.created_at) return null
    const ms = Date.parse(t.created_at)
    return Number.isNaN(ms) ? null : ms
  }

  return [...list].sort((a, b) => {
    const ta = timeOf(a)
    const tb = timeOf(b)
    // 有时间戳的条目按时间新→旧；整条记录无时间戳时按 ID 数字倒序，
    // 保证任何输入（包括同一秒、历史遗留文件）都得到确定顺序。
    if (ta != null && tb != null) return tb - ta
    if (ta != null) return -1
    if (tb != null) return 1
    return trajNumber(b.id) - trajNumber(a.id) || b.id.localeCompare(a.id)
  })
}

/**
 * 固件升级（USB DFU）在**前端这一侧**的类型与归一化。
 *
 * 契约见 `daemon/src/litearm_studio_daemon/session.py` 的固件段与
 * `FIRMWARE-UPGRADE-PLAN.md` §3。三条要点：
 *
 * - 进度与结果走**广播帧**（`firmware_progress` / `firmware_result`），不是 `res`
 *   应答 —— 烧录可能几十秒，超过 daemon 的命令超时，而且进 DFU 之后**没有机械臂
 *   会话**了，普通命令会被拒；
 * - `reason` 是**短码**，界面文案只能按它选：`msg` 是守护进程写的中文，英文界面
 *   必须换一句话（与激活那条路同一条纪律）；
 * - 守护进程可能换了版本，所以每个字段都要**防守式解析** —— 少一个字段不该让整页
 *   打不开。
 */

/** 镜像摘要 —— `firmware_inspect` 的应答。`token` 是"开始升级"要带回来的凭据。 */
export type FirmwareImageSummary = {
  token: string
  name: string
  format: string
  /** 起始地址；服务端保证是 `0x08000000`，否则早就被拒了。 */
  base: number
  /** 烧录长度（已按 32 B flash word 对齐补齐）。 */
  size: number
  holes: number
  /** 从镜像里离线提取的版本串；提取不到时为 `null`。 */
  version: string | null
  /** 版本串提取不到时的原因（正常时为空串）。 */
  versionNote: string
  sha256: string
}

/** 一条进度帧。 */
export type FirmwareProgress = {
  job: string
  phase: string
  done: number
  total: number
  detail: string
}

/** 终局帧。`ok` 只表示**烧录完成且经读回校验**。 */
export type FirmwareResult = {
  job: string
  ok: boolean
  reason: string | null
  msg: string
  version: string | null
  port: string | null
  /** 流程成功、但有一件操作员该知道的事（目前只有"版本串对不上"）。 */
  warning: string | null
}

/** `firmware_status` 的应答 —— 界面重连之后靠它把进度条接回去。 */
export type FirmwareStatus = {
  job: string | null
  /** 烧录引擎的可用性描述（"未安装 pyusb…" / "libusb-package: <路径>"）。 */
  engine: string
  /** 引擎能不能用。**开跑之前**就要能看到，否则跳进 DFU 才发现没引擎最难收场。 */
  engineReady: boolean
  /**
   * 这次升级**还在跑**吗。
   *
   * ⚠ 必需字段：没有它，界面分不清"这次还在跑"与"上一次已经结束" —— 两者都带着
   * 最后一条进度的相位（结束那次是 `done`），于是刷新页面会看到
   * "升级进行中 · 完成" 这种自相矛盾的话。
   */
  running?: boolean
  phase?: string | null
  done?: number
  total?: number
  detail?: string
  result?: FirmwareResult | null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function nullableStr(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

export function normalizeFirmwareProgress(raw: unknown): FirmwareProgress {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    job: str(r.job),
    phase: str(r.phase),
    done: num(r.done),
    total: num(r.total),
    detail: str(r.detail),
  }
}

export function normalizeFirmwareResult(raw: unknown): FirmwareResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    job: str(r.job),
    ok: r.ok === true,
    reason: nullableStr(r.reason),
    msg: str(r.msg),
    version: nullableStr(r.version),
    port: nullableStr(r.port),
    warning: nullableStr(r.warning),
  }
}

export function normalizeFirmwareStatus(raw: unknown): FirmwareStatus {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const job = nullableStr(r.job)
  if (!job) {
    return { job: null, engine: str(r.engine), engineReady: r.engineReady === true,
             running: false }
  }
  return {
    job,
    engine: str(r.engine),
    engineReady: r.engineReady === true,
    running: r.running === true,
    phase: nullableStr(r.phase),
    done: num(r.done),
    total: num(r.total),
    detail: str(r.detail),
    result: r.result ? normalizeFirmwareResult(r.result) : null,
  }
}

/**
 * 升级相位 → 界面文案的 key（`settings:firmware.phase.*`）。
 *
 * ⚠ 认不出的相位**原样显示**（`unknown`），不吞掉：守护进程将来加了相位，界面
 * 应该让操作员看见一个陌生的名字，而不是假装停在上一相位。
 */
export const FIRMWARE_PHASE_KEYS: Record<string, string> = {
  validate: 'validate',
  disarm: 'disarm',
  enter_dfu: 'enterDfu',
  wait_dfu: 'waitDfu',
  flash: 'flash',
  detach: 'detach',
  reconnect: 'reconnect',
  done: 'done',
}

/**
 * 把 `File` 编成 base64 —— 浏览器碰不到 USB，镜像必须**经 WebSocket 上传**给
 * 守护进程（见方案 §1 D1）。
 *
 * ⚠ 分块转换：`String.fromCharCode(...bytes)` 在几十万字节上会撑爆调用栈。
 */
export function fileToBase64(file: File): Promise<string> {
  return file.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf)
    let binary = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    return btoa(binary)
  })
}

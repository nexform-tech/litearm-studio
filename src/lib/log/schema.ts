/**
 * 日志记录的形状与归一化 —— 前端这一侧的"唯一真相"。
 *
 * 谁读这个文件: 要渲染、过滤或持久化一条 daemon 记录的人。
 *
 * 字段与 `daemon/src/litearm_studio_daemon/obs/schema.py` 逐字对应, 命名照
 * **OpenTelemetry 的日志数据模型** (`ts_ns` / `severity_number` / `body` /
 * `trace_id` …)。这不是随手的风格选择: 同一条记录既是文件的一行、也是 WS `log` 帧
 * 的载荷、也是这里的一行, 三处字段名一旦漂移, 页面与文件就再也对不上。
 *
 * ⚠ 归一化**永不抛异常**, 且对缺失字段一律给安全默认值。日志是排障时唯一的线索:
 * 一条形状不全的记录也必须能显示出来, 因为"显示不出来"正是最需要日志的那一刻。
 */

/** OTLP 的六档严重性。名字取 OTLP (`WARN`), 不取 Python 的 `WARNING` 或 JS 的 `warning`。 */
export type Severity = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL'

export const SEVERITIES: Severity[] = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']

/** OTLP 给每一档定的数字 —— 排序与过滤只认它。 */
export const SEVERITY_NUMBERS: Record<Severity, number> = {
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
}

/** 事件分组 —— 页面用它做一级筛选, `event` 仍是精确身份。 */
export type LogKind = 'session' | 'command' | 'gripper' | 'firmware' | 'system'

export type LogRecord = {
  /** 稳定事件名, 机器读这一个 (`arm.command.failed`)。 */
  event: string
  kind: LogKind | ''
  /** 人读的一句话。i18n 只翻译 `event`, 这一句是 daemon 的诊断原文。 */
  body: string
  severity: Severity
  severityNumber: number
  /** 自 Unix 纪元纳秒 —— OTLP 的 `time_unix_nano`。 */
  tsNs: number
  /** RFC 3339 UTC, 原样保留给"导出"与"复制"用。 */
  ts: string
  traceId: string | null
  spanId: string | null
  service: string
  version: string
  host: string
  pid: number
  thread: string
  /** 发出这条记录的模块 (`litearm_studio_daemon.session`)。 */
  source: string
  /** 白名单属性袋: `method`/`outcome`/`args`/`exception` … 页面不解析文本。 */
  fields: Record<string, unknown>
}

/** 页面上的一条记录 = 记录本身 + 它在流里的位置。 */
export type LogEntry = LogRecord & {
  /** 服务端广播序号。0 = 不是从实时流来的 (例如将来的回读接口)。 */
  seq: number
  /** 落库序号, 仅本地使用 (稳定 React key)。 */
  id?: number
}

const KIND_SET = new Set<string>(['session', 'command', 'gripper', 'firmware', 'system'])

/**
 * 任何严重性拼写 → 六档之一。
 *
 * 同时接受 OTLP 名、Python 的 `WARNING`、JS 的 `warning` 与数字: 三方各写各的,
 * 归一化放在这里, 而不是散在每个渲染点。
 */
export function normalizeSeverity(value: unknown, fallback: Severity = 'INFO'): Severity {
  if (typeof value === 'string') {
    const upper = value.trim().toUpperCase()
    if ((SEVERITIES as string[]).includes(upper)) return upper as Severity
    if (upper === 'WARNING') return 'WARN'
    if (upper === 'ERR') return 'ERROR'
    if (upper === 'CRITICAL') return 'FATAL'
    if (upper === 'NOTICE') return 'INFO'
    return fallback
  }
  if (typeof value === 'number') {
    const bucket = SEVERITIES.find((s) => SEVERITY_NUMBERS[s] === nearestBucket(value))
    return bucket ?? fallback
  }
  return fallback
}

/** OTLP 的每一档覆盖 4 个数字 (INFO 是 9–12); 归到该档的基准值。 */
function nearestBucket(value: number): number {
  if (!Number.isFinite(value)) return SEVERITY_NUMBERS.INFO
  const buckets = SEVERITIES.map((s) => SEVERITY_NUMBERS[s])
  let best = buckets[0]
  for (const bucket of buckets) {
    // 落在 [bucket, bucket+3] 里就取该档
    if (value >= bucket && value <= bucket + 3) return bucket
    if (value > bucket) best = bucket
  }
  return best
}

export function severityNumber(severity: Severity): number {
  return SEVERITY_NUMBERS[severity]
}

/** `severity >= minimum` —— 级别过滤的唯一判据。 */
export function isAtLeast(severity: Severity, minimum: Severity): boolean {
  return severityNumber(severity) >= severityNumber(minimum)
}

function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

function num(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function optionalId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * 一条记录 → 页面模型。`null` 表示这条**根本不是记录** (缺 `event` 与 `body`)。
 *
 * 这里刻意宽松: daemon 的 `log` 帧载荷直接喂进来, 但同一个函数也要能吃下第三方
 * 工具的记录 (将来把导出的 JSONL 拖回来时用), 所以只要求"能说出它是什么事"。
 */
export function normalizeRecord(raw: unknown): LogRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const event = str(r.event)
  const body = str(r.body)
  if (!event && !body) return null

  const severity = normalizeSeverity(r.severity ?? r.severity_number)
  const tsNs = num(r.ts_ns)
  const ts = str(r.ts)
  const fallbackMs = Date.parse(ts)
  const kindRaw = str(r.kind)
  const fields =
    r.fields && typeof r.fields === 'object' && !Array.isArray(r.fields)
      ? (r.fields as Record<string, unknown>)
      : {}

  return {
    event: event || 'log',
    kind: (KIND_SET.has(kindRaw) ? kindRaw : '') as LogKind | '',
    body: body || event,
    severity,
    severityNumber: num(r.severity_number) || severityNumber(severity),
    tsNs: tsNs || (Number.isFinite(fallbackMs) ? fallbackMs * 1e6 : Date.now() * 1e6),
    ts,
    traceId: optionalId(r.trace_id),
    spanId: optionalId(r.span_id),
    service: str(r.service),
    version: str(r.version),
    host: str(r.host),
    pid: num(r.pid),
    thread: str(r.thread),
    source: str(r.source),
    fields,
  }
}

/** 把一条归一化记录变回线上/文件里的形状 —— 导出与复制要用同一个形状。 */
export function recordToWire(record: LogRecord): Record<string, unknown> {
  return {
    ts: record.ts,
    ts_ns: record.tsNs,
    observed_ts_ns: record.tsNs,
    severity: record.severity,
    severity_number: record.severityNumber,
    event: record.event,
    body: record.body,
    trace_id: record.traceId,
    span_id: record.spanId,
    service: record.service,
    version: record.version,
    host: record.host,
    pid: record.pid,
    thread: record.thread,
    source: record.source,
    fields: record.fields,
    ...(record.kind ? { kind: record.kind } : {}),
  }
}

/**
 * 一条记录是否通过过滤 —— 级别、类别、文本三个条件取与。
 *
 * ⚠ 单独导出是为了**能测**: 三个条件里级别用的是 OTLP 数字比较而不是字符串比较
 * (`ERROR >= WARN` 成立, 而 `"ERROR" >= "WARN"` 也是巧合地成立 —— 靠巧合是错的),
 * 这条判据值得有直接的用例, 不必绕道去驱动一个 Radix 下拉框。
 */
export function matchesFilters(
  entry: LogRecord | LogEntry,
  filters: { level: Severity | 'ALL'; kind: LogKind | 'ALL'; query: string },
): boolean {
  if (filters.level !== 'ALL' && !isAtLeast(entry.severity, filters.level)) return false
  if (filters.kind !== 'ALL' && entry.kind !== filters.kind) return false
  const query = filters.query.trim().toLowerCase()
  if (!query) return true
  // 事件名与内容之外, 方法名也要能搜到 —— "哪条命令失败了"是最高频的问题。
  const haystack = [
    entry.event,
    entry.body,
    entry.source,
    typeof entry.fields.method === 'string' ? entry.fields.method : '',
  ]
  return haystack.some((part) => part.toLowerCase().includes(query))
}

/** 记录的时刻 (毫秒) —— 渲染与排序都用它。 */
export function recordTimeMs(record: LogRecord): number {
  return record.tsNs / 1e6
}

/** 一条记录的估算体积 (字节) —— 按体积保留时的口径。 */
export function estimateRecordBytes(record: LogRecord | LogEntry): number {
  // JSON 字节数最接近 IndexedDB 的结构化克隆开销; 采样表的估算也是这样校准的。
  try {
    return JSON.stringify(recordToWire(record as LogRecord)).length + 64
  } catch {
    return 512
  }
}

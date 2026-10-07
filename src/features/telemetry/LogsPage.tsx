import { ChevronDown, ChevronRight, Copy, Download, History, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useTelemetryState } from './useTelemetryState'
import { useLogRecords } from '@/lib/log/useLogRecords'
import { recordToWire, type LogEntry } from '@/lib/log/schema'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { NumberField } from '@/components/ui/number-field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { TelemetrySample } from './telemetryDb'

function formatTs(value: number, locale: string) {
  if (!Number.isFinite(value)) return ''
  const date = new Date(value * 1000)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(locale.startsWith('en') ? 'en-US' : 'zh-CN', { hour12: false })
}

/** 纳秒时间戳 → 本地时间串, 带毫秒 (日志的排序依据就是它)。 */
function formatRecordTime(tsNs: number, locale: string) {
  if (!Number.isFinite(tsNs) || tsNs <= 0) return ''
  const date = new Date(tsNs / 1e6)
  if (Number.isNaN(date.getTime())) return ''
  const base = date.toLocaleTimeString(locale.startsWith('en') ? 'en-US' : 'zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  return `${base}.${String(date.getMilliseconds()).padStart(3, '0')}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 级别 → 徽章配色。ERROR/FATAL 用破坏色, WARN 用琥珀, 其余保持中性。 */
const LEVEL_STYLES: Record<string, string> = {
  FATAL: 'text-destructive border-destructive/40',
  ERROR: 'text-destructive border-destructive/40',
  WARN: 'text-amber-700 border-amber-500/40 dark:text-amber-400',
  INFO: 'text-foreground',
  DEBUG: 'text-muted-foreground',
  TRACE: 'text-muted-foreground',
}

function maxAbs(values: number[] | undefined): number | null {
  if (!values || values.length === 0) return null
  return Math.max(...values.map((v) => Math.abs(v)))
}

function maxTemp(temps: TelemetrySample['temps']): number | null {
  if (!temps || temps.length === 0) return null
  return Math.max(...temps.map((t) => Math.max(t?.mosTemp ?? 0, t?.coilTemp ?? 0)))
}

function jointDetailLines(sample: TelemetrySample): string[] {
  const n = Math.max(
    (sample.q ?? []).length,
    (sample.dq ?? []).length,
    (sample.tau ?? []).length,
    (sample.temps ?? []).length,
  )
  const lines: string[] = []
  for (let i = 0; i < n; i++) {
    const parts = [`J${i + 1}`]
    if (sample.q?.[i] !== undefined) parts.push(`q=${(sample.q[i] ?? 0).toFixed(4)}`)
    if (sample.dq?.[i] !== undefined) parts.push(`dq=${(sample.dq[i] ?? 0).toFixed(4)}`)
    if (sample.tau?.[i] !== undefined) parts.push(`tau=${(sample.tau[i] ?? 0).toFixed(3)}`)
    const t = sample.temps?.[i]
    if (t) parts.push(`mos=${t.mosTemp ?? 0}°C`, `coil=${t.coilTemp ?? 0}°C`)
    lines.push(parts.join('  '))
  }
  if (sample.errs?.length) lines.push(`errs=[${sample.errs.join(',')}]`)
  if (sample.faults?.length) lines.push(`faults=${JSON.stringify(sample.faults)}`)
  return lines
}

/** 采样记录 (`kind=sample`) 的各轴最大值 —— 与采样表同一口径。 */
function sampleSummary(entry: LogEntry) {
  const q = entry.fields.q as number[] | undefined
  const dq = entry.fields.dq as number[] | undefined
  const tau = entry.fields.tau as number[] | undefined
  const temps = entry.fields.temps as { mosTemp?: number; coilTemp?: number }[] | undefined
  const faults = (entry.fields.fault as unknown[] | undefined) ?? []
  return {
    state: typeof entry.fields.state === 'string' ? entry.fields.state : '',
    joints: q?.length ?? 0,
    temp: maxAbs((temps ?? []).map((t) => Math.max(t?.mosTemp ?? 0, t?.coilTemp ?? 0))),
    speed: maxAbs(dq),
    torque: maxAbs(tau),
    faults: faults.length,
  }
}

/** 一条记录的详情: `fields` 逐项展开, 异常单独成块 (它是排障时要读的第一样东西)。 */
function recordDetail(entry: LogEntry): string {
  const parts: string[] = []
  const exception = entry.fields.exception as Record<string, unknown> | undefined
  const rest: Record<string, unknown> = { ...entry.fields }
  delete rest.exception
  parts.push(JSON.stringify(rest, null, 2))
  if (exception) {
    parts.push(`--- exception ---\n${String(exception.stacktrace ?? exception.message ?? '')}`)
  }
  return parts.join('\n')
}

export function LogsPage() {
  const { t, i18n } = useTranslation(['common', 'nav', 'logs'])
  const vm = useTelemetryState()
  const logs = useLogRecords()
  const [tab, setTab] = useState('records')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [retentionDialogOpen, setRetentionDialogOpen] = useState(false)
  const [retentionDraft, setRetentionDraft] = useState(vm.retentionMb)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  useEffect(() => {
    if (retentionDialogOpen) setRetentionDraft(vm.retentionMb)
  }, [retentionDialogOpen, vm.retentionMb])

  const applyRetention = () => {
    vm.setRetentionMb(retentionDraft)
    setRetentionDialogOpen(false)
  }

  const exportJsonl = () => {
    // 导出用的是线上形状 (`recordToWire`), 于是"导出的文件"与 daemon 写的那个 JSONL
    // 是同一种东西 —— 可以直接喂给 jq / Loki, 也可以再导回来。
    const lines = logs.visible.map((entry) => JSON.stringify(recordToWire(entry))).join('\n')
    const blob = new Blob([`${lines}\n`], { type: 'application/x-ndjson;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `litearm-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  const copyRecord = async (entry: LogEntry) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(recordToWire(entry), null, 2))
      setCopiedId(entryKey(entry))
      setTimeout(() => setCopiedId(null), 1500)
    } catch {
      // 剪贴板被策略拦下 (非 HTTPS、无权限): 没有可用的降级, 静默即可 ——
      // 记录已经在表格里, 用户可以自己选中。
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3.5">
      <Card className="flex flex-none flex-row flex-nowrap items-center gap-x-3 overflow-x-auto rounded-[0.875rem] px-4 py-3">
        <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
          <span className="text-[0.75rem] font-medium text-muted-foreground">{t('logs:status')}</span>
          {vm.recording ? (
            <Badge variant="outline" className="rounded-full px-2.5 py-0.5 text-[0.71875rem] font-semibold text-emerald-700 dark:text-emerald-300">
              {t('logs:recording')}
            </Badge>
          ) : (
            <Badge variant="outline" className="rounded-full px-2.5 py-0.5 text-[0.71875rem] font-semibold text-slate-600 dark:text-slate-300">
              {vm.connected ? t('logs:connectedIdle') : t('logs:notConnected')}
            </Badge>
          )}
        </div>
        <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
          {t('logs:stream')}:{' '}
          {logs.status.metaAt === 0 ? (
            <span className="font-mono text-foreground">{t('logs:streamWaiting')}</span>
          ) : logs.stale ? (
            <span className="font-mono text-amber-700 dark:text-amber-400">
              {t('logs:streamStale', { seconds: logs.staleSeconds })}
            </span>
          ) : (
            <span className="font-mono text-emerald-700 dark:text-emerald-300">{t('logs:streamLive')}</span>
          )}
        </span>
        <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
          {t('logs:streamSeq')}: <span className="font-mono text-foreground">{logs.status.seq}</span>
        </span>
        <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
          {t('logs:streamBuffered')}: <span className="font-mono text-foreground">{logs.entries.length}</span>
        </span>
        {logs.status.missed > 0 || logs.status.dropped > 0 ? (
          <span
            className="shrink-0 whitespace-nowrap text-xs text-amber-700 dark:text-amber-400"
            title={t('logs:logFileHint', { path: 'daemon.jsonl' })}
          >
            {t('logs:streamMissed')}: <span className="font-mono">{logs.status.missed}</span> ·{' '}
            {t('logs:streamDropped')}: <span className="font-mono">{logs.status.dropped}</span>
          </span>
        ) : null}
        {logs.status.writeErrors > 0 ? (
          <span className="shrink-0 whitespace-nowrap text-xs text-destructive">
            {t('logs:streamCacheErrors')}: <span className="font-mono">{logs.status.writeErrors}</span>
          </span>
        ) : null}
        <div className="ml-auto shrink-0">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-auto gap-1.5 rounded-[0.5625rem] px-3 py-1.5 text-[0.78125rem] font-semibold"
            onClick={vm.refresh}
            disabled={vm.loading}
          >
            <RefreshCw size="0.8125rem" className={vm.loading ? 'animate-spin' : ''} />
            {t('common:refresh')}
          </Button>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setRetentionDialogOpen(true)}
          aria-label={t('logs:retentionDialogTitle')}
          title={t('logs:retentionDialogTitle')}
          className="shrink-0 gap-1 text-[0.78125rem] text-muted-foreground hover:text-foreground"
        >
          {t('logs:retentionLimit')}:
          <span className="font-mono font-semibold text-foreground">{vm.retentionMb}</span>
          <span className="text-muted-foreground">{t('logs:megabytesUnit')}</span>
          <Pencil size="0.8125rem" className="text-muted-foreground" />
        </Button>
      </Card>

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-3">
        <TabsList className="w-fit flex-none">
          <TabsTrigger value="records">{t('logs:tabs.records')}</TabsTrigger>
          <TabsTrigger value="samples">{t('logs:tabs.samples')}</TabsTrigger>
        </TabsList>

        <TabsContent value="records" className="flex min-h-0 flex-1 flex-col gap-3">
          <Card className="flex min-h-0 flex-1 flex-col gap-2.5 rounded-[0.875rem] px-4 py-3.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
              <Select value={logs.filters.level} onValueChange={(v) => logs.setLevel(v as typeof logs.filters.level)}>
                <SelectTrigger className="h-8 w-[9rem] text-xs" aria-label={t('logs:level')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">{t('logs:allLevels')}</SelectItem>
                  {(['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const).map((level) => (
                    <SelectItem key={level} value={level}>
                      {level}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={logs.filters.kind} onValueChange={(v) => logs.setKind(v as typeof logs.filters.kind)}>
                <SelectTrigger className="h-8 w-[10rem] text-xs" aria-label={t('logs:kind')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">{t('logs:allKinds')}</SelectItem>
                  {(['session', 'command', 'gripper', 'firmware', 'system', 'sample'] as const).map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {t(`logs:kind.${kind}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={logs.filters.query}
                onChange={(e) => logs.setQuery(e.target.value)}
                placeholder={t('logs:searchPlaceholder')}
                aria-label={t('logs:search')}
                className="h-8 max-w-[20rem] flex-1 text-xs"
              />
              {logs.filteredActive ? (
                <Button type="button" variant="ghost" size="sm" className="h-8 text-xs" onClick={logs.clearFilters}>
                  {t('logs:clearFilters')}
                </Button>
              ) : null}
              <span className="text-xs text-muted-foreground">
                {logs.total}
                {logs.truncated ? ` (${logs.visible.length})` : ''}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 text-[0.78125rem] font-semibold"
                  onClick={logs.loadEarlier}
                  disabled={logs.status.loadingHistory || !logs.status.historyAvailable}
                >
                  <History size="0.8125rem" />
                  {logs.status.loadingHistory ? t('common:loading') : t('logs:loadEarlier')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 text-[0.78125rem] font-semibold"
                  onClick={exportJsonl}
                  disabled={logs.visible.length === 0}
                >
                  <Download size="0.8125rem" />
                  {t('logs:exportJsonl')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 text-[0.78125rem] text-muted-foreground"
                  onClick={() => void logs.clearCache()}
                  title={t('logs:clearCacheHint')}
                  disabled={logs.cacheCount === 0}
                >
                  <Trash2 size="0.8125rem" />
                  {t('logs:clearCache')}
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 text-[0.6875rem] text-muted-foreground">
              <span>
                {logs.status.logDir
                  ? t('logs:logFileHint', { path: logs.status.logDir })
                  : t('logs:logDirUnknown')}
              </span>
              {logs.cacheCount > 0 ? (
                <span>
                  {t('logs:cacheSize', { count: logs.cacheCount, size: formatBytes(logs.cacheBytes) })}
                </span>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {logs.visible.length === 0 ? (
                <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                  {logs.filteredActive
                    ? t('logs:noRecordsMatch')
                    : logs.status.metaAt === 0
                      ? t('logs:noRecordsWaiting')
                      : t('logs:noRecords')}
                </div>
              ) : (
                <Table className="table-fixed">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead style={{ width: '9rem' }} className="text-[0.6875rem] font-semibold text-muted-foreground">
                        {t('logs:time')}
                      </TableHead>
                      <TableHead style={{ width: '5rem' }} className="text-[0.6875rem] font-semibold text-muted-foreground">
                        {t('logs:level')}
                      </TableHead>
                      <TableHead style={{ width: '14rem' }} className="text-[0.6875rem] font-semibold text-muted-foreground">
                        {t('logs:event')}
                      </TableHead>
                      <TableHead className="text-[0.6875rem] font-semibold text-muted-foreground">
                        {t('logs:message')}
                      </TableHead>
                      <TableHead style={{ width: '3.5rem' }} className="text-[0.6875rem] font-semibold text-muted-foreground">
                        {t('logs:details')}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {logs.visible.map((entry) => {
                      const key = entryKey(entry)
                      const expanded = expandedId === key
                      return (
                        <Fragment key={key}>
                          <TableRow
                            className="cursor-pointer align-top"
                            onClick={() => setExpandedId(expanded ? null : key)}
                          >
                            <TableCell className="font-mono text-[0.6875rem] text-ink-muted">
                              {formatRecordTime(entry.tsNs, i18n.language)}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant="outline"
                                className={`rounded-full px-2 py-0.5 text-[0.65625rem] font-semibold ${LEVEL_STYLES[entry.severity] ?? ''}`}
                              >
                                {entry.severity}
                              </Badge>
                            </TableCell>
                            <TableCell className="font-mono text-[0.6875rem] break-all text-foreground">
                              {entry.event}
                            </TableCell>
                            <TableCell className="text-xs break-words text-foreground">{entry.body}</TableCell>
                            <TableCell>
                              {expanded ? (
                                <ChevronDown size="0.875rem" className="text-muted-foreground" />
                              ) : (
                                <ChevronRight size="0.875rem" className="text-muted-foreground" />
                              )}
                            </TableCell>
                          </TableRow>
                          {expanded ? (
                            <TableRow className="hover:bg-transparent">
                              <TableCell colSpan={5} className="bg-muted/30 py-2">
                                <div className="mb-1.5 flex items-center gap-3 text-[0.6875rem] text-muted-foreground">
                                  <span className="font-mono">seq={entry.seq}</span>
                                  {entry.traceId ? <span className="font-mono">trace={entry.traceId}</span> : null}
                                  {entry.spanId ? <span className="font-mono">span={entry.spanId}</span> : null}
                                  <span className="font-mono">{entry.source}</span>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="ml-auto h-6 gap-1 px-2 text-[0.6875rem]"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      void copyRecord(entry)
                                    }}
                                  >
                                    <Copy size="0.75rem" />
                                    {copiedId === key ? t('logs:copiedRecord') : t('logs:copyRecord')}
                                  </Button>
                                </div>
                                <pre className="max-h-[18rem] overflow-auto font-mono text-[0.6875rem] leading-relaxed text-ink-muted">
                                  {recordDetail(entry)}
                                </pre>
                              </TableCell>
                            </TableRow>
                          ) : null}
                        </Fragment>
                      )
                    })}
                  </TableBody>
                </Table>
              )}
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="samples" className="flex min-h-0 flex-1 flex-col gap-3">
          {/* daemon 侧的采样 (1Hz 抽稀, `kind=sample`) —— 与事件同一套 schema。
              ⚠ 与下面那张会话表不是一回事: 那张是本浏览器以 10Hz 记的, 可以导出 CSV;
              这一张是守护进程记的, 关掉页面、换台机器都还在。 */}
          <Card className="flex max-h-[16rem] min-h-0 flex-none flex-col gap-2 rounded-[0.875rem] px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[0.8125rem] font-semibold text-foreground">
                {t('logs:daemonSamples')}
              </div>
              <span className="text-[0.6875rem] text-muted-foreground">
                {t('logs:daemonSampleHint', { count: logs.samples.length })}
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {logs.samples.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                  {t('logs:noDaemonSamples')}
                </div>
              ) : (
                <Table className="table-fixed">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead style={{ width: '9rem' }} className="text-[0.6875rem] font-semibold text-muted-foreground">
                        {t('logs:time')}
                      </TableHead>
                      <TableHead style={{ width: '7rem' }} className="text-[0.6875rem] font-semibold text-muted-foreground">
                        {t('logs:state')}
                      </TableHead>
                      <TableHead style={{ width: '7rem' }} className="text-[0.6875rem] font-semibold text-muted-foreground">
                        {t('logs:maxTemp')}
                      </TableHead>
                      <TableHead style={{ width: '7rem' }} className="text-[0.6875rem] font-semibold text-muted-foreground">
                        {t('logs:maxSpeed')}
                      </TableHead>
                      <TableHead style={{ width: '7rem' }} className="text-[0.6875rem] font-semibold text-muted-foreground">
                        {t('logs:maxTorque')}
                      </TableHead>
                      <TableHead style={{ width: '5rem' }} className="text-[0.6875rem] font-semibold text-muted-foreground">
                        {t('logs:faultCount')}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {logs.samples.slice(-200).reverse().map((entry) => {
                      const summary = sampleSummary(entry)
                      return (
                        <TableRow key={`sample-${entry.seq}-${entry.tsNs}`}>
                          <TableCell className="font-mono text-xs text-ink-muted">
                            {formatRecordTime(entry.tsNs, i18n.language)}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="rounded-full px-2.5 py-0.5 text-[0.71875rem] font-semibold">
                              {summary.state || '—'}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-foreground">
                            {summary.temp !== null ? `${summary.temp.toFixed(0)} ${t('logs:unitTemp')}` : '—'}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-foreground">
                            {summary.speed !== null ? `${summary.speed.toFixed(3)} ${t('logs:unitSpeed')}` : '—'}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-foreground">
                            {summary.torque !== null ? `${summary.torque.toFixed(2)} ${t('logs:unitTorque')}` : '—'}
                          </TableCell>
                          <TableCell className="text-xs text-foreground">
                            {summary.faults > 0 ? (
                              <Badge variant="outline" className="rounded-full px-2.5 py-0.5 text-[0.71875rem] font-semibold text-destructive">
                                {summary.faults}
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground">0</span>
                            )}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              )}
            </div>
          </Card>

          {vm.error ? (
            <div className="px-4 py-6 text-center text-sm text-destructive">{vm.error}</div>
          ) : (
            <div className="flex min-h-0 flex-1 gap-3">
              <Card className="flex w-[26rem] flex-none flex-col gap-2.5 rounded-[0.875rem] px-4 py-3.5">
                <div className="text-[0.8125rem] font-semibold text-foreground">{t('logs:sessions')}</div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {vm.sessions.length === 0 ? (
                    <div className="px-4 py-8 text-center text-[0.8125rem] leading-relaxed text-muted-foreground">
                      {vm.connected ? t('logs:noSessionsWaiting') : t('logs:notConnected')}
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {vm.sessions.map((s) => {
                        const active = s.id === vm.selectedId
                        return (
                          <div
                            key={s.id}
                            role="button"
                            tabIndex={0}
                            onClick={() => vm.selectSession(s.id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') vm.selectSession(s.id)
                            }}
                            className={`cursor-pointer rounded-[0.625rem] border px-3 py-2 transition-colors ${
                              active
                                ? 'border-info-line bg-info-soft'
                                : 'border-border bg-transparent hover:bg-muted/60'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[0.78125rem] font-semibold text-foreground">
                                #{s.id} · {formatTs(s.startedAt, i18n.language)}
                              </span>
                              {s.endedAt === null ? (
                                <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[0.65625rem] font-semibold text-emerald-700 dark:text-emerald-300">
                                  {t('logs:recording')}
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[0.65625rem] font-semibold text-slate-500 dark:text-slate-400">
                                  {t('logs:notRecording')}
                                </Badge>
                              )}
                            </div>
                            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[0.6875rem] text-muted-foreground">
                              <span>
                                {t('logs:samples')}: <span className="font-mono">{s.sampleCount}</span>
                              </span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </Card>

              <Card className="flex min-w-0 flex-1 flex-col gap-2.5 rounded-[0.875rem] px-4 py-3.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[0.8125rem] font-semibold text-foreground">
                    {vm.session ? `${t('logs:sessionTitle')} #${vm.session.id}` : t('logs:samples')}
                  </div>
                  {vm.session ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-auto gap-1.5 rounded-[0.5625rem] px-3 py-1.5 text-[0.78125rem] font-semibold"
                      onClick={() => vm.exportSession(vm.session!.id)}
                      disabled={vm.exporting === vm.session.id}
                    >
                      <Download size="0.8125rem" className={vm.exporting === vm.session.id ? 'animate-pulse' : ''} />
                      {t('logs:export')}
                    </Button>
                  ) : null}
                </div>

                <div className="min-h-0 flex-1 overflow-auto">
                  {vm.selectedId === null ? (
                    <div className="px-4 py-12 text-center text-sm text-muted-foreground">{t('logs:selectSession')}</div>
                  ) : vm.samplesLoading && vm.samples.length === 0 ? (
                    <div className="px-4 py-12 text-center text-sm text-muted-foreground">{t('common:loading')}</div>
                  ) : vm.samples.length === 0 ? (
                    <div className="px-4 py-12 text-center text-sm text-muted-foreground">{t('logs:noSamples')}</div>
                  ) : (
                    <Table className="table-fixed">
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead style={{ width: '9rem' }} className="text-[0.6875rem] font-semibold text-muted-foreground">
                            {t('logs:time')}
                          </TableHead>
                          <TableHead style={{ width: '6rem' }} className="text-[0.6875rem] font-semibold text-muted-foreground">
                            {t('logs:state')}
                          </TableHead>
                          <TableHead style={{ width: '7rem' }} className="text-[0.6875rem] font-semibold text-muted-foreground">
                            {t('logs:maxTemp')}
                          </TableHead>
                          <TableHead style={{ width: '7rem' }} className="text-[0.6875rem] font-semibold text-muted-foreground">
                            {t('logs:maxSpeed')}
                          </TableHead>
                          <TableHead style={{ width: '7rem' }} className="text-[0.6875rem] font-semibold text-muted-foreground">
                            {t('logs:maxTorque')}
                          </TableHead>
                          <TableHead style={{ width: '5rem' }} className="text-[0.6875rem] font-semibold text-muted-foreground">
                            {t('logs:faultCount')}
                          </TableHead>
                          <TableHead style={{ width: '2.5rem' }} className="text-[0.6875rem] font-semibold text-muted-foreground">
                            {t('logs:details')}
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {vm.samples.map((s) => {
                          const expanded = expandedId === `sample-${s.id}`
                          const temp = maxTemp(s.temps)
                          const speed = maxAbs(s.dq)
                          const torque = maxAbs(s.tau)
                          return (
                            <Fragment key={s.id}>
                              <TableRow
                                className="cursor-pointer"
                                onClick={() => setExpandedId(expanded ? null : `sample-${s.id}`)}
                              >
                                <TableCell className="font-mono text-xs text-ink-muted">{formatTs(s.ts, i18n.language)}</TableCell>
                                <TableCell>
                                  <Badge variant="outline" className="rounded-full px-2.5 py-0.5 text-[0.71875rem] font-semibold">
                                    {s.state || '—'}
                                  </Badge>
                                </TableCell>
                                <TableCell className="font-mono text-xs text-foreground">
                                  {temp !== null ? `${temp.toFixed(0)} ${t('logs:unitTemp')}` : '—'}
                                </TableCell>
                                <TableCell className="font-mono text-xs text-foreground">
                                  {speed !== null ? `${speed.toFixed(3)} ${t('logs:unitSpeed')}` : '—'}
                                </TableCell>
                                <TableCell className="font-mono text-xs text-foreground">
                                  {torque !== null ? `${torque.toFixed(2)} ${t('logs:unitTorque')}` : '—'}
                                </TableCell>
                                <TableCell className="text-xs text-foreground">
                                  {s.faults.length > 0 ? (
                                    <Badge variant="outline" className="rounded-full px-2.5 py-0.5 text-[0.71875rem] font-semibold text-destructive">
                                      {s.faults.length}
                                    </Badge>
                                  ) : (
                                    <span className="text-muted-foreground">0</span>
                                  )}
                                </TableCell>
                                <TableCell>
                                  {expanded ? (
                                    <ChevronDown size="0.875rem" className="text-muted-foreground" />
                                  ) : (
                                    <ChevronRight size="0.875rem" className="text-muted-foreground" />
                                  )}
                                </TableCell>
                              </TableRow>
                              {expanded ? (
                                <TableRow className="hover:bg-transparent">
                                  <TableCell colSpan={7} className="bg-muted/30 py-2">
                                    <pre className="overflow-auto font-mono text-[0.6875rem] leading-relaxed text-ink-muted">
                                      {jointDetailLines(s).join('\n')}
                                    </pre>
                                  </TableCell>
                                </TableRow>
                              ) : null}
                            </Fragment>
                          )
                        })}
                      </TableBody>
                    </Table>
                  )}
                </div>

                {vm.selectedId !== null && vm.samples.length > 0 && vm.hasMore ? (
                  <div className="flex flex-none justify-center pt-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-auto rounded-[0.5625rem] px-3 py-1.5 text-[0.78125rem] font-semibold"
                      onClick={vm.loadOlder}
                      disabled={vm.samplesLoading}
                    >
                      {vm.samplesLoading ? t('common:loading') : t('logs:loadOlder')}
                    </Button>
                  </div>
                ) : null}
              </Card>
            </div>
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={retentionDialogOpen} onOpenChange={setRetentionDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('logs:retentionDialogTitle')}</DialogTitle>
            <DialogDescription>{t('logs:retentionDialogDesc')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium text-foreground">{t('logs:retentionLimit')}</span>
              <span className="font-mono text-xs text-muted-foreground">
                {t('logs:retentionRange', { min: vm.retentionMinMb, max: vm.retentionMaxMb })}
              </span>
            </div>
            <div className="relative">
              <NumberField
                value={retentionDraft}
                min={vm.retentionMinMb}
                max={vm.retentionMaxMb}
                step={10}
                onCommit={setRetentionDraft}
                className="h-10 w-full rounded-lg pr-10 text-right font-mono text-base text-foreground"
              />
              <span className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-sm text-muted-foreground">
                {t('logs:megabytesUnit')}
              </span>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setRetentionDialogOpen(false)}>
              {t('common:cancel')}
            </Button>
            <Button type="button" size="sm" onClick={applyRetention}>
              {t('common:save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 展开状态的 key: 实时流里 `id` 还没落库, 用 `seq`; 回读的记录用 `id`。 */
function entryKey(entry: LogEntry): string {
  return entry.id !== undefined ? `db-${entry.id}` : `seq-${entry.seq}-${entry.tsNs}`
}

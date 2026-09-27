import { ChevronDown, ChevronRight, Download, Pencil, RefreshCw } from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useTelemetryState } from './useTelemetryState'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
import { NumberField } from '@/components/ui/number-field'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ControllerLogPanel } from '@/features/logs/ControllerLogPanel'
import type { TelemetrySample } from './telemetryDb'

function formatTs(value: number, locale: string) {
  if (!Number.isFinite(value)) return ''
  const date = new Date(value * 1000)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(locale.startsWith('en') ? 'en-US' : 'zh-CN', { hour12: false })
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

export function TelemetryLogsPage() {
  const { t, i18n } = useTranslation(['common', 'nav', 'telemetry'])
  const vm = useTelemetryState()
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [tab, setTab] = useState<'samples' | 'logs'>('samples')
  const [retentionDialogOpen, setRetentionDialogOpen] = useState(false)
  const [retentionDraft, setRetentionDraft] = useState(vm.retentionMb)

  // 每次打开弹窗时用当前生效值重置草稿，避免残留上一次的编辑内容
  useEffect(() => {
    if (retentionDialogOpen) setRetentionDraft(vm.retentionMb)
  }, [retentionDialogOpen, vm.retentionMb])

  const applyRetention = () => {
    vm.setRetentionMb(retentionDraft)
    setRetentionDialogOpen(false)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3.5">
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as 'samples' | 'logs')}
        className="flex min-h-0 flex-1 flex-col gap-3"
      >
        <Card className="flex flex-none flex-row flex-nowrap items-center gap-x-3 overflow-x-auto rounded-[0.875rem] px-4 py-3">
          <TabsList className="h-9 shrink-0">
            <TabsTrigger value="samples">{t('telemetry:tabsSamples')}</TabsTrigger>
            <TabsTrigger value="logs">{t('logs:tabsController')}</TabsTrigger>
          </TabsList>
          <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
            <span className="text-[0.75rem] font-medium text-muted-foreground">{t('telemetry:status')}</span>
            {vm.recording ? (
              <Badge variant="outline" className="rounded-full px-2.5 py-0.5 text-[0.71875rem] font-semibold text-emerald-700 dark:text-emerald-300">
                {t('telemetry:recording')}
              </Badge>
            ) : (
              <Badge variant="outline" className="rounded-full px-2.5 py-0.5 text-[0.71875rem] font-semibold text-slate-600 dark:text-slate-300">
                {vm.connected ? t('telemetry:connectedIdle') : t('telemetry:notConnected')}
              </Badge>
            )}
          </div>
          <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
            {t('telemetry:sampleRate')}:{' '}
            <span className="font-mono text-foreground">{t('telemetry:sampleHz', { value: vm.sampleHz })}</span>
          </span>
          <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
            {t('telemetry:sessionSamples')}: <span className="font-mono text-foreground">{vm.sessionSamples}</span>
          </span>
          <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
            {t('telemetry:totalSamples')}: <span className="font-mono text-foreground">{vm.totalSamples}</span>
          </span>
          <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
            {t('telemetry:lastSample')}:{' '}
            <span className="font-mono text-foreground">
              {vm.lastSampleAt ? formatTs(vm.lastSampleAt, i18n.language) : '—'}
            </span>
          </span>
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
            aria-label={t('telemetry:retentionDialogTitle')}
            title={t('telemetry:retentionDialogTitle')}
            className="shrink-0 gap-1 text-[0.78125rem] text-muted-foreground hover:text-foreground"
          >
            {t('telemetry:retentionLimit')}:
            <span className="font-mono font-semibold text-foreground">{vm.retentionMb}</span>
            <span className="text-muted-foreground">{t('telemetry:megabytesUnit')}</span>
            <Pencil size="0.8125rem" className="text-muted-foreground" />
          </Button>
        </Card>

        <TabsContent value="samples" className="flex min-h-0 flex-1 flex-col gap-3">
          {vm.error ? (
            <div className="px-4 py-6 text-center text-sm text-destructive">{vm.error}</div>
          ) : (
            <div className="flex min-h-0 flex-1 gap-3">
              <Card className="flex w-[26rem] flex-none flex-col gap-2.5 rounded-[0.875rem] px-4 py-3.5">
            <div className="text-[0.8125rem] font-semibold text-foreground">{t('telemetry:sessions')}</div>
            <div className="min-h-0 flex-1 overflow-auto">
              {vm.sessions.length === 0 ? (
                <div className="px-4 py-8 text-center text-[0.8125rem] leading-relaxed text-muted-foreground">
                  {vm.connected ? t('telemetry:noSessionsWaiting') : t('telemetry:notConnected')}
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
                              {t('telemetry:recording')}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[0.65625rem] font-semibold text-slate-500 dark:text-slate-400">
                              {t('telemetry:notRecording')}
                            </Badge>
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[0.6875rem] text-muted-foreground">
                          <span>
                            {t('telemetry:samples')}: <span className="font-mono">{s.sampleCount}</span>
                          </span>
                          {s.robotSerial ? <span className="font-mono">{s.robotSerial}</span> : null}
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
                {vm.session ? `${t('telemetry:sessionTitle')} #${vm.session.id}` : t('telemetry:samples')}
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
                  {t('telemetry:export')}
                </Button>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {vm.selectedId === null ? (
                <div className="px-4 py-12 text-center text-sm text-muted-foreground">{t('telemetry:selectSession')}</div>
              ) : vm.samplesLoading && vm.samples.length === 0 ? (
                <div className="px-4 py-12 text-center text-sm text-muted-foreground">{t('common:loading')}</div>
              ) : vm.samples.length === 0 ? (
                <div className="px-4 py-12 text-center text-sm text-muted-foreground">{t('telemetry:noSamples')}</div>
              ) : (
                <Table className="table-fixed">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead style={{ width: '9rem' }} className="text-[0.6875rem] font-semibold text-muted-foreground">
                        {t('telemetry:time')}
                      </TableHead>
                      <TableHead style={{ width: '6rem' }} className="text-[0.6875rem] font-semibold text-muted-foreground">
                        {t('telemetry:state')}
                      </TableHead>
                      <TableHead style={{ width: '7rem' }} className="text-[0.6875rem] font-semibold text-muted-foreground">
                        {t('telemetry:maxTemp')}
                      </TableHead>
                      <TableHead style={{ width: '7rem' }} className="text-[0.6875rem] font-semibold text-muted-foreground">
                        {t('telemetry:maxSpeed')}
                      </TableHead>
                      <TableHead style={{ width: '7rem' }} className="text-[0.6875rem] font-semibold text-muted-foreground">
                        {t('telemetry:maxTorque')}
                      </TableHead>
                      <TableHead style={{ width: '5rem' }} className="text-[0.6875rem] font-semibold text-muted-foreground">
                        {t('telemetry:faultCount')}
                      </TableHead>
                      <TableHead style={{ width: '2.5rem' }} className="text-[0.6875rem] font-semibold text-muted-foreground">
                        {t('telemetry:details')}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {vm.samples.map((s) => {
                      const expanded = expandedId === s.id
                      const temp = maxTemp(s.temps)
                      const speed = maxAbs(s.dq)
                      const torque = maxAbs(s.tau)
                      return (
                        <Fragment key={s.id}>
                          <TableRow
                            className="cursor-pointer"
                            onClick={() => setExpandedId(expanded ? null : (s.id ?? null))}
                          >
                            <TableCell className="font-mono text-xs text-ink-muted">{formatTs(s.ts, i18n.language)}</TableCell>
                            <TableCell>
                              <Badge variant="outline" className="rounded-full px-2.5 py-0.5 text-[0.71875rem] font-semibold">
                                {s.state || '—'}
                              </Badge>
                            </TableCell>
                            <TableCell className="font-mono text-xs text-foreground">
                              {temp !== null ? `${temp.toFixed(0)} ${t('telemetry:unitTemp')}` : '—'}
                            </TableCell>
                            <TableCell className="font-mono text-xs text-foreground">
                              {speed !== null ? `${speed.toFixed(3)} ${t('telemetry:unitSpeed')}` : '—'}
                            </TableCell>
                            <TableCell className="font-mono text-xs text-foreground">
                              {torque !== null ? `${torque.toFixed(2)} ${t('telemetry:unitTorque')}` : '—'}
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
                  {vm.samplesLoading ? t('common:loading') : t('telemetry:loadOlder')}
                </Button>
              </div>
            ) : null}
              </Card>
            </div>
          )}
        </TabsContent>

        <TabsContent value="logs" className="flex min-h-0 flex-1 flex-col">
          <ControllerLogPanel />
        </TabsContent>
      </Tabs>

      <Dialog open={retentionDialogOpen} onOpenChange={setRetentionDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('telemetry:retentionDialogTitle')}</DialogTitle>
            <DialogDescription>{t('telemetry:retentionDialogDesc')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium text-foreground">{t('telemetry:retentionLimit')}</span>
              <span className="font-mono text-xs text-muted-foreground">
                {t('telemetry:retentionRange', { min: vm.retentionMinMb, max: vm.retentionMaxMb })}
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
                {t('telemetry:megabytesUnit')}
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

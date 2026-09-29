import { useTranslation } from 'react-i18next'
import { AlertTriangle, FileJson, RefreshCw, ScanLine, Upload } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { NumberField } from '@/components/ui/number-field'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Toggle } from '@/components/ui/toggle'
import { useGripperSettings, TRAVEL_MAX_MM, TRAVEL_MIN_MM } from './useGripperSettings'
import type { CalibrationSource } from '@/lib/arm/gripperClient'

const SOURCE_KEYS: Record<CalibrationSource, string> = {
  measured: 'gripper:source.measured',
  template: 'gripper:source.template',
  factory: 'gripper:source.factory',
  missing: 'gripper:source.missing',
}

const AUTO = '__auto__'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[0.6875rem] font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

/**
 * 设置页里的夹爪段（§6.2）：这一路 CAN 接口上的 LiteGrip 怎么接、用哪份标定。
 *
 * 只做配置。操作夹爪（张开/闭合/夹取/急停）在夹爪页，两处共用同一个客户端。
 */
export function GripperSection() {
  const { t } = useTranslation(['common', 'gripper'])
  const vm = useGripperSettings()

  const calibrationRows = vm.calibrations

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4 rounded-[0.875rem] p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-foreground">{t('gripper:settings.title')}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('gripper:settings.description')}</p>
          </div>
          <Badge
            id="gripper-settings-status"
            data-testid="gripper-settings-status"
            variant={vm.connected ? 'success' : 'outline'}
            className="h-auto flex-none rounded-full px-2.5 py-0.5 text-[0.71875rem] font-semibold"
          >
            {vm.present
              ? vm.connected
                ? t('common:connected')
                : t('common:disconnected')
              : t('common:statusOffline')}
          </Badge>
        </div>

        {!vm.present ? (
          <p className="rounded-lg border border-line bg-muted/40 px-3 py-2 text-[0.71875rem] text-muted-foreground">
            {t('gripper:connection.noSession')}
          </p>
        ) : null}

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Field label={t('gripper:settings.channel')}>
            <Select value={vm.channel} onValueChange={vm.setChannel}>
              <SelectTrigger id="gripper-channel" data-testid="gripper-channel">
                {/* 内核枚举到的接口；一个都没有时仍显示当前配置，便于排查 */}
                <SelectValue placeholder={vm.conn?.channel || '—'} />
              </SelectTrigger>
              <SelectContent>
                {(vm.channels.length ? vm.channels : [vm.conn?.channel || 'can0']).map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('gripper:settings.canId')}>
            <NumberField
              value={vm.canId}
              min={0}
              max={0x7ff}
              step={1}
              onCommit={vm.setCanId}
            />
          </Field>
          <Field label={t('gripper:settings.mstId')}>
            <NumberField
              value={vm.mstId ?? 0}
              min={0}
              max={0x7ff}
              step={1}
              onCommit={(v) => vm.setMstId(v === 0 ? null : v)}
            />
          </Field>
          <Field label={t('gripper:settings.mount')}>
            <Select
              value={vm.mount ?? AUTO}
              onValueChange={(v) => vm.setMount(v === AUTO ? null : (v as 'normal' | 'reverse'))}
            >
              <SelectTrigger id="gripper-mount" data-testid="gripper-mount">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO}>{t('gripper:connection.mountUnknown')}</SelectItem>
                <SelectItem value="normal">{t('gripper:connection.mountNormal')}</SelectItem>
                <SelectItem value="reverse">{t('gripper:connection.mountReverse')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            id="gripper-apply"
            data-testid="gripper-apply"
            size="sm"
            disabled={!vm.present || vm.applying}
            onClick={() => void vm.apply()}
          >
            <RefreshCw className={vm.applying ? 'size-3.5 animate-spin' : 'size-3.5'} />
            {vm.applying ? t('gripper:settings.applying') : t('gripper:settings.apply')}
          </Button>
          <Button
            id="gripper-save-template"
            data-testid="gripper-save-template"
            size="sm"
            variant="outline"
            disabled={!vm.connected || vm.mount == null}
            onClick={() => void vm.useTemplate(vm.mount ?? 'normal')}
          >
            <ScanLine className="size-3.5" />
            {t('gripper:settings.declareMount')}
          </Button>
          {!vm.connected ? (
            <span className="text-[0.6875rem] text-muted-foreground">{t('gripper:settings.needsDisconnect')}</span>
          ) : null}
          {/* 声明与实际可能不同：菜单里是**声明**，这句话说的是设备**实际**在跑的方向。 */}
          {vm.conn?.mount && vm.conn.mount !== vm.mount ? (
            <span id="gripper-effective-mount" data-testid="gripper-effective-mount" className="text-[0.6875rem] text-warn">
              {t('gripper:settings.effectiveMount', {
                mount: t(`gripper:connection.mount${vm.conn.mount === 'reverse' ? 'Reverse' : 'Normal'}`),
              })}
            </span>
          ) : null}
        </div>
      </Card>

      <Card className="flex flex-col gap-3 rounded-[0.875rem] p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-foreground">{t('gripper:settings.calibrations')}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('gripper:settings.calibrationsDesc')}</p>
          </div>
          <Button
            id="gripper-rescan"
            data-testid="gripper-rescan"
            size="sm"
            variant="outline"
            disabled={vm.scanning}
            onClick={() => void vm.refresh()}
          >
            <RefreshCw className={vm.scanning ? 'size-3.5 animate-spin' : 'size-3.5'} />
            {t('gripper:settings.refresh')}
          </Button>
        </div>

        {calibrationRows.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('gripper:source.missing')}</p>
        ) : (
          <ul id="gripper-calibrations" data-testid="gripper-calibrations" className="flex flex-col gap-2">
            {calibrationRows.map((row) => {
              const inUse = row.inUse ?? (vm.activePath != null && row.path === vm.activePath)
              return (
                <li
                  key={`${row.path}-${row.template ?? ''}`}
                  className="flex flex-col gap-1 rounded-lg border border-line px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <Badge variant={row.valid ? 'outline' : 'destructive'} className="h-auto rounded-full px-2 py-0 text-[0.65625rem] font-semibold">
                      {row.valid ? t('gripper:settings.valid') : t('gripper:settings.invalid')}
                    </Badge>
                    <span className="text-[0.75rem] font-semibold text-ink-strong">{t(SOURCE_KEYS[row.source])}</span>
                    {row.template ? (
                      <span className="font-mono text-[0.65625rem] text-muted-foreground">{row.template}</span>
                    ) : null}
                    {inUse ? (
                      <Badge variant="success" className="h-auto rounded-full px-2 py-0 text-[0.65625rem] font-semibold">
                        {t('gripper:settings.inUse')}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="truncate font-mono text-[0.65625rem] text-muted-foreground" title={row.path}>
                    {row.path}
                  </div>
                  <div className="flex flex-wrap gap-3 font-mono text-[0.65625rem] text-muted-foreground">
                    <span>
                      {t('gripper:source.closed')} {row.closedRad == null ? '—' : row.closedRad.toFixed(4)}
                    </span>
                    <span>
                      {t('gripper:source.open')} {row.openRad == null ? '—' : row.openRad.toFixed(4)}
                    </span>
                    <span>
                      {t('gripper:source.derived')} {row.fileRadToMm == null ? '—' : row.fileRadToMm.toFixed(2)}
                    </span>
                  </div>
                  {row.problems.length ? (
                    <div className="text-[0.65625rem] text-destructive">
                      {t('gripper:settings.problems')}: {row.problems.join('；')}
                    </div>
                  ) : null}
                  {row.warnings.length ? (
                    <div className="text-[0.65625rem] text-warn">
                      {t('gripper:settings.warnings')}: {row.warnings.join('；')}
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}

        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <div className="flex items-center gap-1.5 text-[0.6875rem] font-semibold text-ink-muted">
            <FileJson className="size-3.5" />
            {t('gripper:settings.import')}
          </div>
          <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">{t('gripper:settings.importDesc')}</p>
          <div className="flex gap-2">
            <Input
              id="gripper-import-path"
              data-testid="gripper-import-path"
              value={vm.importPath}
              placeholder={t('gripper:settings.importPlaceholder')}
              spellCheck={false}
              onChange={(e) => vm.setImportPath(e.target.value)}
            />
            <Button
              id="gripper-import"
              data-testid="gripper-import"
              size="sm"
              variant="outline"
              disabled={!vm.connected || vm.importPath.trim() === ''}
              onClick={() => void vm.importCalibration()}
            >
              <Upload className="size-3.5" />
              {t('common:import')}
            </Button>
          </div>
        </div>
      </Card>

      <Card className="flex flex-col gap-3 rounded-[0.875rem] p-5">
        <div>
          <h2 className="text-sm font-bold text-foreground">{t('gripper:zero.title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('gripper:zero.desc')}</p>
        </div>

        <div className="grid grid-cols-2 gap-3 md:max-w-md">
          <Field label={t('gripper:zero.travel')}>
            <NumberField
              value={vm.travel}
              min={TRAVEL_MIN_MM}
              max={TRAVEL_MAX_MM}
              step={0.5}
              onCommit={vm.setTravel}
            />
          </Field>
          <div className="flex items-end gap-2">
            <Button
              id="gripper-zero"
              data-testid="gripper-zero"
              size="sm"
              disabled={!vm.connected || !vm.enabled || vm.probing || !(vm.travel > 0)}
              onClick={() => void vm.zero()}
            >
              <ScanLine className="size-3.5" />
              {vm.probing ? t('gripper:zero.running') : t('gripper:zero.start')}
            </Button>
          </div>
        </div>

        <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">{t('gripper:settings.travelDesc')}</p>
        {!vm.enabled && vm.connected ? (
          <p className="text-[0.6875rem] text-warn">{t('gripper:zero.needsEnabled')}</p>
        ) : null}

        {vm.calib && vm.probing ? (
          <div className="flex flex-col gap-1.5" id="gripper-zero-progress" data-testid="gripper-zero-progress">
            <Progress value={Math.round(vm.calib.progress * 100)} />
            <div className="text-[0.6875rem] text-muted-foreground">
              {t(`gripper:zero.phase.${vm.calib.phase}`, { defaultValue: vm.calib.phase })} · {vm.calib.detail}
            </div>
          </div>
        ) : null}
      </Card>

      <Card className="flex flex-col gap-3 rounded-[0.875rem] p-5">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 flex-none text-warn" />
          <div className="flex-1">
            <h2 className="text-sm font-bold text-foreground">{t('gripper:settings.allowFactory')}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('gripper:settings.allowFactoryDesc')}</p>
          </div>
          <Toggle
            id="gripper-allow-factory"
            data-testid="gripper-allow-factory"
            aria-label={t('gripper:settings.allowFactory')}
            pressed={vm.conn?.allowFactory === true}
            disabled={!vm.present}
            onPressedChange={(pressed) => void vm.setAllowFactory(pressed)}
          />
        </div>
      </Card>
    </div>
  )
}

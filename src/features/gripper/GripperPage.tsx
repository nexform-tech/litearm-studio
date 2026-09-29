import { useTranslation } from 'react-i18next'
import { Gauge, Grip, Maximize2, Minimize2, Power, ShieldAlert, Thermometer, Wrench } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Slider } from '@/components/ui/slider'
import { useGripperPage, FORCE_MAX_N, SPEED_MAX_MM_S, SPEED_MIN_MM_S } from './useGripperPage'
import type { GripperPageVm } from './useGripperPage'
import type { CalibrationSource } from '@/lib/arm/gripperClient'

const SOURCE_KEYS: Record<CalibrationSource, string> = {
  measured: 'gripper:source.measured',
  template: 'gripper:source.template',
  factory: 'gripper:source.factory',
  missing: 'gripper:source.missing',
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[0.6875rem] font-medium text-muted-foreground">{label}</div>
      <div className="font-mono text-[1.0625rem] leading-none font-bold text-foreground">
        {value}
        {unit ? <span className="ml-0.5 text-[0.6875rem] font-medium text-muted-foreground">{unit}</span> : null}
      </div>
    </div>
  )
}

/** 标定卡片：永远显示来源、文件、两个端点角度、推导行程与装配方向（§6.3）。 */
function CalibrationCard({ vm }: { vm: GripperPageVm }) {
  const { t } = useTranslation(['gripper'])
  const conn = vm.conn
  const source = conn?.source ?? null
  const warning =
    source === 'template'
      ? t('gripper:source.templateWarning')
      : source === 'factory'
        ? t('gripper:source.factoryWarning')
        : source === 'missing'
          ? t('gripper:source.missingWarning')
          : ''

  const gateKey = vm.gate ?? 'BLOCKED'
  return (
    <Card className="flex flex-col gap-3 rounded-[0.875rem] p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-foreground">{t('gripper:source.label')}</h2>
        <Badge
          id="gripper-gate" data-testid="gripper-gate"
          variant={gateKey === 'READY' ? 'success' : gateKey === 'BLOCKED' ? 'destructive' : 'outline'}
          className="h-auto rounded-full px-2.5 py-0.5 text-[0.71875rem] font-semibold"
        >
          {t(`gripper:gate.${gateKey}`)}
        </Badge>
      </div>

      <div id="gripper-source" data-testid="gripper-source" className="text-[0.8125rem] font-semibold text-ink-strong">
        {source ? t(SOURCE_KEYS[source]) : t('gripper:source.none')}
      </div>
      {conn?.path ? (
        <div className="truncate font-mono text-[0.6875rem] text-muted-foreground" title={conn.path}>
          {conn.path}
        </div>
      ) : null}

      {warning ? (
        <div className="rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-[0.71875rem] leading-relaxed text-warn">
          {warning}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <Stat label={t('gripper:connection.mount')} value={mountLabel(vm, t)} />
        <Stat label={t('gripper:connection.travel')} value={vm.travelMm.toFixed(1)} unit="mm" />
        <Stat
          label={t('gripper:source.closed')}
          value={conn?.closedRad == null ? t('gripper:readout.unknown') : conn.closedRad.toFixed(4)}
          unit="rad"
        />
        <Stat
          label={t('gripper:source.open')}
          value={conn?.openRad == null ? t('gripper:readout.unknown') : conn.openRad.toFixed(4)}
          unit="rad"
        />
      </div>
      {vm.mountMismatch ? (
        <div className="text-[0.71875rem] text-warn">
          {t('gripper:connection.mountMismatch', {
            declared: t(`gripper:connection.mount${vm.conn?.declaredMount === 'reverse' ? 'Reverse' : 'Normal'}`),
            actual: t(`gripper:connection.mount${vm.conn?.mount === 'reverse' ? 'Reverse' : 'Normal'}`),
          })}
        </div>
      ) : null}
      <div className="text-[0.6875rem] leading-relaxed text-muted-foreground">{t(`gripper:gate.${gateKey}_why`)}</div>
    </Card>
  )
}

function mountLabel(vm: GripperPageVm, t: (k: string) => string): string {
  const mount = vm.conn?.mount
  if (mount === 'normal') return t('gripper:connection.mountNormal')
  if (mount === 'reverse') return t('gripper:connection.mountReverse')
  return t('gripper:connection.mountUnknown')
}

export function GripperPage() {
  const { t } = useTranslation(['common', 'gripper'])
  const vm = useGripperPage()
  const state = vm.state

  const statusTone = vm.connected ? 'success' : vm.status === 'error' ? 'destructive' : 'outline'
  const busyText = vm.busy.busy ? vm.busy.what || t('gripper:busy.label') : ''

  return (
    <div className="flex min-h-0 flex-1 gap-3.5 overflow-y-auto p-3.5">
      {/* LEFT: 连接与操作 */}
      <div className="flex min-w-[23rem] flex-1 flex-col gap-3">
        <Card className="flex flex-col gap-3 rounded-[0.875rem] p-5">
          <div className="flex items-center gap-2.5">
            <div className="flex size-7 items-center justify-center rounded-lg bg-chip text-chip-fg">
              <Grip size="0.875rem" />
            </div>
            <div className="flex-1">
              <div className="text-[0.90625rem] leading-tight font-semibold text-foreground">
                {t('gripper:page.title')}
              </div>
              <div className="text-[0.71875rem] text-muted-foreground">
                {t('gripper:page.subtitle', { max: vm.travelMm.toFixed(0) })}
              </div>
            </div>
            <Badge
              id="gripper-status" data-testid="gripper-status"
              variant={statusTone}
              className="h-auto rounded-full px-2.5 py-0.5 text-[0.71875rem] font-semibold"
            >
              {vm.present
                ? vm.connected
                  ? t('common:connected')
                  : vm.status === 'connecting'
                    ? t('common:connecting')
                    : vm.status === 'error'
                      ? t('common:connectFailed')
                      : t('common:disconnected')
                : t('common:statusOffline')}
            </Badge>
          </div>

          <div className="flex flex-wrap items-center gap-3 font-mono text-[0.6875rem] text-muted-foreground">
            <span>
              {t('gripper:connection.channel')}: {vm.conn?.channel || '—'}
            </span>
            <span>
              {t('gripper:connection.canId')}: {vm.conn ? `0x${vm.conn.canId.toString(16).toUpperCase().padStart(2, '0')}` : '—'}
            </span>
            <span>
              {t('gripper:connection.mount')}: {mountLabel(vm, t)}
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              id="gripper-connect" data-testid="gripper-connect"
              size="sm"
              disabled={!vm.present || vm.connected || vm.status === 'connecting'}
              title={t('gripper:connection.connectHint')}
              onClick={() => vm.connect()}
            >
              {t('nav:connect')}
            </Button>
            <Button
              id="gripper-disconnect" data-testid="gripper-disconnect"
              size="sm"
              variant="outline"
              disabled={!vm.present || vm.status === 'disconnected'}
              onClick={() => vm.disconnect()}
            >
              {t('common:disconnect')}
            </Button>
            <div className="flex-1" />
            <Button
              id="gripper-enable" data-testid="gripper-enable"
              size="sm"
              variant="outline"
              disabled={!vm.connected || vm.enabled || vm.estopped}
              onClick={vm.enable}
            >
              <Power size="0.8125rem" /> {t('gripper:actions.enable')}
            </Button>
            <Button
              id="gripper-disable" data-testid="gripper-disable"
              size="sm"
              variant="outline"
              disabled={!vm.connected || !vm.enabled}
              onClick={vm.disable}
            >
              {t('gripper:actions.disable')}
            </Button>
          </div>

          {!vm.present ? (
            <div className="rounded-lg border border-line bg-muted/40 px-3 py-2 text-[0.71875rem] text-muted-foreground">
              {t('gripper:connection.noSession')}
            </div>
          ) : vm.disabledReason ? (
            <div
              id="gripper-disabled-reason" data-testid="gripper-disabled-reason"
              className="rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-[0.71875rem] leading-relaxed text-warn"
            >
              {vm.disabledReason}
            </div>
          ) : null}

          {busyText ? (
            <div id="gripper-busy" data-testid="gripper-busy" className="text-[0.71875rem] text-muted-foreground">
              {busyText}
            </div>
          ) : null}

          {vm.conn?.error ? (
            <div className="text-[0.71875rem] text-destructive" title={vm.conn.error}>
              {vm.conn.error}
            </div>
          ) : null}
        </Card>

        {/* 开合位置：主控制 */}
        <Card className="flex flex-col gap-3 rounded-[0.875rem] p-5">
          <div className="flex items-baseline justify-between">
            <div className="text-[0.8125rem] font-semibold text-ink">{t('gripper:aperture.title')}</div>
            <div id="gripper-position" data-testid="gripper-position" className="font-mono text-[1.375rem] leading-none font-bold text-foreground">
              {state?.positionMm == null ? (
                <span className="text-[0.9375rem] font-medium text-muted-foreground">
                  {t('gripper:aperture.unknown')}
                </span>
              ) : (
                <>
                  {state.positionMm.toFixed(1)}
                  <span className="ml-0.5 text-[0.6875rem] font-medium text-muted-foreground">mm</span>
                </>
              )}
            </div>
          </div>
          <Slider
            id="gripper-aperture" data-testid="gripper-aperture"
            aria-label={t('gripper:aperture.title')}
            value={[vm.aperture]}
            max={vm.travelMm}
            disabled={!vm.canControl}
            onValueChange={([v]) => {
              vm.setDragging(true)
              vm.setAperture(v)
            }}
            onValueCommit={([v]) => {
              vm.setDragging(false)
              vm.commitAperture(v)
            }}
          />
          <div className="flex justify-between font-mono text-[0.625rem] text-muted-foreground/70">
            <div>{t('gripper:aperture.closed')}</div>
            <div>{t('gripper:aperture.open', { max: vm.travelMm.toFixed(0) })}</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              id="gripper-open" data-testid="gripper-open"
              variant="outline"
              className="h-[2.375rem] flex-1 gap-1.5 rounded-lg text-[0.84375rem] font-semibold"
              disabled={!vm.canDirection}
              onClick={vm.open}
            >
              <Maximize2 size="0.8125rem" /> {t('gripper:actions.open')}
            </Button>
            <Button
              id="gripper-close" data-testid="gripper-close"
              className="h-[2.375rem] flex-1 gap-1.5 rounded-lg text-[0.84375rem] font-semibold"
              disabled={!vm.canDirection}
              onClick={vm.close}
            >
              <Minimize2 size="0.8125rem" /> {t('gripper:actions.close')}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              id="gripper-grasp" data-testid="gripper-grasp"
              variant="outline"
              className="h-[2.375rem] flex-1 rounded-lg text-[0.84375rem] font-semibold"
              disabled={!vm.canControl}
              onClick={vm.grasp}
            >
              {t('gripper:actions.grasp')}
            </Button>
            <Button
              id="gripper-release" data-testid="gripper-release"
              variant="outline"
              className="h-[2.375rem] flex-1 rounded-lg text-[0.84375rem] font-semibold"
              disabled={!vm.connected || !vm.enabled}
              onClick={vm.release}
            >
              {t('gripper:actions.release')}
            </Button>
          </div>
        </Card>

        {/* 夹爪参数 */}
        <Card className="flex flex-col gap-3 rounded-[0.875rem] p-5">
          <div className="flex items-center gap-1.5 text-[0.71875rem] font-semibold text-ink-muted">
            <Wrench size="0.8125rem" />
            {t('gripper:params.title')}
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <span className="text-[0.8125rem] font-medium text-ink-strong">{t('gripper:params.targetForce')}</span>
              <span id="gripper-force-value" data-testid="gripper-force-value" className="font-mono text-[0.875rem] font-semibold text-foreground">
                {vm.forceN} N
              </span>
            </div>
            <Slider
              id="gripper-force-slider" data-testid="gripper-force-slider"
              aria-label={t('gripper:params.targetForce')}
              value={[vm.forceN]}
              min={0}
              max={FORCE_MAX_N}
              disabled={!vm.connected}
              onValueChange={([v]) => vm.setForceN(v)}
              onValueCommit={([v]) => vm.commitForce(v)}
            />
            <div className="flex justify-between font-mono text-[0.625rem] text-muted-foreground/70">
              <div>0 N</div>
              <div>{FORCE_MAX_N} N</div>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <span className="text-[0.8125rem] font-medium text-ink-strong">{t('gripper:params.moveSpeed')}</span>
              <span id="gripper-speed-value" data-testid="gripper-speed-value" className="font-mono text-[0.875rem] font-semibold text-foreground">
                {vm.speedMmS} mm/s
              </span>
            </div>
            <Slider
              id="gripper-speed-slider" data-testid="gripper-speed-slider"
              aria-label={t('gripper:params.moveSpeed')}
              value={[vm.speedMmS]}
              min={SPEED_MIN_MM_S}
              max={SPEED_MAX_MM_S}
              disabled={!vm.connected}
              onValueChange={([v]) => vm.setSpeedMmS(v)}
              onValueCommit={([v]) => vm.commitSpeed(v)}
            />
            <div className="flex justify-between font-mono text-[0.625rem] text-muted-foreground/70">
              <div>{SPEED_MIN_MM_S} mm/s</div>
              <div>{SPEED_MAX_MM_S} mm/s</div>
            </div>
          </div>
        </Card>
      </div>

      {/* RIGHT: 急停、读数、标定 */}
      <div className="flex min-w-[20.5rem] flex-1 flex-col gap-3">
        <Card className="flex flex-col gap-2 rounded-[0.875rem] p-5">
          <div className="flex items-center gap-1.5 text-[0.71875rem] font-semibold text-ink-muted">
            <ShieldAlert size="0.8125rem" />
            {t('common:stop')}
          </div>
          <div className="flex gap-2">
            <Button
              id="gripper-stop" data-testid="gripper-stop"
              variant="destructive"
              className="h-[2.375rem] flex-1 rounded-lg text-[0.875rem] font-bold"
              disabled={!vm.present}
              onClick={vm.stop}
            >
              {t('gripper:actions.stop')}
            </Button>
            <Button
              id="gripper-reset-stop" data-testid="gripper-reset-stop"
              variant="outline"
              className="h-[2.375rem] flex-1 rounded-lg text-[0.84375rem] font-semibold"
              disabled={!vm.present || !vm.estopped}
              onClick={vm.resetStop}
            >
              {t('gripper:actions.resetStop')}
            </Button>
            <Button
              id="gripper-clear-fault" data-testid="gripper-clear-fault"
              variant="outline"
              className="h-[2.375rem] flex-1 rounded-lg text-[0.84375rem] font-semibold"
              disabled={!vm.connected}
              onClick={vm.clearFault}
            >
              {t('gripper:actions.clearFault')}
            </Button>
          </div>
        </Card>

        <Card className="flex flex-col gap-3 rounded-[0.875rem] p-5">
          <div className="flex items-center gap-1.5 text-[0.71875rem] font-semibold text-ink-muted">
            <Gauge size="0.8125rem" />
            {t('gripper:readout.title')}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Stat
              label={t('gripper:readout.force')}
              value={state ? state.forceN.toFixed(2) : t('gripper:readout.unknown')}
              unit="N"
            />
            <Stat
              label={t('gripper:readout.torque')}
              value={state ? state.torqueNm.toFixed(2) : t('gripper:readout.unknown')}
              unit="Nm"
            />
            <Stat
              label={t('gripper:readout.velocity')}
              value={state ? state.velocityMmS.toFixed(1) : t('gripper:readout.unknown')}
              unit="mm/s"
            />
            <Stat label={t('gripper:readout.state')} value={vm.stateLabel} />
          </div>
          <div className="flex items-center gap-2 text-[0.71875rem] text-muted-foreground">
            <Thermometer size="0.8125rem" />
            <span
              id="gripper-temps"
              data-testid="gripper-temps"
              className="font-mono"
              title={t('gripper:readout.temperature')}
            >
              MOS {state?.temps.mosTemp ?? '—'} °C · COIL {state?.temps.coilTemp ?? '—'} °C
            </span>
          </div>
          {state && !state.fresh ? (
            <div className="text-[0.71875rem] text-warn">{t('gripper:readout.stale')}</div>
          ) : null}
          {state && state.errorCode !== 0 && state.errorCode !== 1 ? (
            <div className="text-[0.71875rem] text-destructive">
              {t('gripper:readout.errorCode')}: 0x{state.errorCode.toString(16).toUpperCase()}
            </div>
          ) : null}
          {vm.calib && vm.calib.phase !== 'done' && vm.calib.phase !== 'failed' ? (
            <div className="flex flex-col gap-1.5">
              <Progress value={Math.round(vm.calib.progress * 100)} />
              <div className="text-[0.6875rem] text-muted-foreground">{vm.calib.detail}</div>
            </div>
          ) : null}
        </Card>

        <CalibrationCard vm={vm} />
      </div>
    </div>
  )
}

export default GripperPage

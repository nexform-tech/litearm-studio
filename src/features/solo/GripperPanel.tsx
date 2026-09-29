import { useTranslation } from 'react-i18next'
import {
  Gauge,
  Grip,
  Maximize2,
  Minimize2,
  Power,
  RotateCcw,
  ShieldAlert,
  TriangleAlert,
  Wrench,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Slider } from '@/components/ui/slider'
import { useGripperPanel, FORCE_MAX_N, SPEED_MAX_MM_S, SPEED_MIN_MM_S } from '@/features/gripper/useGripperPanel'
import type { GripperPanelVm } from '@/features/gripper/useGripperPanel'
import type { CalibrationSource } from '@/lib/arm/gripperClient'

const SOURCE_KEYS: Record<CalibrationSource, string> = {
  measured: 'gripper:source.measured',
  template: 'gripper:source.template',
  factory: 'gripper:source.factory',
  missing: 'gripper:source.missing',
}

const WARNING_KEYS: Record<string, string> = {
  template: 'gripper:source.templateWarning',
  factory: 'gripper:source.factoryWarning',
  missing: 'gripper:source.missingWarning',
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="truncate text-[0.625rem] font-medium text-muted-foreground">{label}</div>
      <div className="truncate font-mono text-[0.8125rem] leading-none font-bold text-foreground">
        {value}
        {unit ? <span className="ml-0.5 text-[0.59375rem] font-medium text-muted-foreground">{unit}</span> : null}
      </div>
    </div>
  )
}

function Param({
  id, label, value, unit, min, max, step, disabled, onChange, onCommit,
}: {
  id: string
  label: string
  value: number
  unit: string
  min: number
  max: number
  step: number
  disabled: boolean
  /** 拖动中只改本地值：每像素一条 `set_motion` 是白流量，而且会把回读值甩回去。 */
  onChange: (value: number) => void
  onCommit: (value: number) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-[4.5rem] flex-none text-[0.6875rem] font-medium text-ink-strong">{label}</span>
      <Slider
        id={`${id}-slider`}
        data-testid={`${id}-slider`}
        aria-label={label}
        className="min-w-0 flex-1"
        value={[value]}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onValueChange={([v]) => onChange(v)}
        onValueCommit={([v]) => onCommit(v)}
      />
      <span
        id={id}
        data-testid={id}
        className="w-[4.25rem] flex-none text-right font-mono text-[0.6875rem] font-semibold text-foreground"
      >
        {value} {unit}
      </span>
    </div>
  )
}

function sourceLabel(vm: GripperPanelVm, t: (key: string) => string): string {
  const source = vm.conn?.source
  return source ? t(SOURCE_KEYS[source]) : t('gripper:source.none')
}

/** 装配方向没有"未声明"态：daemon 永远给一个方向（默认正装）。 */
function mountLabel(vm: GripperPanelVm, t: (key: string) => string): string {
  const mount = vm.conn?.mount
  if (!mount) return '—'
  return t(`gripper:connection.mount${mount === 'reverse' ? 'Reverse' : 'Normal'}`)
}

/**
 * 控制页右列的夹爪组件（§6.2）：老版本 `EndEffectorControlPanel` 的形态 ——
 * 急停正下方一块卡片，只放操作夹爪要用的东西。
 *
 * 配置（通道、CAN ID、装配方向、标定文件、实测行程）不在这里，在设置页的
 * `GripperSection`；两处共用同一个 `gripperClient`，挂载在这一页之外的任何页面
 * 都会看到同一份连接。
 *
 * ⚠ 一次只能挂一个消费方：`useGripperAlerts()` 每次挂载都订阅一遍 `gripper_alert`，
 * 同时挂两处会让每条告警弹两次。
 */
export function GripperPanel() {
  const { t } = useTranslation(['common', 'gripper'])
  const vm = useGripperPanel()
  const state = vm.state

  const statusTone = vm.connected ? 'success' : vm.status === 'error' ? 'destructive' : 'outline'
  const gateKey = (vm.gate ?? 'BLOCKED') as 'READY' | 'TEMPLATE' | 'FACTORY' | 'BLOCKED'
  const source = vm.conn?.source ?? null
  const warning = source ? WARNING_KEYS[source] : undefined
  const busyText = vm.busy.busy ? vm.busy.what || t('gripper:busy.label') : ''
  const probing = vm.calib != null && vm.calib.phase !== 'done' && vm.calib.phase !== 'failed'
  const positionText = state?.positionMm == null ? t('gripper:aperture.unknown') : state.positionMm.toFixed(1)

  return (
    <Card
      id="gripper-panel"
      data-testid="gripper-panel"
      className="flex flex-none flex-col gap-3 rounded-[0.875rem] p-4"
    >
      {/* 标题：状态徽标 + 闸门徽标，两行以内说清"能不能动" */}
      <div className="flex items-start gap-2.5">
        <div className="flex size-7 flex-none items-center justify-center rounded-lg bg-chip text-chip-fg">
          <Grip size="0.875rem" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[0.875rem] leading-tight font-semibold text-foreground">
            {t('gripper:page.title')}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <Badge
              id="gripper-status"
              data-testid="gripper-status"
              variant={statusTone}
              className="h-auto rounded-full px-2 py-0.5 text-[0.65625rem] font-semibold"
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
            <Badge
              id="gripper-gate"
              data-testid="gripper-gate"
              variant={gateKey === 'READY' ? 'success' : gateKey === 'BLOCKED' ? 'destructive' : 'outline'}
              className={`h-auto rounded-full px-2 py-0.5 text-[0.65625rem] font-semibold ${
                gateKey === 'READY' ? '' : 'border-warn-line bg-warn-soft text-warn'
              }`}
            >
              {t(`gripper:gate.${gateKey}`)}
            </Badge>
          </div>
        </div>
      </div>

      {/* 连接与使能 */}
      <div className="flex flex-wrap gap-1.5">
        <Button
          id="gripper-connect"
          data-testid="gripper-connect"
          size="sm"
          disabled={!vm.present || vm.connected || vm.status === 'connecting'}
          title={t('gripper:connection.connectHint')}
          onClick={() => vm.connect()}
        >
          {t('nav:connect')}
        </Button>
        <Button
          id="gripper-disconnect"
          data-testid="gripper-disconnect"
          size="sm"
          variant="outline"
          disabled={!vm.present || vm.status === 'disconnected'}
          onClick={() => vm.disconnect()}
        >
          {t('common:disconnect')}
        </Button>
        <div className="flex-1" />
        <Button
          id="gripper-enable"
          data-testid="gripper-enable"
          size="sm"
          variant="outline"
          disabled={!vm.connected || vm.enabled || vm.estopped}
          onClick={vm.enable}
        >
          <Power size="0.8125rem" /> {t('gripper:actions.enable')}
        </Button>
        <Button
          id="gripper-disable"
          data-testid="gripper-disable"
          size="sm"
          variant="outline"
          disabled={!vm.connected || !vm.enabled}
          onClick={vm.disable}
        >
          {t('gripper:actions.disable')}
        </Button>
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[0.625rem] text-muted-foreground">
        <span>
          {t('gripper:connection.channel')}: {vm.conn?.channel || '—'}
        </span>
        <span>
          {t('gripper:connection.canId')}:{' '}
          {vm.conn ? `0x${vm.conn.canId.toString(16).toUpperCase().padStart(2, '0')}` : '—'}
        </span>
        <span>
          {t('gripper:connection.mount')}: {mountLabel(vm, t)}
        </span>
      </div>

      {/* 为什么按不动：组件必须说出原因，而不是只灰掉（§6.3）。
          没有夹爪会话时不出这一块 —— daemon 侧根本没有夹爪的构建（Windows、
          `--no-gripper`）不需要在控制页反复解释，状态徽标已经说了"离线"。 */}
      {vm.disabledReason ? (
        <div
          id="gripper-disabled-reason"
          data-testid="gripper-disabled-reason"
          className="rounded-lg border border-warn-line bg-warn-soft px-2.5 py-1.5 text-[0.6875rem] leading-relaxed text-warn"
        >
          {vm.disabledReason}
        </div>
      ) : null}

      {/* 位置：主控制 */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[0.75rem] font-semibold text-ink">{t('gripper:aperture.title')}</span>
        <span
          id="gripper-position"
          data-testid="gripper-position"
          className="font-mono text-[1.125rem] leading-none font-bold text-foreground"
        >
          {positionText}
          <span className="ml-0.5 text-[0.625rem] font-medium text-muted-foreground">mm</span>
        </span>
      </div>
      <Slider
        id="gripper-aperture"
        data-testid="gripper-aperture"
        aria-label={t('gripper:aperture.title')}
        value={[vm.aperture]}
        max={vm.travelMm}
        disabled={!vm.canControl}
        onValueChange={([v]) => {
          // 拖动中只改本地值；"正在拖动"由指针事件决定（见下），不由值变化推断。
          // ⚠ 键盘步进时 Radix 先发 onValueCommit 再发 onValueChange（实测），
          // 所以这里既不能 setDragging(true) 也不能靠调用顺序来判断拖动结束。
          vm.setAperture(v)
        }}
        onValueCommit={([v]) => vm.commitAperture(v)}
        onPointerDown={() => vm.setDragging(true)}
        onPointerUp={() => vm.setDragging(false)}
        onPointerCancel={() => vm.setDragging(false)}
      />
      <div className="flex justify-between font-mono text-[0.59375rem] text-muted-foreground/70">
        <div>0</div>
        <div>{t('gripper:aperture.open', { max: vm.travelMm.toFixed(0) })}</div>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <Button
          id="gripper-open"
          data-testid="gripper-open"
          variant="outline"
          className="h-[2.125rem] gap-1.5 rounded-lg text-[0.78125rem] font-semibold"
          disabled={!vm.canDirection}
          onClick={vm.open}
        >
          <Maximize2 size="0.8125rem" /> {t('gripper:actions.open')}
        </Button>
        <Button
          id="gripper-close"
          data-testid="gripper-close"
          className="h-[2.125rem] gap-1.5 rounded-lg text-[0.78125rem] font-semibold"
          disabled={!vm.canDirection}
          onClick={vm.close}
        >
          <Minimize2 size="0.8125rem" /> {t('gripper:actions.close')}
        </Button>
        <Button
          id="gripper-grasp"
          data-testid="gripper-grasp"
          variant="outline"
          className="h-[2.125rem] rounded-lg text-[0.78125rem] font-semibold"
          disabled={!vm.canControl}
          onClick={vm.grasp}
        >
          {t('gripper:actions.grasp')}
        </Button>
        <Button
          id="gripper-release"
          data-testid="gripper-release"
          variant="outline"
          className="h-[2.125rem] rounded-lg text-[0.78125rem] font-semibold"
          disabled={!vm.connected || !vm.enabled}
          onClick={vm.release}
        >
          {t('gripper:actions.release')}
        </Button>
      </div>

      {/* 参数：默认收起 —— 它们是"调一次"的，操作要按的是上面那四个按钮 */}
      <details className="border-t border-line pt-2.5">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[0.6875rem] font-semibold text-ink-muted">
          <Wrench size="0.75rem" />
          {t('gripper:params.title')}
          <span className="ml-auto font-mono font-normal text-muted-foreground">
            {vm.forceN} N · {vm.speedMmS} mm/s
          </span>
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          <Param
            id="gripper-force-value"
            label={t('gripper:params.targetForce')}
            value={vm.forceN}
            unit="N"
            min={0}
            max={FORCE_MAX_N}
            step={1}
            disabled={!vm.connected}
            onChange={vm.setForceN}
            onCommit={vm.commitForce}
          />
          <Param
            id="gripper-speed-value"
            label={t('gripper:params.moveSpeed')}
            value={vm.speedMmS}
            unit="mm/s"
            min={SPEED_MIN_MM_S}
            max={SPEED_MAX_MM_S}
            step={1}
            disabled={!vm.connected}
            onChange={vm.setSpeedMmS}
            onCommit={vm.commitSpeed}
          />
        </div>
      </details>

      {/* 急停：始终可达，移动中也不排队（§6.3） */}
      <div className="flex gap-1.5">
        <Button
          id="gripper-stop"
          data-testid="gripper-stop"
          variant="destructive"
          className="h-[2.125rem] flex-1 gap-1.5 rounded-lg text-[0.78125rem] font-bold"
          disabled={!vm.present}
          title={t('gripper:actions.stop')}
          onClick={vm.stop}
        >
          <ShieldAlert size="0.8125rem" /> {t('gripper:actions.stop')}
        </Button>
        <Button
          id="gripper-reset-stop"
          data-testid="gripper-reset-stop"
          variant="outline"
          className="h-[2.125rem] gap-1.5 rounded-lg text-[0.75rem] font-semibold"
          disabled={!vm.present || !vm.estopped}
          onClick={vm.resetStop}
        >
          <RotateCcw size="0.75rem" /> {t('gripper:actions.resetStop')}
        </Button>
        <Button
          id="gripper-clear-fault"
          data-testid="gripper-clear-fault"
          variant="outline"
          className="h-[2.125rem] gap-1.5 rounded-lg text-[0.75rem] font-semibold"
          disabled={!vm.connected}
          onClick={vm.clearFault}
        >
          <TriangleAlert size="0.75rem" /> {t('gripper:actions.clearFault')}
        </Button>
      </div>

      {busyText ? (
        <div id="gripper-busy" data-testid="gripper-busy" className="text-[0.6875rem] text-muted-foreground">
          {busyText}
        </div>
      ) : null}

      {probing && vm.calib ? (
        <div className="flex flex-col gap-1.5">
          <Progress value={Math.round(vm.calib.progress * 100)} />
          <div className="text-[0.625rem] text-muted-foreground">{vm.calib.detail}</div>
        </div>
      ) : null}

      {/* 读数 */}
      <div className="grid grid-cols-4 gap-2 border-t border-line pt-2.5">
        <Stat label={t('gripper:readout.force')} value={state ? state.forceN.toFixed(2) : '--'} unit="N" />
        <Stat label={t('gripper:readout.torque')} value={state ? state.torqueNm.toFixed(2) : '--'} unit="Nm" />
        <Stat label={t('gripper:readout.velocity')} value={state ? state.velocityMmS.toFixed(1) : '--'} unit="mm/s" />
        <Stat label={t('gripper:readout.state')} value={vm.stateLabel} />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.625rem] text-muted-foreground">
        <span className="flex items-center gap-1">
          <Gauge size="0.6875rem" />
          <span
            id="gripper-temps"
            data-testid="gripper-temps"
            className="font-mono"
            title={t('gripper:readout.temperature')}
          >
            MOS {state?.temps.mosTemp ?? '—'} °C · COIL {state?.temps.coilTemp ?? '—'} °C
          </span>
        </span>
        {state && !state.fresh ? <span className="text-warn">{t('gripper:readout.stale')}</span> : null}
        {state && state.errorCode !== 0 && state.errorCode !== 1 ? (
          <span className="text-destructive">
            {t('gripper:readout.errorCode')}: 0x{state.errorCode.toString(16).toUpperCase()}
          </span>
        ) : null}
        {vm.conn?.error ? (
          <span className="truncate text-destructive" title={vm.conn.error}>
            {vm.conn.error}
          </span>
        ) : null}
      </div>

      {/* 标定：来源与两个端点角始终在 DOM 里，折叠的是**显示**而不是数据（§6.3） */}
      <details className="group border-t border-line pt-2.5">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[0.6875rem] font-semibold text-ink-muted">
          <Gauge size="0.75rem" />
          {t('gripper:source.label')}
          <span className="font-normal text-muted-foreground">·</span>
          <span id="gripper-source" data-testid="gripper-source" className="truncate font-normal text-muted-foreground">
            {sourceLabel(vm, t)}
          </span>
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          {warning ? (
            <div className="rounded-lg border border-warn-line bg-warn-soft px-2.5 py-1.5 text-[0.65625rem] leading-relaxed text-warn">
              {t(warning)}
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <Stat
              label={`${t('gripper:source.closed')} (rad)`}
              value={vm.conn?.closedRad == null ? '—' : vm.conn.closedRad.toFixed(4)}
            />
            <Stat
              label={`${t('gripper:source.open')} (rad)`}
              value={vm.conn?.openRad == null ? '—' : vm.conn.openRad.toFixed(4)}
            />
            <Stat label={`${t('gripper:connection.travel')} (mm)`} value={vm.travelMm.toFixed(1)} />
            <Stat
              label={t('gripper:connection.mount')}
              value={mountLabel(vm, t)}
            />
          </div>
          {vm.mountMismatch ? (
            <div className="text-[0.65625rem] leading-relaxed text-warn">
              {t('gripper:connection.mountMismatch', {
                declared: t(
                  `gripper:connection.mount${vm.conn?.declaredMount === 'reverse' ? 'Reverse' : 'Normal'}`,
                ),
                actual: t(`gripper:connection.mount${vm.conn?.mount === 'reverse' ? 'Reverse' : 'Normal'}`),
              })}
            </div>
          ) : null}
          {vm.conn?.path ? (
            <div className="truncate font-mono text-[0.59375rem] text-muted-foreground" title={vm.conn.path}>
              {vm.conn.path}
            </div>
          ) : null}
          <div className="text-[0.65625rem] leading-relaxed text-muted-foreground">
            {t(`gripper:gate.${gateKey}_why`)}
          </div>
        </div>
      </details>
    </Card>
  )
}

export default GripperPanel

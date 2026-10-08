import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import {
  Feather,
  Gauge,
  Grab,
  Maximize2,
  Minimize2,
  Power,
  RotateCcw,
  ShieldAlert,
  SlidersHorizontal,
  Thermometer,
  TriangleAlert,
  Wrench,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { useGripperPanel, FORCE_MAX_N, SPEED_MAX_MM_S, SPEED_MIN_MM_S } from '@/features/gripper/useGripperPanel'
import type { GripperPanelVm } from '@/features/gripper/useGripperPanel'
import { useGripperChannels } from '@/lib/arm/useGripper'
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

function sourceLabel(vm: GripperPanelVm, t: (key: string) => string): string {
  const source = vm.conn?.source
  return source ? t(SOURCE_KEYS[source]) : t('gripper:source.none')
}

function mountLabel(vm: GripperPanelVm, t: (key: string) => string): string {
  const mount = vm.conn?.mount
  if (!mount) return '—'
  return t(`gripper:connection.mount${mount === 'reverse' ? 'Reverse' : 'Normal'}`)
}

function connectionLine(vm: GripperPanelVm, t: (key: string) => string): string {
  const channel = vm.conn?.channel || '—'
  const canId = vm.conn ? `0x${vm.conn.canId.toString(16).toUpperCase().padStart(2, '0')}` : '—'
  return `${t('gripper:connection.channel')} ${channel} · ${t('gripper:connection.canId')} ${canId}`
}

/**
 * 控制页右列的夹爪组件（§6.2）：急停正下方一整块卡片，占满右列剩余高度。
 *
 * 配置（CAN ID、装配方向、标定文件、实测行程）不在这里，在设置页的 `GripperSection`；
 * 两处共用同一个 `gripperClient`，挂载在这一页之外的任何页面都会看到同一份连接。
 *
 * ⚠ **例外是 CAN 通道**：它也在这里选。操作员是在这一页连接并驱动夹爪的，为了换一条
 * CAN 线跑回设置页、改完再回来重连，是这一页最没必要的一次往返（§5.4 的"通道可枚举"
 * 本来就是给这里用的）。两处用的是同一个命令（`gripper.list_channels`），改一处另一处
 * 会跟着变 —— 因为通道存在 daemon 的配置里，不是各自的界面状态。
 *
 * ⚠ 一次只能挂一个消费方：`useGripperAlerts()` 每次挂载都订阅一遍 `gripper_alert`，
 * 同时挂两处会让每条告警弹两次。
 */
export function GripperPanel() {
  const { t } = useTranslation(['common', 'gripper', 'nav'])
  const vm = useGripperPanel()
  const state = vm.state
  // ⚠ 通道选在这里, 是因为操作员在**这一页**驱动夹爪: 为了换一条 CAN 线跑回设置页,
  //   再回来重连, 是这一页最没必要的往返 (§6.2 的配置留在设置页, 但连接目标不在此列)。
  const { channels } = useGripperChannels()
  const [picked, setPicked] = useState('')

  // 操作员选过的 → 引擎当前用的 → 枚举到的第一个。最后那个是"还没连过任何一次"时的
  // 合理默认, 与 daemon 侧的默认通道同源 (`store.lastChannel` / `constants.CAN_CHANNEL`)。
  const channel = picked || vm.conn?.channel || channels[0] || ''
  const channelOptions = Array.from(
    new Set([channel, vm.conn?.channel, ...channels].filter((c): c is string => !!c)),
  )

  const statusTone = vm.connected ? 'success' : vm.status === 'error' ? 'destructive' : 'outline'
  const gateKey = (vm.gate ?? 'BLOCKED') as 'READY' | 'TEMPLATE' | 'FACTORY' | 'BLOCKED'
  const source = vm.conn?.source ?? null
  const warning = source ? WARNING_KEYS[source] : undefined
  const busyText = vm.busy.busy ? vm.busy.what || t('gripper:busy.label') : ''
  const probing = vm.calib != null && vm.calib.phase !== 'done' && vm.calib.phase !== 'failed'
  const positionText = state?.positionMm == null ? t('gripper:aperture.unknown') : state.positionMm.toFixed(1)

  return (
    /* 撑满右列剩余高度：卡片吃掉余量，多出来的空间由 `justify-between` 均分到
       各段之间（和关节面板把余量分给各行是同一个思路）—— 摊在一处就成了空洞。
       段内间距仍是固定值，所以窗口变高时是整块变松，而不是某一行被拉长。 */
    <Card
      id="gripper-panel"
      data-testid="gripper-panel"
      className="flex flex-1 flex-col justify-between gap-3 rounded-[0.875rem] border border-line bg-card p-3.5 shadow-sm"
    >
      {/* ── 顶部标题与通讯状态 ─────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2.5">
        <div className="flex items-center gap-2">
          <div className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Grab size="0.875rem" />
          </div>
          <div className="text-[0.875rem] font-bold text-foreground">
            {t('gripper:page.title')}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Badge
            id="gripper-status"
            data-testid="gripper-status"
            variant={statusTone}
            className="h-auto rounded-full px-2 py-0.5 text-[0.625rem] font-semibold"
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
            className={`h-auto rounded-full px-2 py-0.5 text-[0.625rem] font-semibold ${
              gateKey === 'READY' ? '' : 'border-warn-line bg-warn-soft text-warn'
            }`}
          >
            {t(`gripper:gate.${gateKey}`)}
          </Badge>
        </div>
      </div>

      {/* CAN 通道: 就在这里换线, 不必回设置页。
          ⚠ 连着的时候锁住 —— daemon 会拒"先断开再改通道/ID"之外的一切改法
          (`GripperSession._cmd_connect`), 在这里放开只会让操作员撞一条拒绝。 */}
      <div className="flex items-center gap-2">
        <span className="flex-none text-[0.6875rem] font-medium text-ink-muted">
          {t('gripper:connection.channel')}
        </span>
        <Select
          value={channel}
          onValueChange={setPicked}
          disabled={!vm.present || vm.connected || vm.status === 'connecting'}
        >
          <SelectTrigger
            id="gripper-panel-channel"
            data-testid="gripper-panel-channel"
            aria-label={t('gripper:connection.channel')}
            title={vm.connected ? t('gripper:settings.needsDisconnect') : t('gripper:connection.connectHint')}
            className="h-7.5 min-w-0 flex-1 rounded-md font-mono text-[0.71875rem]"
          >
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            {channelOptions.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* ── 通讯与使能动作行 ─────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2">
        <div className="flex rounded-lg border border-line bg-background p-0.5 shadow-xs">
          <Button
            id="gripper-connect"
            data-testid="gripper-connect"
            size="sm"
            variant={vm.connected ? 'ghost' : 'default'}
            className="h-7.5 flex-1 rounded-md px-2 text-[0.71875rem] font-medium"
            disabled={!vm.present || vm.connected || vm.status === 'connecting'}
            title={t('gripper:connection.connectHint')}
            onClick={() => vm.connect(channel ? { channel } : {})}
          >
            {t('nav:connect')}
          </Button>
          <Button
            id="gripper-disconnect"
            data-testid="gripper-disconnect"
            size="sm"
            variant="ghost"
            className="h-7.5 flex-1 rounded-md px-2 text-[0.71875rem] font-medium text-muted-foreground hover:text-foreground"
            disabled={!vm.present || vm.status === 'disconnected'}
            onClick={() => vm.disconnect()}
          >
            {t('common:disconnect')}
          </Button>
        </div>

        <div className="flex rounded-lg border border-line bg-background p-0.5 shadow-xs">
          <Button
            id="gripper-enable"
            data-testid="gripper-enable"
            size="sm"
            variant={vm.enabled ? 'default' : 'ghost'}
            className="h-7.5 flex-1 rounded-md px-2 text-[0.71875rem] font-medium"
            disabled={!vm.connected || vm.enabled || vm.estopped}
            onClick={vm.enable}
          >
            <Power size="0.6875rem" />
            {t('gripper:actions.enable')}
          </Button>
          <Button
            id="gripper-disable"
            data-testid="gripper-disable"
            size="sm"
            variant="ghost"
            className="h-7.5 flex-1 rounded-md px-2 text-[0.71875rem] font-medium text-muted-foreground hover:text-foreground"
            disabled={!vm.connected || !vm.enabled}
            onClick={vm.disable}
          >
            {t('gripper:actions.disable')}
          </Button>
        </div>
      </div>

      {/* 禁用原因提示 */}
      {vm.disabledReason ? (
        <div
          id="gripper-disabled-reason"
          data-testid="gripper-disabled-reason"
          className="flex items-center gap-1.5 rounded-lg border border-warn-line bg-warn-soft px-2.5 py-1.5 text-[0.65625rem] leading-snug text-warn"
        >
          <TriangleAlert size="0.75rem" className="flex-none" />
          <span className="truncate">{vm.disabledReason}</span>
        </div>
      ) : null}

      {/* 开度位置主控区 */}
      <div className="flex flex-col gap-2 rounded-xl border border-line/80 bg-background p-2.5 shadow-xs">
        <div className="flex items-baseline justify-between">
          <div className="flex items-center gap-1.5 text-[0.75rem] font-semibold text-ink-strong">
            <SlidersHorizontal size="0.75rem" className="text-muted-foreground" />
            <span>{t('gripper:aperture.title')}</span>
          </div>
          <div className="flex items-baseline">
            <span
              id="gripper-position"
              data-testid="gripper-position"
              className="font-mono text-[1.5rem] leading-none font-extrabold tracking-tight text-foreground"
            >
              {positionText}
            </span>
            <span className="ml-1 text-[0.6875rem] font-medium text-muted-foreground">mm</span>
          </div>
        </div>

        <Slider
          id="gripper-aperture"
          data-testid="gripper-aperture"
          aria-label={t('gripper:aperture.title')}
          value={[vm.aperture]}
          max={vm.travelMm}
          disabled={!vm.canControl}
          onValueChange={([v]) => vm.setAperture(v)}
          onValueCommit={([v]) => vm.commitAperture(v)}
          onPointerDown={() => vm.setDragging(true)}
          onPointerUp={() => vm.setDragging(false)}
          onPointerCancel={() => vm.setDragging(false)}
        />

        <div className="flex items-center justify-between gap-2 text-[0.625rem]">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={!vm.canControl}
              onClick={() => {
                vm.setAperture(0)
                vm.commitAperture(0)
              }}
              className="cursor-pointer rounded border border-line bg-muted/40 px-2 py-0.5 font-mono text-[0.59375rem] font-medium text-ink-muted transition-colors hover:bg-muted disabled:opacity-40"
            >
              0%
            </button>
            <button
              type="button"
              disabled={!vm.canControl}
              onClick={() => {
                const half = Math.round(vm.travelMm / 2)
                vm.setAperture(half)
                vm.commitAperture(half)
              }}
              className="cursor-pointer rounded border border-line bg-muted/40 px-2 py-0.5 font-mono text-[0.59375rem] font-medium text-ink-muted transition-colors hover:bg-muted disabled:opacity-40"
            >
              50%
            </button>
            <button
              type="button"
              disabled={!vm.canControl}
              onClick={() => {
                vm.setAperture(vm.travelMm)
                vm.commitAperture(vm.travelMm)
              }}
              className="cursor-pointer rounded border border-line bg-muted/40 px-2 py-0.5 font-mono text-[0.59375rem] font-medium text-ink-muted transition-colors hover:bg-muted disabled:opacity-40"
            >
              100%
            </button>
          </div>
          <span className="font-mono text-muted-foreground">
            {t('gripper:aperture.open', { max: vm.travelMm.toFixed(0) })}
          </span>
        </div>
      </div>

      {/* 四大物理动作矩阵 */}
      <div className="grid grid-cols-2 gap-2">
        <Button
          id="gripper-open"
          data-testid="gripper-open"
          variant="outline"
          className="h-9 gap-1.5 rounded-lg border-line bg-background text-[0.75rem] font-semibold text-ink-strong shadow-xs transition-all hover:border-line-strong hover:bg-muted/30"
          disabled={!vm.canDirection}
          onClick={vm.open}
        >
          <Maximize2 size="0.75rem" />
          {t('gripper:actions.open')}
        </Button>
        <Button
          id="gripper-close"
          data-testid="gripper-close"
          variant="outline"
          className="h-9 gap-1.5 rounded-lg border-line bg-background text-[0.75rem] font-semibold text-ink-strong shadow-xs transition-all hover:border-line-strong hover:bg-muted/30"
          disabled={!vm.canDirection}
          onClick={vm.close}
        >
          <Minimize2 size="0.75rem" />
          {t('gripper:actions.close')}
        </Button>
        <Button
          id="gripper-grasp"
          data-testid="gripper-grasp"
          variant="outline"
          className="h-9 gap-1.5 rounded-lg border-line bg-background text-[0.75rem] font-semibold text-ink-strong shadow-xs transition-all hover:border-line-strong hover:bg-muted/30"
          disabled={!vm.canControl}
          onClick={vm.grasp}
        >
          <Grab size="0.75rem" />
          {t('gripper:actions.grasp')}
        </Button>
        <Button
          id="gripper-release"
          data-testid="gripper-release"
          variant="outline"
          className="h-9 gap-1.5 rounded-lg border-line bg-background text-[0.75rem] font-semibold text-ink-strong shadow-xs transition-all hover:border-line-strong hover:bg-muted/30"
          disabled={!vm.connected || !vm.enabled}
          onClick={vm.release}
        >
          <Feather size="0.75rem" />
          {t('gripper:actions.release')}
        </Button>
      </div>

      {/* 安全与急停工具条 */}
      <div className="flex gap-2">
        <Button
          id="gripper-stop"
          data-testid="gripper-stop"
          variant="destructive"
          className="h-8.5 flex-1 gap-1.5 rounded-lg text-[0.75rem] font-bold shadow-xs"
          disabled={!vm.present}
          title={t('gripper:actions.stop')}
          onClick={vm.stop}
        >
          <ShieldAlert size="0.75rem" />
          {t('gripper:actions.stop')}
        </Button>
        <Button
          id="gripper-reset-stop"
          data-testid="gripper-reset-stop"
          variant="outline"
          className="h-8.5 gap-1 rounded-lg px-2.5 text-[0.71875rem] font-medium"
          disabled={!vm.present || !vm.estopped}
          onClick={vm.resetStop}
        >
          <RotateCcw size="0.6875rem" />
          {t('gripper:actions.resetStop')}
        </Button>
        <Button
          id="gripper-clear-fault"
          data-testid="gripper-clear-fault"
          variant="outline"
          className="h-8.5 gap-1 rounded-lg px-2.5 text-[0.71875rem] font-medium"
          disabled={!vm.connected}
          onClick={vm.clearFault}
        >
          <TriangleAlert size="0.6875rem" />
          {t('gripper:actions.clearFault')}
        </Button>
      </div>

      {busyText ? (
        <div id="gripper-busy" data-testid="gripper-busy" className="flex items-center gap-1.5 text-[0.65625rem] text-muted-foreground">
          <div className="size-1.5 animate-ping rounded-full bg-primary" />
          <span>{busyText}</span>
        </div>
      ) : null}

      {probing && vm.calib ? (
        <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-muted/20 p-2">
          <Progress value={Math.round(vm.calib.progress * 100)} />
          <div className="text-[0.625rem] text-muted-foreground">{vm.calib.detail}</div>
        </div>
      ) : null}

      {/* 实时遥测指标与芯片温度 */}
      <div className="overflow-hidden rounded-lg border border-line bg-background shadow-xs">
        <div className="grid grid-cols-3 divide-x divide-line py-2.5">
          <div className="flex flex-col items-center justify-center px-1">
            <span className="text-[0.625rem] font-medium text-muted-foreground">{t('gripper:readout.force')}</span>
            <span className="font-mono text-[0.875rem] font-bold text-foreground">
              {state ? state.forceN.toFixed(2) : '--'}
              <span className="ml-0.5 text-[0.625rem] font-normal text-muted-foreground">N</span>
            </span>
          </div>
          <div className="flex flex-col items-center justify-center px-1">
            <span className="text-[0.625rem] font-medium text-muted-foreground">{t('gripper:readout.torque')}</span>
            <span className="font-mono text-[0.875rem] font-bold text-foreground">
              {state ? state.torqueNm.toFixed(2) : '--'}
              <span className="ml-0.5 text-[0.625rem] font-normal text-muted-foreground">Nm</span>
            </span>
          </div>
          <div className="flex flex-col items-center justify-center px-1">
            <span className="text-[0.625rem] font-medium text-muted-foreground">{t('gripper:readout.velocity')}</span>
            <span className="font-mono text-[0.875rem] font-bold text-foreground">
              {state ? state.velocityMmS.toFixed(1) : '--'}
              <span className="ml-0.5 text-[0.625rem] font-normal text-muted-foreground">mm/s</span>
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 border-t border-line/70 bg-muted/20 px-2.5 py-1.5 text-[0.625rem] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Thermometer size="0.6875rem" />
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
            <span className="text-destructive font-mono">
              {t('gripper:readout.errorCode')}: 0x{state.errorCode.toString(16).toUpperCase()}
            </span>
          ) : null}
          {vm.conn?.error ? (
            <span className="truncate text-destructive" title={vm.conn.error}>
              {vm.conn.error}
            </span>
          ) : null}
        </div>
      </div>

      {/* ── 配置与标定区 (Configuration & Diagnostics) ─────────
          参数与标定各是一组，中间一条细线；这个盒子本身不拉长 —— 多余的高度
          归卡片上的 `justify-between`，均匀分给各段之间，而不是摊在这里，
          让两段各自看着像没写完。 */}
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-muted/35 p-3">
        {/* 参数调节组 */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center text-xs font-semibold text-ink-strong">
            <span className="flex items-center gap-1.5">
              <Wrench size="0.8125rem" className="text-muted-foreground" />
              {t('gripper:params.title')}
            </span>
          </div>

          {/* 两行的数值列等宽：不然两根滑条的右端错开，看起来像没对齐。 */}
          <div className="flex flex-col gap-2 px-0.5">
            <div className="flex items-center gap-2.5">
              <span className="w-16 flex-none text-xs font-medium text-ink-muted">
                {t('gripper:params.targetForce')}
              </span>
              <Slider
                id="gripper-force-value-slider"
                data-testid="gripper-force-value-slider"
                aria-label={t('gripper:params.targetForce')}
                className="min-w-0 flex-1"
                value={[vm.forceN]}
                min={0}
                max={FORCE_MAX_N}
                step={1}
                disabled={!vm.connected}
                onValueChange={([v]) => vm.setForceN(v)}
                onValueCommit={([v]) => vm.commitForce(v)}
              />
              <span
                id="gripper-force-value"
                data-testid="gripper-force-value"
                className="w-[4.25rem] flex-none text-right font-mono text-xs font-bold text-foreground"
              >
                {vm.forceN} N
              </span>
            </div>

            <div className="flex items-center gap-2.5">
              <span className="w-16 flex-none text-xs font-medium text-ink-muted">
                {t('gripper:params.moveSpeed')}
              </span>
              <Slider
                id="gripper-speed-value-slider"
                data-testid="gripper-speed-value-slider"
                aria-label={t('gripper:params.moveSpeed')}
                className="min-w-0 flex-1"
                value={[vm.speedMmS]}
                min={SPEED_MIN_MM_S}
                max={SPEED_MAX_MM_S}
                step={1}
                disabled={!vm.connected}
                onValueChange={([v]) => vm.setSpeedMmS(v)}
                onValueCommit={([v]) => vm.commitSpeed(v)}
              />
              <span
                id="gripper-speed-value"
                data-testid="gripper-speed-value"
                className="w-[4.25rem] flex-none text-right font-mono text-xs font-bold text-foreground"
              >
                {vm.speedMmS} mm/s
              </span>
            </div>
          </div>
        </div>

        {/* 分隔细线 */}
        <div className="h-px bg-line/80" />

        {/* 标定与硬件信息组 */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs font-semibold text-ink-strong">
            <span className="flex items-center gap-1.5">
              <Gauge size="0.8125rem" className="text-muted-foreground" />
              {t('gripper:source.label')}
            </span>
            <span
              id="gripper-source"
              data-testid="gripper-source"
              className="truncate font-mono text-[0.6875rem] font-medium text-muted-foreground"
            >
              {sourceLabel(vm, t)}
            </span>
          </div>

          {warning ? (
            <div className="rounded-md border border-warn-line bg-warn-soft px-2.5 py-1.5 text-xs leading-relaxed text-warn">
              {t(warning)}
            </div>
          ) : null}

          {/* 规格列表 */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border border-line/60 bg-background/50 p-2 text-xs">
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">{t('gripper:source.closed')}</span>
              <span className="font-mono font-medium text-foreground">
                <span>{vm.conn?.closedRad == null ? '—' : vm.conn.closedRad.toFixed(4)}</span>
                {vm.conn?.closedRad != null ? <span className="ml-1 text-[0.6875rem] text-muted-foreground">rad</span> : null}
              </span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">{t('gripper:source.open')}</span>
              <span className="font-mono font-medium text-foreground">
                <span>{vm.conn?.openRad == null ? '—' : vm.conn.openRad.toFixed(4)}</span>
                {vm.conn?.openRad != null ? <span className="ml-1 text-[0.6875rem] text-muted-foreground">rad</span> : null}
              </span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">{t('gripper:connection.travel')}</span>
              <span className="font-mono font-medium text-foreground">
                <span>{vm.travelMm.toFixed(1)}</span>
                <span className="ml-1 text-[0.6875rem] text-muted-foreground">mm</span>
              </span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">{t('gripper:connection.mount')}</span>
              <span className="font-medium text-foreground">
                {mountLabel(vm, t)}
              </span>
            </div>
          </div>

          <div className="font-mono text-[0.6875rem] text-muted-foreground">
            {connectionLine(vm, t)}
          </div>

          {vm.mountMismatch ? (
            <div className="text-xs leading-relaxed text-warn">
              {t('gripper:connection.mountMismatch', {
                declared: t(
                  `gripper:connection.mount${vm.conn?.declaredMount === 'reverse' ? 'Reverse' : 'Normal'}`,
                ),
                actual: t(`gripper:connection.mount${vm.conn?.mount === 'reverse' ? 'Reverse' : 'Normal'}`),
              })}
            </div>
          ) : null}

          {vm.conn?.path ? (
            <div className="truncate font-mono text-[0.6875rem] text-muted-foreground" title={vm.conn.path}>
              {vm.conn.path}
            </div>
          ) : null}

          {gateKey === 'READY' ? null : (
            <div className="text-xs leading-relaxed text-muted-foreground">
              {t(`gripper:gate.${gateKey}_why`)}
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}

export default GripperPanel

import { useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, Cpu, RefreshCw, ShieldAlert, Upload } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { FIRMWARE_PHASE_KEYS, formatFirmwareReason } from '@/lib/arm'
import { useFirmwareUpgrade } from './useFirmwareUpgrade'

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[0.6875rem] font-medium text-muted-foreground">{label}</span>
      <span className="font-mono text-xs text-foreground">{children}</span>
    </div>
  )
}

function Notice({ children, tone }: { children: ReactNode; tone?: 'danger' }) {
  return (
    <p
      className={
        tone === 'danger'
          ? 'flex items-start gap-2 rounded-lg border border-line bg-muted/40 px-3 py-2 text-[0.71875rem] leading-relaxed text-danger'
          : 'rounded-lg border border-line bg-muted/40 px-3 py-2 text-[0.71875rem] leading-relaxed text-muted-foreground'
      }
    >
      {tone === 'danger' ? <ShieldAlert className="mt-0.5 size-3.5 flex-none" /> : null}
      <span>{children}</span>
    </p>
  )
}

function hex(n: number): string {
  return `0x${n.toString(16).toUpperCase().padStart(8, '0')}`
}

/**
 * 设置页里的「固件升级」段（路线 A 的最小可用版本）。
 *
 * 三步：**选镜像 → 看摘要并确认 → 开始**。每一步都有它必须存在的位置：
 *
 * - 摘要在**任何硬件动作之前**就要看到（这份镜像是什么版本、多大、会不会碰许可证扇区）；
 * - 确认框里那条"机械臂要有支撑"是硬要求 —— 升级会先失能，有重力负载的臂会下垂，
 *   而这是**界面无法验证**的一件事，只能让操作员确认；
 * - 进度条走广播帧，不是这几次命令的应答（见 `useFirmwareUpgrade`）。
 */
export function FirmwareSection() {
  const { t } = useTranslation(['common', 'settings'])
  const vm = useFirmwareUpgrade()
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [supported, setSupported] = useState(false)

  const running = vm.running
  const busy = vm.inspecting || vm.starting
  const canStart = vm.connected && vm.engineReady && vm.summary !== null
    && supported && !busy && !running

  const phaseLabel = vm.progress
    ? t(`settings:firmware.phase.${FIRMWARE_PHASE_KEYS[vm.progress.phase] ?? 'unknown'}`)
    : ''
  const percent = vm.progress && vm.progress.total > 0
    ? Math.min(100, Math.round((vm.progress.done / vm.progress.total) * 100))
    : null

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4 rounded-[0.875rem] p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-foreground">{t('settings:firmware.title')}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('settings:firmware.intro')}</p>
          </div>
          <Badge
            data-testid="firmware-engine"
            variant={vm.engineReady ? 'success' : 'destructive'}
            className="h-auto flex-none gap-1.5 rounded-full px-2.5 py-0.5 text-[0.71875rem] font-semibold"
          >
            <Cpu className="size-3" />
            {vm.engineReady ? t('common:ready') : t('common:statusOffline')}
          </Badge>
        </div>

        {vm.engine ? (
          <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
            {vm.engineReady
              ? t('settings:firmware.engineReady', { engine: vm.engine.label })
              : t('settings:firmware.engineMissing', { engine: vm.engine.label })}
            {vm.engineReady ? '' : ` ${t('settings:firmware.engineHint')}`}
          </p>
        ) : null}

        {!vm.connected ? (
          <div data-testid="firmware-offline">
            <Notice>{t('settings:firmware.notConnected')}</Notice>
          </div>
        ) : (
          <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
            {t('settings:firmware.connectedHint', {
              firmware: vm.firmware || '—',
              port: vm.port || '—',
            })}
          </p>
        )}

        {/* ---- 选文件 ---- */}
        <input
          ref={fileRef}
          data-testid="firmware-file-input"
          type="file"
          accept=".hex,.bin"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            // 清空 value：同一个文件选第二次也要能触发 change。
            e.target.value = ''
            if (f) void vm.pick(f)
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            data-testid="firmware-pick"
            size="sm"
            variant="outline"
            disabled={busy || running}
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="size-3.5" />
            {vm.summary ? t('settings:firmware.rePick') : t('settings:firmware.pick')}
          </Button>
          {vm.inspecting ? (
            <span className="text-[0.6875rem] text-muted-foreground">
              <RefreshCw className="mr-1 inline size-3 animate-spin" />
              {t('settings:firmware.reading')}
            </span>
          ) : null}
          {vm.summary ? (
            <span className="font-mono text-[0.6875rem] text-muted-foreground">
              {vm.summary.name}
            </span>
          ) : null}
        </div>

        {vm.error ? (
          <p
            data-testid="firmware-error"
            className="flex items-start gap-2 rounded-lg border border-line bg-muted/40 px-3 py-2 text-[0.71875rem] leading-relaxed text-danger"
          >
            <ShieldAlert className="mt-0.5 size-3.5 flex-none" />
            {vm.error}
          </p>
        ) : null}

        {/* ---- 镜像摘要 ---- */}
        {vm.summary ? (
          <div
            data-testid="firmware-summary"
            className="flex flex-col gap-3 rounded-lg border border-line bg-muted/30 p-3"
          >
            <div className="text-[0.6875rem] font-semibold text-foreground">
              {t('settings:firmware.imageTitle')}
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Field label={t('settings:firmware.imageVersion')}>
                <span data-testid="firmware-version">
                  {vm.summary.version
                    ?? t('settings:firmware.imageVersionUnknown', {
                      note: vm.summary.versionNote || '—',
                    })}
                </span>
              </Field>
              <Field label={t('settings:firmware.imageSize')}>
                {vm.summary.size} B
              </Field>
              <Field label={t('settings:firmware.imageRange')}>
                {hex(vm.summary.base)}..{hex(vm.summary.base + vm.summary.size - 1)}
              </Field>
              <Field label={t('settings:firmware.imageFormat')}>
                {vm.summary.format}
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-1 md:grid-cols-2">
              <Field label={t('settings:firmware.imageHoles')}>
                {t('settings:firmware.holesValue', { count: vm.summary.holes })}
              </Field>
              <Field label={t('settings:firmware.imageSha')}>
                <span className="break-all">{vm.summary.sha256.slice(0, 32)}…</span>
              </Field>
            </div>
          </div>
        ) : null}

        {/* ---- 确认 + 开始 ---- */}
        <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
          <div className="text-[0.6875rem] font-semibold text-foreground">
            {t('settings:firmware.safetyTitle')}
          </div>
          <p className="text-[0.71875rem] leading-relaxed text-muted-foreground">
            {t('settings:firmware.safetyStop')}
          </p>
          <p className="text-[0.71875rem] leading-relaxed text-muted-foreground">
            {t('settings:firmware.safetyKeep')}
          </p>
          {/* ⚠ 用**原生复选框**而不是 `Toggle`：这是一句"我确认……"的声明（与激活页的
              同意书同性质），复选框才是那个形状；`Toggle` 看起来像"切换某个开关"。
              样式沿用 `ActivationForm` 的同意书那一条，两处的确认读起来一致。 */}
          <label
            htmlFor="firmware-safety-arm"
            className="flex items-start gap-2 text-[0.71875rem] leading-relaxed"
          >
            <input
              id="firmware-safety-arm"
              data-testid="firmware-safety-arm"
              type="checkbox"
              checked={supported}
              disabled={running}
              onChange={(e) => setSupported(e.target.checked)}
              className="mt-0.5 size-3.5 flex-none accent-primary"
            />
            <span className="flex items-start gap-1.5 text-muted-foreground">
              <AlertTriangle className="mt-0.5 size-3.5 flex-none" />
              {t('settings:firmware.safetyArm')}
            </span>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            data-testid="firmware-start"
            size="sm"
            disabled={!canStart}
            onClick={() => void vm.start()}
          >
            {vm.starting ? t('settings:firmware.starting') : t('settings:firmware.start')}
          </Button>
          {running ? (
            <Button
              data-testid="firmware-cancel"
              size="sm"
              variant="outline"
              onClick={() => void vm.cancel()}
            >
              {t('settings:firmware.cancel')}
            </Button>
          ) : null}
          {vm.summary || vm.result ? (
            <Button
              data-testid="firmware-reset"
              size="sm"
              variant="ghost"
              disabled={running}
              onClick={vm.reset}
            >
              {t('common:reset')}
            </Button>
          ) : null}
        </div>

        {/* ---- 进度 ---- */}
        {vm.progress ? (
          <div data-testid="firmware-progress" className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-[0.71875rem]">
              <span className="font-semibold text-foreground">
                {t('settings:firmware.running')} · {phaseLabel}
              </span>
              {vm.progress.total > 0 ? (
                <span className="font-mono text-muted-foreground">
                  {t('settings:firmware.progressOf', {
                    done: vm.progress.done,
                    total: vm.progress.total,
                  })}
                </span>
              ) : null}
            </div>
            <Progress
              value={percent ?? 0}
              className={percent === null ? 'animate-pulse' : undefined}
            />
            <div className="min-h-4 font-mono text-[0.6875rem] text-muted-foreground">
              {vm.progress.detail}
            </div>
          </div>
        ) : null}

        {/* ---- 终局 ---- */}
        {vm.result ? (
          <div data-testid="firmware-result" className="flex flex-col gap-2">
            {vm.result.ok ? (
              <Notice>
                <span className="flex items-start gap-2 text-foreground">
                  <CheckCircle2 className="mt-0.5 size-3.5 flex-none text-success" />
                  <span>
                    {t('settings:firmware.succeeded')}
                    {vm.result.version
                      ? ` ${t('settings:firmware.succeededVersion', { version: vm.result.version })}`
                      : ''}
                  </span>
                </span>
              </Notice>
            ) : (
              <Notice tone="danger">
                {t('settings:firmware.failedTitle')}：
                {formatFirmwareReason(vm.result.reason, vm.result.msg)}
              </Notice>
            )}
            {vm.result.warning ? (
              <Notice>
                <span className="flex items-start gap-2 text-foreground">
                  <AlertTriangle className="mt-0.5 size-3.5 flex-none" />
                  <span>{vm.result.warning}</span>
                </span>
              </Notice>
            ) : null}
          </div>
        ) : null}
      </Card>
    </div>
  )
}

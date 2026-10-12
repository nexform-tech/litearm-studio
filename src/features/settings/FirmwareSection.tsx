import { useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Ban, CheckCircle2, Cpu, RefreshCw, ShieldAlert, ShieldCheck, Upload } from 'lucide-react'
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
 *
 * ⚠ 这里有**两条**合法的起点，别把第二条当成异常：连着应用（常规升级），或者
 * **板子已经停在 ROM bootloader 里**（没有会话 —— 那条路是"救援", 见 issue #152 与
 * daemon `dfu.job` 的 `from_dfu`）。第二种正是以前无路可走的那种板子：它没有应用态
 * 可连，而"先连接"的闸门会把唯一能救它的动作锁在外面。
 */
export function FirmwareSection() {
  const { t } = useTranslation(['common', 'settings'])
  const vm = useFirmwareUpgrade()
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [supported, setSupported] = useState(false)

  const running = vm.running
  const busy = vm.inspecting || vm.starting
  /** 走的是"板子已经停在 bootloader 里"那条路：没有会话，只有一块等着被烧的板子。 */
  const fromDfu = !vm.connected && vm.dfuPresent
  // ⚠ 两个条件**或**在一起：连着应用（常规升级）**或**板子在 bootloader 里（救援）。
  //   后者恰恰没有会话 —— 只按 `connected` 把关就是 issue #152 那个死循环：连不上就
  //   不能烧，而只有烧了才能重新连上。
  const canStart = (vm.connected || fromDfu) && vm.engineReady && vm.summary !== null
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
            <p className="mt-0.5 text-xs text-muted-foreground">
              {fromDfu ? t('settings:firmware.introDfu') : t('settings:firmware.intro')}
            </p>
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

        {fromDfu ? (
          // ⚠ 这一句是 issue #152 的落点：**说清是哪种"没连上"**。板子在 bootloader 里
          //   时顶栏连不上是**正确行为**（它没有应用态），不说清的话操作员就会去查线、
          //   换口、重装驱动 —— 而它只想被烧一次。
          <div data-testid="firmware-dfu">
            <Notice>
              <span className="flex items-start gap-2 text-foreground">
                <Cpu className="mt-0.5 size-3.5 flex-none" />
                <span>{t('settings:firmware.dfuPresent')}</span>
              </span>
            </Notice>
          </div>
        ) : !vm.connected ? (
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
        {/* ⚠ 这一块**始终**显示，不等选文件：三条事实（会失能、急停不可达、许可证不被动）
            对任何一份镜像都成立，操作员可以在选文件之前先读完、再决定要不要动手；等到
            选完文件才冒出来，反而像是"选完就必须点下去"。
            ⚠ 块内三层东西的权重必须**分得开**：标题（warn 色）/ 三条"会发生什么"的事实
            （次要、可扫）/ 复选框（唯一的动作，最易读）。 */}
        <div
          data-testid="firmware-safety"
          className="flex flex-col gap-2.5 rounded-lg border border-warn-line bg-warn-soft px-3 py-2.5"
        >
          <div className="flex items-center gap-1.5 text-[0.71875rem] font-semibold text-warn">
            <ShieldAlert className="size-3.5 flex-none" />
            {t('settings:firmware.safetyTitle')}
          </div>
          <ul className="flex flex-col gap-1">
            <li className="flex items-start gap-1.5 text-[0.6875rem] leading-relaxed text-ink-muted">
              <AlertTriangle className="mt-[0.1875rem] size-3 flex-none" />
              {/* ⚠ 这一条要跟着**路径**变：从 bootloader 起跑时不会再失能（应用早已停下、
                  电机早已松开），照抄"会先失能"会让操作员以为还要再来一次。 */}
              <span>
                {fromDfu
                  ? t('settings:firmware.safetyDisarmDfu')
                  : t('settings:firmware.safetyDisarm')}
              </span>
            </li>
            <li className="flex items-start gap-1.5 text-[0.6875rem] leading-relaxed text-ink-muted">
              <Ban className="mt-[0.1875rem] size-3 flex-none" />
              <span>{t('settings:firmware.safetyStop')}</span>
            </li>
            <li className="flex items-start gap-1.5 text-[0.6875rem] leading-relaxed text-ink-muted">
              <ShieldCheck className="mt-[0.1875rem] size-3 flex-none" />
              <span>{t('settings:firmware.safetyKeep')}</span>
            </li>
          </ul>
          {/* 复选框是这一块里**唯一**的动作：与上面三条事实分开（自己的底色与描边），
              文字用正文本色（这一块里最易读的一层），整行可点。 */}
          <label
            htmlFor="firmware-safety-arm"
            className="flex cursor-pointer items-start gap-2 rounded-md border border-warn-line/60 bg-card px-2.5 py-2 text-[0.71875rem] leading-relaxed text-foreground transition-colors hover:border-warn-line"
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
            <span>{t('settings:firmware.safetyArm')}</span>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            data-testid="firmware-start"
            size="sm"
            disabled={!canStart}
            onClick={() => void vm.start()}
          >
            {vm.starting
              ? t('settings:firmware.starting')
              : fromDfu
                ? t('settings:firmware.startDfu')
                : t('settings:firmware.start')}
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
        {/* `progress` 只在**真的在跑**时才非空（`useFirmwareUpgrade` 恢复状态时，已经
            结束的 job 只恢复结果、不恢复进度），所以这里不会出现"进行中 · 完成"。 */}
        {vm.progress && !vm.result ? (
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

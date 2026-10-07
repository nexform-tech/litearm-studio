import { useCallback, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Copy, RefreshCw, ShieldAlert } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useArmConnection, useArmState } from '@/lib/arm'
import { useActivation } from './useActivation'
import { ActivationForm } from './ActivationForm'

type BadgeVariant = 'success' | 'outline' | 'destructive'

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[0.6875rem] font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-line bg-muted/40 px-3 py-2 text-[0.71875rem] leading-relaxed text-muted-foreground">
      {children}
    </p>
  )
}

/** `20260929` → `2026-09-29`；不是这个形状就原样回（不猜日期）。 */
function formatIssued(issued: number): string {
  const s = String(issued)
  if (!/^\d{8}$/.test(s)) return String(issued)
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`
}

/**
 * 设置页里的「授权激活」段：显示这台臂是否已激活、设备 UID，以及拿凭据的下一步。
 *
 * ⚠ 这里**只有只读那一半**。提交凭据（`0x3F`）要等凭据文件格式定稿 —— 详见
 * `docs/ACTIVATION.md`。所以本段刻意不给一个"激活"按钮：一个按下去只会失败或什么都不做的
 * 按钮，比没有按钮更糟。
 */
export function ActivationSection() {
  const { t } = useTranslation(['common', 'settings'])
  const vm = useActivation()
  const armState = useArmState()
  const { conn } = useArmConnection()
  const firmware = conn?.firmware ?? ''
  const snapshot = vm.snapshot
  // ⚠ 记录**不从这里现推**。读不到时 hook 会留住上一条并给出 `stale`（见 `useActivation`）:
  //   从快照推的话, `{supported: null}` 会把记录连同 UID 一起推成空。
  const record = vm.record
  // ⚠ 固件只在**失能**时写授权记录（使能中会回 `0x3F/0x04`）。状态帧还没来时按"可试"处理：
  // 拿不到状态就不该替用户把按钮锁死，真被拒了固件会说清楚。
  const disarmed = !(armState?.enabled ?? false)

  const copyUid = useCallback(async () => {
    const uid = record?.uid
    if (!uid) return
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(uid)
      toast.success(t('settings:activation.copied'))
    } catch {
      // 复制失败要让操作员看见：UID 是这一段的**唯一交付物**，静默失败等于让他去手抄。
      toast.error(t('settings:activation.copyFailed'))
    }
  }, [record?.uid, t])

  const stateLabel = (() => {
    if (!record) return ''
    if (record.state === 2) return t('settings:activation.stateFactory')
    if (record.state === 1) return t('settings:activation.stateActivated')
    if (record.state === 0) return t('settings:activation.stateNotActivated')
    return t('settings:activation.stateUnknown', { code: record.state })
  })()

  const badge: { variant: BadgeVariant; label: string } = (() => {
    if (!vm.connected) return { variant: 'outline', label: t('common:statusOffline') }
    if (vm.error) return { variant: 'destructive', label: t('settings:activation.unreadable') }
    if (!snapshot) return { variant: 'outline', label: '—' }
    if (snapshot.supported === false) return { variant: 'outline', label: t('settings:activation.unsupported') }
    if (snapshot.supported === null) return { variant: 'outline', label: t('settings:activation.unreadable') }
    return snapshot.activated
      ? { variant: 'success', label: stateLabel }
      : { variant: 'outline', label: stateLabel }
  })()

  return (
    <Card className="flex flex-col gap-4 rounded-[0.875rem] p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-foreground">{t('settings:activation.title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('settings:activation.desc')}</p>
        </div>
        <div className="flex flex-none items-center gap-2">
          <Badge
            data-testid="activation-status"
            variant={badge.variant}
            className="h-auto rounded-full px-2.5 py-0.5 text-[0.71875rem] font-semibold"
          >
            {badge.label}
          </Badge>
          <Button
            size="sm"
            variant="outline"
            disabled={!vm.connected || vm.loading}
            onClick={() => void vm.refresh()}
          >
            <RefreshCw className={vm.loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
            {t('settings:activation.refresh')}
          </Button>
        </div>
      </div>

      {!vm.connected ? (
        <Notice>{t('settings:activation.offline')}</Notice>
      ) : (
        <>
          {vm.error ? (
            <Notice>
              <span className="flex items-start gap-2 text-danger">
                <ShieldAlert className="mt-0.5 size-3.5 flex-none" />
                {vm.error}
              </span>
            </Notice>
          ) : null}
          {/* ⚠ 读失败**不清掉**上一次读到的记录: UID 是这一段唯一的交付物, 而它在一台机器
              上是不变的 —— 一次链路抖动就把它从屏幕上抹掉, 等于让操作员重来一遍。但必须
              同时标明这是**旧读数**, 不能让"已激活"看起来像刚刚确认过 (见下面的提示)。
              没有旧记录时才只显示错误。 */}
          {record ? (
            <>
              {vm.stale ? (
                <p
                  data-testid="activation-stale"
                  className="text-[0.6875rem] leading-relaxed text-muted-foreground"
                >
                  {t('settings:activation.staleRecord')}
                </p>
              ) : null}
              {record.activated ? (
                <Notice>{t('settings:activation.activatedHint')}</Notice>
              ) : (
                <Notice>{t('settings:activation.locked')}</Notice>
              )}

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[0.6875rem] font-medium text-muted-foreground">
              {t('settings:activation.uid')}
            </span>
            <code
              data-testid="activation-uid"
              className="rounded bg-muted px-2 py-1 font-mono text-xs text-foreground"
            >
              {record.uid || '—'}
            </code>
            <Button size="sm" variant="outline" disabled={!record.uid} onClick={() => void copyUid()}>
              <Copy className="size-3.5" />
              {t('settings:activation.copy')}
            </Button>
          </div>
          {!record.activated ? (
            <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
              {t('settings:activation.uidHint')}
            </p>
          ) : null}

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Field label={t('settings:activation.customer')}>
              <span className="font-mono text-xs text-foreground">{record.custId || '—'}</span>
            </Field>
            <Field label={t('settings:activation.issued')}>
              <span className="font-mono text-xs text-foreground">
                {record.issued ? formatIssued(record.issued) : '—'}
              </span>
            </Field>
            <Field label={t('settings:activation.flags')}>
              <span className="font-mono text-xs text-foreground">
                {record.factoryMode
                  ? t('settings:activation.flagsFactory')
                  : record.flags
                    ? `0x${record.flags.toString(16)}`
                    : t('settings:activation.flagsNone')}
              </span>
            </Field>
            <Field label={t('settings:activation.recordVer')}>
              <span className="font-mono text-xs text-foreground">{record.ver}</span>
            </Field>
          </div>

          {/* 只有**未激活**时才出表单：已激活的机器不需要注册信息，摆在那儿只会让人误点。 */}
          {!record.activated ? (
            <ActivationForm vm={vm} uid={record.uid} firmware={firmware} disarmed={disarmed} />
          ) : null}
        </>
      ) : vm.error ? null : snapshot?.supported === false ? (
        <Notice>{t('settings:activation.unsupportedHint')}</Notice>
      ) : snapshot?.supported === null ? (
        <Notice>{t('settings:activation.unreadableHint')}</Notice>
      ) : (
        <Notice>{t('common:loading')}</Notice>
      )}
        </>
      )}
    </Card>
  )
}

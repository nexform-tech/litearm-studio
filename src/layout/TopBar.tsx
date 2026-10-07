import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useArmConnection, useArmState } from '@/lib/arm'

// 控制频率来自实机 pylitearm 默认配置（litearm.yaml transport.control_loop_hz），
// daemon 目前没有查询接口，作为常量展示。
const CONTROL_LOOP_HZ = 250

export function TopBar() {
  const { pathname } = useLocation()
  const { t } = useTranslation(['common', 'nav'])

  const titleMap: Record<string, string> = {
    '/control': t('nav:controlTitle'),
    '/log': t('nav:logTitle'),
    '/settings': t('nav:settingsTitle'),
  }
  const title = titleMap[pathname] ?? t('nav:controlTitle')

  const { status, conn, lastError, connect, disconnect } = useArmConnection()
  const armState = useArmState()

  const connected = status === 'connected'
  const connecting = status === 'connecting'
  const port = conn?.port || '—'
  const firmware = conn?.firmware || '—'

  const temps = (armState?.temps ?? []).map((x) => (typeof x?.mosTemp === 'number' && !isNaN(x.mosTemp) ? x.mosTemp : 0))
  const maxTemp = temps.length ? Math.max(...temps) : null
  const hasFault = armState ? (armState.errs ?? []).some((e) => e >= 8) || armState.state === 'fault' : null

  const stats = [
    { k: t('common:controlFrequency'), v: String(CONTROL_LOOP_HZ), u: 'Hz', fixed: true },
    { k: t('common:maxJointTemp'), v: maxTemp != null ? String(Math.round(maxTemp)) : '—', u: '°C', fixed: false },
    {
      k: t('common:faultStatus'),
      v: hasFault == null ? '—' : hasFault ? t('common:hasFault') : t('common:noFault'),
      u: '',
      tone: hasFault == null ? 'none' : hasFault ? 'danger' : 'success',
      fixed: false,
    },
  ]
  const badgeVariant = connected ? 'success' : status === 'error' ? 'destructive' : 'outline'
  const dotClass = connected ? 'bg-success' : status === 'error' ? 'bg-destructive' : 'bg-muted-foreground'

  const statusLabel =
    status === 'connected'
      ? t('common:connected')
      : status === 'connecting'
        ? t('common:connecting')
        : status === 'reconnecting'
          ? t('common:reconnecting')
          : status === 'upgrading'
            // 升级期间设备在 ROM bootloader 里 —— 那不是"掉线", 是我们自己交出去的。
            // 并进 `disconnected` 会让操作员去点「连接」, 而那正是最不该做的事。
            ? t('common:upgrading')
            : status === 'error'
              ? t('common:connectFailed')
            : t('common:disconnected')

  return (
    <div className="flex h-14 flex-none basis-14 items-center justify-between border-b bg-card px-[1.125rem]">
      <div className="flex min-w-0 flex-1 items-center gap-3.5">
        <div className="flex-none text-base font-bold text-foreground">{title}</div>

        {/* 连接状态徽标（只读，不可点击） */}
        <Badge
          id="topbar-connection-status"
          variant={badgeVariant}
          className="h-auto flex-none gap-[0.4375rem] rounded-full px-[0.6875rem] py-1 whitespace-nowrap"
        >
          <div className={cn('size-[0.4375rem] rounded-full', dotClass)} />
          <span className="text-[0.78125rem] font-semibold">{statusLabel}</span>
        </Badge>

        {/* 只读显示「端口名 · 固件版本」——本机 daemon 自动发现设备，无端点可配 */}
        <div
          id="topbar-port-firmware"
          className="flex-none font-mono text-xs text-muted-foreground"
          title={lastError || undefined}
        >
          {port} · {firmware}
        </div>

        <div className="flex flex-none items-center gap-1.5">
          <Button
            id="topbar-connect-btn"
            size="sm"
            onClick={connect}
            disabled={connected || connecting}
          >
            {t('nav:connect')}
          </Button>
          <Button
            id="topbar-disconnect-btn"
            variant="outline"
            size="sm"
            onClick={disconnect}
            disabled={status === 'disconnected'}
          >
            {t('common:disconnect')}
          </Button>
        </div>

        {status === 'error' && lastError ? (
          <div className="min-w-0 truncate text-[0.71875rem] text-destructive" title={lastError}>
            {lastError}
          </div>
        ) : null}

        {/* Stats scroll horizontally within the fixed-height header */}
        <div className="ml-auto flex min-w-0 items-center gap-4 overflow-x-auto">
          {stats.map((h) => (
            <div key={h.k} className="flex flex-none items-baseline gap-[0.3125rem]" title={h.fixed ? t('common:controlFrequencyFixedHint') : undefined}>
              <div className="text-xs font-medium whitespace-nowrap text-muted-foreground">{h.k}</div>
              <div
                className={cn(
                  'font-mono text-sm font-bold',
                  h.tone === 'success' ? 'text-success' : h.tone === 'danger' ? 'text-destructive' : 'text-foreground',
                )}
              >
                {h.v}
              </div>
              <div className="font-mono text-[0.6875rem] text-muted-foreground">{h.u}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

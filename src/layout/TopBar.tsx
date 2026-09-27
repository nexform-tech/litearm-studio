import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { armClient, useArmConnection, useArmState } from '@/lib/arm'
import { ARM_ENDPOINT_LS_KEY, DEFAULT_ARM_ENDPOINT, getInitialEndpoint } from '@/lib/arm/endpoint'
import { PencilIcon } from 'lucide-react'

// 控制频率来自实机 pylitearm 默认配置（litearm.yaml transport.control_loop_hz），
// 服务端目前没有 RPC 可查，作为常量展示。
const CONTROL_LOOP_HZ = 250

/** 把 `ip:port` 端点拆成主机与端口两部分，兼容缺失端口与 IPv6 地址。 */
function splitEndpoint(endpoint: string): { host: string; port: string } {
  const idx = endpoint.lastIndexOf(':')
  if (idx === -1) return { host: endpoint.trim(), port: '' }
  return { host: endpoint.slice(0, idx).trim(), port: endpoint.slice(idx + 1).trim() }
}

/** 端口合法：1-65535 的纯数字。 */
function isValidPort(port: string): boolean {
  if (!/^\d+$/.test(port)) return false
  const n = Number(port)
  return n >= 1 && n <= 65535
}

export function TopBar() {
  const { pathname } = useLocation()
  const { t } = useTranslation(['common', 'nav'])

  const titleMap: Record<string, string> = {
    '/control': t('nav:controlTitle'),
    '/log': t('nav:logTitle'),
    '/settings': t('nav:settingsTitle'),
  }
  const title = titleMap[pathname] ?? t('nav:controlTitle')

  const { status, endpoint, lastError, connect, disconnect } = useArmConnection()
  const armState = useArmState()
  const [payloadKg, setPayloadKg] = useState<number | null>(null)

  // ── 编辑端点 Dialog 状态 ──
  const [dialogOpen, setDialogOpen] = useState(false)
  const [draftHost, setDraftHost] = useState('')
  const [draftPort, setDraftPort] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const portValid = isValidPort(draftPort)
  const showPortError = draftPort.trim() !== '' && !portValid

  // 打开 Dialog 时，用当前连接端点（或 localStorage 里的）初始化草稿
  const handleOpenChange = (open: boolean) => {
    if (open) {
      const { host, port } = splitEndpoint(endpoint || getInitialEndpoint())
      setDraftHost(host)
      setDraftPort(port)
    }
    setDialogOpen(open)
  }

  // 确认重连
  const handleConnect = () => {
    const host = draftHost.trim()
    if (!host || !portValid) return
    const trimmed = `${host}:${draftPort.trim()}`
    localStorage.setItem(ARM_ENDPOINT_LS_KEY, trimmed)
    connect(trimmed)
    setDialogOpen(false)
  }

  const connected = status === 'connected'

  // 负载可能在设置页被修改，连接期间每 20s 同步一次，避免顶栏数字过期
  useEffect(() => {
    if (!connected) {
      setPayloadKg(null)
      return
    }
    let cancelled = false
    const load = () => {
      armClient
        .withArm((a) => a.getPayload())
        .then((p) => {
          if (!cancelled) setPayloadKg(Number(p.mass) || 0)
        })
        .catch(() => {
          if (!cancelled) setPayloadKg(null)
        })
    }
    load()
    const timer = setInterval(load, 20000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [connected])

  const temps = (armState?.temps ?? []).map((t) => (typeof t?.mosTemp === 'number' && !isNaN(t.mosTemp) ? t.mosTemp : 0))
  const maxTemp = temps.length ? Math.max(...temps) : null
  const hasFault = armState ? (armState.errs ?? []).some((e) => e >= 8) || armState.state === 'fault' : null

  const stats = [
    { k: t('common:controlFrequency'), v: String(CONTROL_LOOP_HZ), u: 'Hz', fixed: true },
    { k: t('common:payload'), v: payloadKg != null ? payloadKg.toFixed(2) : '—', u: 'kg', fixed: false },
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
          : status === 'error'
            ? t('common:connectFailed')
            : t('common:disconnected')

  const label = connected
    ? `${statusLabel} · ${endpoint}`
    : status === 'error' && lastError
      ? `${statusLabel} · ${lastError}`
      : `${statusLabel} · ${endpoint}`

  return (
    <div className="flex h-14 flex-none basis-14 items-center justify-between border-b bg-card px-[1.125rem]">
      <div className="flex min-w-0 flex-1 items-center gap-3.5">
        <div className="flex-none text-base font-bold text-foreground">{title}</div>

        {/* 连接状态徽标：整个徽标可点击，点击后配置连接信息 */}
        <Dialog open={dialogOpen} onOpenChange={handleOpenChange}>
          <DialogTrigger asChild>
            <Badge
              asChild
              id="topbar-edit-endpoint-btn"
              variant={badgeVariant}
              title={t('nav:editEndpoint')}
              className={cn(
                'h-auto flex-none cursor-pointer gap-[0.4375rem] rounded-full px-[0.6875rem] py-1 whitespace-nowrap',
                connected
                  ? 'hover:bg-success/20'
                  : status === 'error'
                    ? 'hover:bg-destructive/20'
                    : 'hover:bg-muted hover:text-muted-foreground',
              )}
            >
              <button type="button">
                <div className={cn('size-[0.4375rem] rounded-full', dotClass)} />
                <span className="text-[0.78125rem] font-semibold">{label}</span>
                <PencilIcon className="size-3.5" />
              </button>
            </Badge>
          </DialogTrigger>

          <DialogContent className="sm:max-w-xs">
            <DialogHeader>
              <DialogTitle>{t('nav:connectionSettings')}</DialogTitle>
            </DialogHeader>

            <div className="flex flex-col gap-3 py-1">
              <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] items-start gap-2">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">{t('nav:endpointHostLabel')}</span>
                  <input
                    ref={inputRef}
                    id="topbar-endpoint-input"
                    type="text"
                    value={draftHost}
                    onChange={(e) => setDraftHost(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
                    placeholder="192.168.x.x"
                    className="h-9 w-full min-w-0 rounded-md border bg-background px-3 font-mono text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    autoFocus
                    spellCheck={false}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">{t('nav:endpointPortLabel')}</span>
                  <input
                    id="topbar-endpoint-port-input"
                    type="text"
                    inputMode="numeric"
                    value={draftPort}
                    onChange={(e) => setDraftPort(e.target.value.replace(/[^0-9]/g, '').slice(0, 5))}
                    onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
                    placeholder="7449"
                    className={cn(
                      'h-9 w-full rounded-md border bg-background px-3 font-mono text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring',
                      showPortError && 'border-destructive focus:ring-destructive',
                    )}
                    spellCheck={false}
                  />
                </label>
              </div>
              {showPortError && (
                <p className="text-[0.71875rem] text-destructive">
                  {t('nav:endpointPortInvalid')}
                </p>
              )}
              <p className="text-[0.71875rem] text-muted-foreground">
                {t('nav:endpointHelp')}
              </p>
            </div>

            <DialogFooter>
              <Button
                id="topbar-endpoint-reset-btn"
                variant="outline"
                size="sm"
                onClick={() => {
                  const { host, port } = splitEndpoint(DEFAULT_ARM_ENDPOINT)
                  setDraftHost(host)
                  setDraftPort(port)
                }}
              >
                {t('common:resetDefault')}
              </Button>
              <Button
                id="topbar-endpoint-disconnect-btn"
                variant="outline"
                size="sm"
                onClick={() => {
                  disconnect()
                  setDialogOpen(false)
                }}
              >
                {t('common:disconnect')}
              </Button>
              <Button
                id="topbar-endpoint-connect-btn"
                size="sm"
                onClick={handleConnect}
                disabled={!draftHost.trim() || !portValid}
              >
                {t('nav:connect')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

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

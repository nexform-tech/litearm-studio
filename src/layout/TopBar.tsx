import { useLocation } from 'react-router-dom'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useArmConnection, useArmPorts, useArmState } from '@/lib/arm'

/**
 * daemon `state` 帧里的状态串 → 词条键。
 *
 * ⚠ 表里没有的码**原样显示**，不要加 fallback 去猜：固件加了新状态时，让操作员看到
 * 固件真正说的那个词，比看到一句我们编的翻译有用（夹爪面板同一套做法）。
 */
const ARM_STATE_I18N: Record<
  string,
  'common:disabled' | 'common:ready' | 'common:moving' | 'common:zeroGravity' | 'common:stopped' | 'common:fault'
> = {
  disabled: 'common:disabled',
  ready: 'common:ready',
  moving: 'common:moving',
  zero_gravity: 'common:zeroGravity',
  stopped: 'common:stopped',
  fault: 'common:fault',
}

/**
 * 「自动发现」这一项的值。
 *
 * ⚠ 不能用空串: Radix 的 `SelectItem` 拒绝 `value=""`（那是它的"没有值"哨兵）。
 * 也刻意不是任何真实设备名 —— 下拉里的值会**原样**当串口路径发给 daemon。
 */
const AUTO_PORT = '__auto__'

export function TopBar() {
  const { pathname } = useLocation()
  const { t } = useTranslation(['common', 'nav'])

  const titleMap: Record<string, string> = {
    '/control': t('nav:controlTitle'),
    '/log': t('nav:logTitle'),
    '/settings': t('nav:settingsTitle'),
  }
  const title = titleMap[pathname] ?? t('nav:controlTitle')

  const { status, conn, lastError, connectError, connect, disconnect } = useArmConnection()
  const armState = useArmState()
  const ports = useArmPorts()
  const [selected, setSelected] = useState<string>(AUTO_PORT)

  const connected = status === 'connected'
  const connecting = status === 'connecting'
  const port = conn?.port || '—'
  const firmware = conn?.firmware || '—'

  // 错误槽里显示什么。⚠ `connectError`（daemon 拒绝了这次改口）**不看 `status`**：
  // 那时链路还好好的，徽标仍是绿色的「已连接」——界面必须同时说清这两件事，而不是
  // 把一次被拒的改口说成"连接失败"。
  const errorNotice = connectError ?? (status === 'error' ? lastError : null)

  // 下拉里的候选 + 操作员选过的那个。后者必须留着自己那一项: 它可能已经不在枚举结果
  // 里 (设备拔了), 而 Radix 在值不在列表里时会退回占位符 —— 那看着像"什么都没选",
  // 于是"再点一次连接"就变成了一件说不清会发生什么的事。
  const portOptions = Array.from(
    new Set(
      [...ports.ports, selected === AUTO_PORT ? null : selected].filter(
        (p): p is string => !!p,
      ),
    ),
  ).sort()

  // 顶栏右侧三项全部取自 daemon 的实时 `state` 帧。
  // ⚠ 这里曾经放着写死的「控制频率 250 Hz」和「最高关节温度」：前者 daemon 没有查询
  //   接口，是一个**永不变化**的常数（顶栏里唯一不反映设备状态的数字，等于假读数）；
  //   后者温度曲线面板已经画了同一份数据。换成使能与运行状态：这两项才是操作员扫一眼
  //   顶栏要确认的事（现在能不能动、现在在干什么），且都来自广播帧、无一处是常数。
  const armEnabled = armState ? armState.enabled : null
  const runState = armState?.state.trim() || null
  const runStateKey = runState ? ARM_STATE_I18N[runState] : undefined
  const hasFault = armState ? (armState.errs ?? []).some((e) => e >= 8) || armState.state === 'fault' : null

  const stats = [
    {
      k: t('common:armEnable'),
      v: armEnabled == null ? '—' : armEnabled ? t('common:enabled') : t('common:disabled'),
      tone: armEnabled === true ? 'success' : 'none',
    },
    {
      k: t('common:runState'),
      v: runState == null ? '—' : runStateKey ? t(runStateKey) : runState,
      tone: runState === 'fault' ? 'danger' : 'none',
    },
    {
      k: t('common:faultStatus'),
      v: hasFault == null ? '—' : hasFault ? t('common:hasFault') : t('common:noFault'),
      tone: hasFault == null ? 'none' : hasFault ? 'danger' : 'success',
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

        {/* 选「这次连哪台」，旁边只读显示「现在连着哪台 · 固件」——两者不是一回事:
            自动发现连上的时候下拉仍停在「自动发现」。
            ⚠ 连着的时候锁住下拉: 换口要先断开, daemon 也会拒绝在途改口。 */}
        <Select
          value={selected}
          onValueChange={setSelected}
          disabled={connected || connecting}
          onOpenChange={(open) => {
            // 打开下拉的那一刻重新枚举 —— 插拔设备之后不必刷新整页。
            if (open) ports.reload()
          }}
        >
          <SelectTrigger
            id="topbar-port"
            data-testid="topbar-port"
            aria-label={t('common:serialPort')}
            title={ports.error ?? t('common:portPickerHint')}
            className="h-7 w-[12.5rem] flex-none font-mono text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AUTO_PORT} data-testid="topbar-port-auto">
              {t('common:portAuto')}
            </SelectItem>
            {portOptions.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* 只读显示「端口名 · 固件版本」 */}
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
            // ⚠ 不能写成 `onClick={connect}`: React 会把点击事件当第一个参数传进去, 而
            //   `connect(port?)` 会拿事件对象去 `trim()`。
            onClick={() => connect(selected === AUTO_PORT ? undefined : selected)}
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

        {errorNotice ? (
          <div
            data-testid="topbar-error"
            className="min-w-0 truncate text-[0.71875rem] text-destructive"
            title={errorNotice}
          >
            {errorNotice}
          </div>
        ) : null}

        {/* Stats scroll horizontally within the fixed-height header */}
        <div className="ml-auto flex min-w-0 items-center gap-4 overflow-x-auto">
          {stats.map((h) => (
            <div key={h.k} className="flex flex-none items-baseline gap-[0.3125rem]">
              <div className="text-xs font-medium whitespace-nowrap text-muted-foreground">{h.k}</div>
              <div
                className={cn(
                  'font-mono text-sm font-bold',
                  h.tone === 'success' ? 'text-success' : h.tone === 'danger' ? 'text-destructive' : 'text-foreground',
                )}
              >
                {h.v}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

import { RefreshCw, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useControllerLogsState } from './useControllerLogsState'
import { LogLevelBadge } from './logUi'
import { formatTimestamp } from './formatTimestamp'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

/** 控制器日志面板：经机械臂 WebSocket（get_logs RPC）读取 litearm-server 日志。 */
export function ControllerLogPanel() {
  const { t, i18n } = useTranslation(['common', 'logs'])
  const vm = useControllerLogsState()

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Card className="flex-none flex-row flex-wrap items-center gap-3 rounded-[0.875rem] px-3.5 py-2.5">
        <div className="text-[0.90625rem] font-semibold text-foreground">{t('logs:tabsController')}</div>
        <div className="flex-1" />
        <div className="flex min-w-[16rem] flex-[0_1_20rem] items-center gap-2 rounded-[0.625rem] border bg-muted/40 px-[0.6875rem] py-[0.4375rem]">
          <Search size="0.8125rem" className="text-muted-foreground" />
          <Input
            value={vm.search}
            onChange={(e) => vm.setSearch(e.target.value)}
            placeholder={t('logs:searchPlaceholder')}
            className="h-auto border-0 bg-transparent p-0 text-[0.8125rem] shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-auto gap-1.5 rounded-[0.5625rem] px-3 py-1.5 text-[0.78125rem] font-semibold"
          onClick={vm.refresh}
          disabled={vm.loading}
        >
          <RefreshCw size="0.8125rem" className={vm.loading ? 'animate-spin' : ''} />
          {t('common:refresh')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-auto gap-1.5 rounded-[0.5625rem] px-3 py-1.5 text-[0.78125rem] font-semibold"
          onClick={vm.toggleAutoRefresh}
        >
          {vm.autoRefresh ? t('logs:pauseAutoRefresh') : t('logs:resumeAutoRefresh')}
        </Button>
      </Card>

      <Card className="min-h-0 flex-1 gap-2.5 rounded-[0.875rem] px-4 py-3.5">
        <div className="min-h-0 flex-1 overflow-auto">
          {!vm.connected ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">{t('logs:controllerNotConnected')}</div>
          ) : vm.error ? (
            <div className="px-4 py-10 text-center text-sm text-destructive">{vm.error}</div>
          ) : vm.entries.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              {vm.loading ? t('logs:loading') : t('logs:noLogs')}
            </div>
          ) : (
            <Table className="table-fixed">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead style={{ width: '9rem' }} className="text-[0.6875rem] font-semibold text-muted-foreground">
                    {t('logs:time')}
                  </TableHead>
                  <TableHead style={{ width: '6rem' }} className="text-[0.6875rem] font-semibold text-muted-foreground">
                    {t('logs:level')}
                  </TableHead>
                  <TableHead className="text-[0.6875rem] font-semibold text-muted-foreground">{t('logs:content')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {vm.entries.map((e, i) => (
                  <TableRow key={`${e.timestamp}-${i}`}>
                    <TableCell className="font-mono text-xs text-ink-muted">{formatTimestamp(e.timestamp, i18n.language)}</TableCell>
                    <TableCell>
                      <LogLevelBadge level={e.level} />
                    </TableCell>
                    <TableCell className="text-[0.8125rem] text-foreground">
                      {e.logger ? <span className="mr-1.5 text-muted-foreground">[{e.logger}]</span> : null}
                      {e.message}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        {vm.connected && vm.total > 0 ? (
          <div className="flex flex-none items-center justify-end gap-3 pt-1 text-xs text-muted-foreground">
            <span>{t('logs:total', { count: vm.total })}</span>
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-auto rounded-md px-2 py-1 text-xs"
                disabled={vm.page <= 1 || vm.loading}
                onClick={() => vm.setPage(vm.page - 1)}
              >
                {t('logs:prevPage')}
              </Button>
              <span>
                {vm.page} / {vm.totalPages}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-auto rounded-md px-2 py-1 text-xs"
                disabled={vm.page >= vm.totalPages || vm.loading}
                onClick={() => vm.setPage(vm.page + 1)}
              >
                {t('logs:nextPage')}
              </Button>
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  )
}

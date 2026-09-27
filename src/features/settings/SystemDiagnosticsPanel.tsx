import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Cpu, HardDrive, Thermometer, Clock, Power, RefreshCw, Activity, Network, Languages } from 'lucide-react'
import type { SettingsState } from './useSettingsState'

export function SystemDiagnosticsPanel({ vm }: { vm: SettingsState }) {
  const { t, i18n } = useTranslation(['common', 'settings'])
  const [restartDialogOpen, setRestartDialogOpen] = useState(false)
  const stats = vm.systemStats

  const formatUptime = (seconds?: number) => {
    if (!seconds) return '—'
    const hours = Math.floor(seconds / 3600)
    const mins = Math.floor((seconds % 3600) / 60)
    return t('settings:system.uptimeHours', { hours, mins })
  }

  const handleRestart = async () => {
    setRestartDialogOpen(false)
    await vm.restartService()
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* 控制器硬件健康状态 */}
      <Card className="flex flex-col border shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600">
                <Activity className="size-4" />
              </div>
              <div>
                <CardTitle className="text-base font-bold">{t('settings:system.title')}</CardTitle>
                <CardDescription className="text-xs">
                  {t('settings:system.description')}
                </CardDescription>
              </div>
            </div>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={vm.fetchSystemStats}
              disabled={!vm.connected || vm.loadingStats}
              title={t('common:refresh')}
            >
              <RefreshCw className={`size-3.5 ${vm.loadingStats ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex-1 space-y-4 text-sm">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {/* CPU */}
            <div className="rounded-lg border bg-muted/20 p-3">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{t('settings:system.cpuLoad')}</span>
                <Cpu className="size-3.5" />
              </div>
              <div className="mt-2 font-mono text-xl font-bold text-foreground">
                {stats?.cpu_percent != null ? `${stats.cpu_percent}%` : '—'}
              </div>
              <Progress value={stats?.cpu_percent || 0} className="mt-2 h-1.5" />
            </div>

            {/* 内存 */}
            <div className="rounded-lg border bg-muted/20 p-3">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{t('settings:system.memUsage')}</span>
                <Activity className="size-3.5" />
              </div>
              <div className="mt-2 font-mono text-xl font-bold text-foreground">
                {stats?.mem_percent != null ? `${stats.mem_percent}%` : '—'}
              </div>
              <Progress value={stats?.mem_percent || 0} className="mt-2 h-1.5" />
            </div>

            {/* 磁盘 */}
            <div className="rounded-lg border bg-muted/20 p-3">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{t('settings:system.diskSpace')}</span>
                <HardDrive className="size-3.5" />
              </div>
              <div className="mt-2 font-mono text-xl font-bold text-foreground">
                {stats?.disk_percent != null ? `${stats.disk_percent}%` : '—'}
              </div>
              <Progress value={stats?.disk_percent || 0} className="mt-2 h-1.5" />
            </div>

            {/* 主板温度 */}
            <div className="rounded-lg border bg-muted/20 p-3">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{t('settings:system.boardTemp')}</span>
                <Thermometer className="size-3.5 text-amber-500" />
              </div>
              <div className="mt-2 font-mono text-xl font-bold text-foreground">
                {stats?.board_temp != null ? `${stats.board_temp}°C` : '—'}
              </div>
              <div className="mt-2 text-[0.6875rem] text-muted-foreground">
                {stats?.board_temp != null && stats.board_temp > 70
                  ? t('settings:system.tempHigh')
                  : t('settings:system.tempNormal')}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border bg-muted/10 px-3.5 py-2.5 text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <Clock className="size-3.5" />
              <span>{t('settings:system.uptime')}:</span>
            </div>
            <span className="font-mono font-medium text-foreground">{formatUptime(stats?.uptime_seconds)}</span>
          </div>
        </CardContent>
      </Card>

      {/* 控制器后台服务运维 & 界面语言 */}
      <Card className="flex flex-col border shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-red-500/10 text-red-600">
              <Power className="size-4" />
            </div>
            <div>
              <CardTitle className="text-base font-bold">{t('settings:system.serviceTitle')}</CardTitle>
              <CardDescription className="text-xs">
                {t('settings:system.serviceDesc')}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-4 text-sm">
          {/* 界面语言配置 */}
          <div className="rounded-lg border bg-muted/20 p-3.5 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Languages className="size-4 text-primary" />
                <div>
                  <div className="text-xs font-semibold text-foreground">{t('settings:system.languageSection')}</div>
                  <div className="text-[0.71875rem] text-muted-foreground">
                    {t('settings:system.languageDesc')}
                  </div>
                </div>
              </div>
              <div className="flex gap-1.5">
                <Button
                  type="button"
                  variant={i18n.language.startsWith('zh') ? 'default' : 'outline'}
                  size="sm"
                  className="h-8 px-2.5 text-xs"
                  onClick={() => i18n.changeLanguage('zh')}
                >
                  简体中文
                </Button>
                <Button
                  type="button"
                  variant={i18n.language.startsWith('en') ? 'default' : 'outline'}
                  size="sm"
                  className="h-8 px-2.5 text-xs"
                  onClick={() => i18n.changeLanguage('en')}
                >
                  English
                </Button>
              </div>
            </div>
          </div>

          <div className="rounded-lg border bg-muted/20 p-3.5 space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold text-foreground">{t('settings:system.restartService')}</div>
                <div className="text-[0.71875rem] text-muted-foreground">
                  {t('settings:system.restartServiceDesc')}
                </div>
              </div>
              <Dialog open={restartDialogOpen} onOpenChange={setRestartDialogOpen}>
                <DialogTrigger asChild>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={!vm.connected || vm.restartingService}
                    className="gap-1 text-xs"
                  >
                    <Power className="size-3.5" />
                    {vm.restartingService ? t('settings:system.restarting') : t('settings:system.restartBtn')}
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>{t('settings:system.restartDialogTitle')}</DialogTitle>
                    <DialogDescription className="text-xs text-muted-foreground">
                      {t('settings:system.restartDialogDesc')}
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button variant="outline" size="sm" onClick={() => setRestartDialogOpen(false)}>
                      {t('common:cancel')}
                    </Button>
                    <Button variant="destructive" size="sm" onClick={handleRestart}>
                      {t('settings:system.confirmRestart')}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>

          <div className="rounded-lg border bg-muted/20 p-3.5 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Network className="size-4 text-primary" />
                <div>
                  <div className="text-xs font-semibold text-foreground">{t('settings:system.currentEndpoint')}</div>
                  <div className="font-mono text-[0.75rem] text-muted-foreground">
                    {vm.endpoint || t('common:statusOffline')}
                  </div>
                </div>
              </div>
              <div className="text-xs font-medium text-muted-foreground">
                {vm.connected ? t('settings:system.commNormal') : t('settings:system.commOffline')}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

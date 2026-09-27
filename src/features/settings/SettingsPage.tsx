import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Scale, ShieldCheck, Zap, Activity, Lock, HandMetal } from 'lucide-react'
import { useSettingsState } from './useSettingsState'
import { PayloadPanel } from './PayloadPanel'
import { SafetyLimitsPanel } from './SafetyLimitsPanel'
import { GainsPanel } from './GainsPanel'
import { EndEffectorPanel } from './EndEffectorPanel'
import { SystemDiagnosticsPanel } from './SystemDiagnosticsPanel'

const VALID_TABS = ['payload', 'safety', 'gains', 'endEffector', 'system'] as const
type ValidTab = typeof VALID_TABS[number]

export function SettingsPage() {
  const { t } = useTranslation(['common', 'settings'])
  const vm = useSettingsState()
  const [searchParams, setSearchParams] = useSearchParams()

  const tabParam = searchParams.get('tab')
  const activeTab: ValidTab = VALID_TABS.includes(tabParam as ValidTab) ? (tabParam as ValidTab) : 'payload'

  const handleTabChange = (val: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (val === 'payload') {
        next.delete('tab')
      } else {
        next.set('tab', val)
      }
      return next
    }, { replace: true })
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto bg-muted/10 p-6 min-h-0">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
        {/* 顶部标题与连接提示 */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-foreground">{t('settings:header.title')}</h1>
            <p className="text-xs text-muted-foreground">
              {t('settings:header.description')}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-2 sm:pt-0">
            {/* 严格安全模式 / 状态指示 */}
            {vm.connected ? (
              <Badge variant="success" className="gap-1.5 py-1 text-xs font-mono">
                <span className="size-2 rounded-full bg-success animate-pulse" />
                <span>{t('common:connected')} · {vm.endpoint}</span>
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1.5 py-1 text-xs text-muted-foreground bg-muted/40">
                <Lock className="size-3 text-muted-foreground" />
                <span>安全只读锁定 · {t('common:statusOffline')}</span>
              </Badge>
            )}
          </div>
        </div>

        {/* 主选项卡导航 */}
        <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full space-y-4">
          <TabsList className="grid h-11 w-full grid-cols-2 rounded-xl bg-muted/60 p-1 md:grid-cols-5">
            <TabsTrigger value="payload" className="gap-1.5 rounded-lg text-xs font-semibold">
              <Scale className="size-3.5" />
              {t('settings:tabs.payload')}
            </TabsTrigger>
            <TabsTrigger value="safety" className="gap-1.5 rounded-lg text-xs font-semibold">
              <ShieldCheck className="size-3.5" />
              {t('settings:tabs.safety')}
            </TabsTrigger>
            <TabsTrigger value="gains" className="gap-1.5 rounded-lg text-xs font-semibold">
              <Zap className="size-3.5" />
              {t('settings:tabs.gains')}
            </TabsTrigger>
            <TabsTrigger value="endEffector" className="gap-1.5 rounded-lg text-xs font-semibold">
              <HandMetal className="size-3.5" />
              {t('settings:tabs.endEffector', '末端设备')}
            </TabsTrigger>
            <TabsTrigger value="system" className="gap-1.5 rounded-lg text-xs font-semibold">
              <Activity className="size-3.5" />
              {t('settings:tabs.system')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="payload" className="focus-visible:outline-none">
            <PayloadPanel vm={vm} />
          </TabsContent>

          <TabsContent value="safety" className="focus-visible:outline-none">
            <SafetyLimitsPanel vm={vm} />
          </TabsContent>

          <TabsContent value="gains" className="focus-visible:outline-none">
            <GainsPanel vm={vm} />
          </TabsContent>

          <TabsContent value="endEffector" className="focus-visible:outline-none">
            <EndEffectorPanel vm={vm} />
          </TabsContent>

          <TabsContent value="system" className="focus-visible:outline-none">
            <SystemDiagnosticsPanel vm={vm} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}

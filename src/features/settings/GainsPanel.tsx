import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { NumberField } from '@/components/ui/number-field'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Zap, RotateCcw, Wrench, ShieldCheck, RefreshCw, Save, AlertCircle, Lock } from 'lucide-react'
import type { SettingsState } from './useSettingsState'
import { JOINT_COLORS } from '@/lib/colors'

const DEFAULT_KP = [100, 100, 80, 80, 50, 50, 30]
const DEFAULT_KD = [5, 5, 4, 4, 2, 2, 1]

export function GainsPanel({ vm }: { vm: SettingsState }) {
  const { t } = useTranslation(['common', 'settings'])

  // 本地草稿状态
  const [kpDraft, setKpDraft] = useState<number[]>(() => [...DEFAULT_KP])
  const [kdDraft, setKdDraft] = useState<number[]>(() => [...DEFAULT_KD])
  const [dirty, setDirty] = useState(false)
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false)

  // 从远程同步（当未处于编辑草稿状态时）
  useEffect(() => {
    if (dirty) return
    if (vm.gains?.kp && vm.gains.kp.length > 0) {
      setKpDraft(vm.gains.kp.map(Number))
    }
    if (vm.gains?.kd && vm.gains.kd.length > 0) {
      setKdDraft(vm.gains.kd.map(Number))
    }
  }, [vm.gains, dirty])

  const updateKp = (idx: number, val: number) => {
    setKpDraft((prev) => {
      const next = [...prev]
      next[idx] = val
      return next
    })
    setDirty(true)
  }

  const updateKd = (idx: number, val: number) => {
    setKdDraft((prev) => {
      const next = [...prev]
      next[idx] = val
      return next
    })
    setDirty(true)
  }

  // 刚度预设快速应用
  const applyStiffnessPreset = (ratio: number) => {
    setKpDraft(DEFAULT_KP.map((v) => Math.round(v * ratio * 10) / 10))
    setKdDraft(DEFAULT_KD.map((v) => Math.round(v * Math.sqrt(ratio) * 100) / 100))
    setDirty(true)
  }

  // 提交下发增益
  const handleSaveGains = async () => {
    const ok = await vm.saveGains(kpDraft, kdDraft)
    if (ok) setDirty(false)
  }

  const handleRestoreDefaults = async () => {
    setRestoreDialogOpen(false)
    await vm.restoreDefaultGains()
    setKpDraft([...DEFAULT_KP])
    setKdDraft([...DEFAULT_KD])
    setDirty(false)
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 严格安全模式提示栏 */}
      {!vm.canEdit && (
        <div className="flex items-center justify-between rounded-lg bg-muted/60 border border-border/80 px-3.5 py-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <Lock className="size-4 text-muted-foreground" />
            <span>严格安全锁定：控制器未连接，伺服增益处于只读保护状态。请连接机械臂。</span>
          </div>
        </div>
      )}

      {/* 顶部草稿提示 */}
      {dirty && (
        <div className="flex items-center justify-between rounded-lg bg-amber-500/10 border border-amber-500/30 px-3.5 py-2 text-xs text-amber-800 dark:text-amber-300">
          <div className="flex items-center gap-2">
            <AlertCircle className="size-4 text-amber-600 dark:text-amber-400" />
            <span>增益参数已在本地调整（草稿未保存），点击右下角按钮即可下发至伺服驱动器。</span>
          </div>
          <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-300">
            草稿待保存
          </Badge>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 左侧卡片：7 轴 PD 控制增益微调 */}
        <Card className="flex flex-col border shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="flex size-8 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-600">
                  <Zap className="size-4" />
                </div>
                <div>
                  <CardTitle className="text-base font-bold">{t('settings:gains.title')}</CardTitle>
                  <CardDescription className="text-xs">
                    {t('settings:gains.description')}
                  </CardDescription>
                </div>
              </div>
              <Button
                variant="outline"
                size="icon-sm"
                onClick={vm.fetchGains}
                disabled={!vm.canEdit || vm.loadingGains}
                title={t('common:refresh')}
              >
                <RefreshCw className={`size-3.5 ${vm.loadingGains ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col justify-between gap-4 text-sm">
            {/* 刚度快速预设 */}
            <div className="rounded-lg border bg-muted/20 p-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-muted-foreground">
                  {t('settings:gains.presetTitle')}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="h-8 text-xs font-medium"
                  onClick={() => applyStiffnessPreset(0.6)}
                  disabled={!vm.canEdit}
                >
                  {t('settings:gains.presetSoft')} (0.6x)
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="h-8 text-xs font-medium"
                  onClick={() => applyStiffnessPreset(1.0)}
                  disabled={!vm.canEdit}
                >
                  {t('settings:gains.presetStandard')} (1.0x)
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="h-8 text-xs font-medium"
                  onClick={() => applyStiffnessPreset(1.5)}
                  disabled={!vm.canEdit}
                >
                  {t('settings:gains.presetStiff')} (1.5x)
                </Button>
              </div>
            </div>

            {/* 各轴 Kp / Kd 可编辑表格 */}
            <div className="overflow-hidden rounded-lg border bg-card">
              <table className="w-full text-left text-xs">
                <thead className="border-b bg-muted/60 font-medium text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 w-16">{t('settings:gains.colJoint')}</th>
                    <th className="px-3 py-2 font-mono">{t('settings:gains.colKp')}</th>
                    <th className="px-3 py-2 font-mono">{t('settings:gains.colKd')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {Array.from({ length: 7 }, (_, i) => {
                    const color = JOINT_COLORS[i]
                    return (
                      <tr key={i} className="hover:bg-muted/30 transition-colors">
                        <td className="px-3 py-1.5 font-semibold">
                          <div className="flex items-center gap-1.5">
                            <span className="size-2 rounded-full shadow-xs" style={{ backgroundColor: color }} />
                            <span>J{i + 1}</span>
                          </div>
                        </td>
                        <td className="px-2 py-1">
                          <NumberField
                            value={kpDraft[i] != null ? kpDraft[i] : DEFAULT_KP[i]}
                            min={0}
                            max={1000}
                            step={1}
                            onCommit={(v) => updateKp(i, v)}
                            disabled={!vm.canEdit}
                            className="h-8 text-xs font-mono bg-background border-border/80 focus-visible:ring-1 focus-visible:ring-primary shadow-xs"
                          />
                        </td>
                        <td className="px-2 py-1">
                          <NumberField
                            value={kdDraft[i] != null ? kdDraft[i] : DEFAULT_KD[i]}
                            min={0}
                            max={100}
                            step={0.1}
                            onCommit={(v) => updateKd(i, v)}
                            disabled={!vm.canEdit}
                            className="h-8 text-xs font-mono bg-background border-border/80 focus-visible:ring-1 focus-visible:ring-primary shadow-xs"
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRestoreDialogOpen(true)}
                disabled={!vm.canEdit || vm.savingGains}
                className="gap-1.5 text-xs text-amber-600 hover:text-amber-700 font-medium"
              >
                <RotateCcw className="size-3.5" />
                {t('settings:gains.restoreDefaults')}
              </Button>

              <Button
                size="sm"
                onClick={handleSaveGains}
                disabled={!vm.canEdit || vm.savingGains}
                className="gap-1.5 text-xs font-semibold"
              >
                <Save className="size-3.5" />
                {vm.savingGains ? t('common:saving') : t('settings:gains.saveGainsBtn')}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* 右侧卡片：电机故障清除与急停复位 */}
        <Card className="flex flex-col border shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-lg bg-rose-500/10 text-rose-600">
                <Wrench className="size-4" />
              </div>
              <div>
                <CardTitle className="text-base font-bold">{t('settings:gains.faultsAndEstopTitle')}</CardTitle>
                <CardDescription className="text-xs">
                  {t('settings:gains.faultsAndEstopDesc')}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-4 text-sm justify-between">
            <div className="space-y-4">
              <div className="rounded-lg border bg-muted/20 p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold text-foreground">{t('settings:gains.clearFaults')}</div>
                    <div className="text-[0.71875rem] text-muted-foreground mt-0.5">
                      {t('settings:gains.clearFaultsDesc')}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={vm.clearFaults}
                    disabled={!vm.canEdit}
                    className="gap-1 text-xs shrink-0 font-medium"
                  >
                    <Wrench className="size-3.5" />
                    {t('settings:gains.clearFaultsBtn')}
                  </Button>
                </div>
              </div>

              <div className="rounded-lg border bg-muted/20 p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold text-foreground">{t('settings:gains.clearStop')}</div>
                    <div className="text-[0.71875rem] text-muted-foreground mt-0.5">
                      {t('settings:gains.clearStopDesc')}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={vm.clearStop}
                    disabled={!vm.canEdit}
                    className="gap-1 text-xs text-emerald-600 hover:text-emerald-700 shrink-0 font-medium"
                  >
                    <ShieldCheck className="size-3.5" />
                    {t('settings:gains.clearStopBtn')}
                  </Button>
                </div>
              </div>
            </div>

            <div className="rounded-lg bg-amber-500/10 p-3 text-[11px] text-amber-700 dark:text-amber-400">
              {t('settings:gains.hint')}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 恢复默认增益确认对话框 */}
      <Dialog open={restoreDialogOpen} onOpenChange={setRestoreDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings:gains.restoreConfirmTitle')}</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {t('settings:gains.restoreConfirmDesc')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRestoreDialogOpen(false)}>
              {t('common:cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={handleRestoreDefaults}>
              {t('common:confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { NumberField } from '@/components/ui/number-field'
import { Badge } from '@/components/ui/badge'
import { Scale, Compass, RotateCcw, Save, RefreshCw, AlertCircle, Lock } from 'lucide-react'
import type { SettingsState } from './useSettingsState'
import { JOINT_COLORS } from '@/lib/colors'

const DEFAULT_GRAVITY_SCALE = Array.from({ length: 7 }, () => 1)

export function PayloadPanel({ vm }: { vm: SettingsState }) {
  const { t } = useTranslation(['common', 'settings'])
  // 本地草稿状态
  const [mass, setMass] = useState(vm.payload.mass)
  const [comX, setComX] = useState(vm.payload.comX)
  const [comY, setComY] = useState(vm.payload.comY)
  const [comZ, setComZ] = useState(vm.payload.comZ)

  const [roll, setRoll] = useState(vm.installation.roll)
  const [pitch, setPitch] = useState(vm.installation.pitch)
  const [yaw, setYaw] = useState(vm.installation.yaw)
  const [scaleDraft, setScaleDraft] = useState<number[]>(() => [...DEFAULT_GRAVITY_SCALE])
  // 用户是否改过草稿：改过则后台拉取不再覆盖，避免编辑中途被刷新打断
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (dirty) return
    setMass(vm.payload.mass)
    setComX(vm.payload.comX)
    setComY(vm.payload.comY)
    setComZ(vm.payload.comZ)
  }, [vm.payload, dirty])

  useEffect(() => {
    if (dirty) return
    setRoll(vm.installation.roll)
    setPitch(vm.installation.pitch)
    setYaw(vm.installation.yaw)
  }, [vm.installation, dirty])

  useEffect(() => {
    if (dirty) return
    const v = vm.gravityScale.values
    setScaleDraft(v.length === 7 ? [...v] : [...DEFAULT_GRAVITY_SCALE])
  }, [vm.gravityScale, dirty])

  const commit = (setter: (v: number) => void) => (v: number) => {
    setter(v)
    setDirty(true)
  }

  const handleSavePayload = async () => {
    const ok = await vm.savePayload({
      mass: Number(mass) || 0,
      comX: Number(comX) || 0,
      comY: Number(comY) || 0,
      comZ: Number(comZ) || 0,
    })
    if (ok) setDirty(false)
  }

  const handleSaveRpy = async () => {
    const ok = await vm.saveInstallationRpy(Number(roll) || 0, Number(pitch) || 0, Number(yaw) || 0)
    if (ok) setDirty(false)
  }

  const updateScale = (idx: number, val: number) => {
    setScaleDraft((prev) => {
      const next = [...prev]
      next[idx] = val
      return next
    })
    setDirty(true)
  }

  const resetGravityScale = () => {
    setScaleDraft([...DEFAULT_GRAVITY_SCALE])
    setDirty(true)
  }

  const handleSaveGravityScale = async () => {
    const ok = await vm.saveGravityScale(
      scaleDraft.map((v) => (Number.isFinite(Number(v)) ? Number(v) : 1)),
    )
    if (ok) setDirty(false)
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 严格安全模式提示栏 */}
      {!vm.canEdit && (
        <div className="flex items-center justify-between rounded-lg bg-muted/60 border border-border/80 px-3.5 py-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <Lock className="size-4 text-muted-foreground" />
            <span>严格安全锁定：控制器未连接，末端负载与重力补偿处于只读模式。请连接机械臂。</span>
          </div>
        </div>
      )}

      {/* 顶部草稿提示 */}
      {dirty && (
        <div className="flex items-center justify-between rounded-lg bg-amber-500/10 border border-amber-500/30 px-3.5 py-2 text-xs text-amber-800 dark:text-amber-300">
          <div className="flex items-center gap-2">
            <AlertCircle className="size-4 text-amber-600 dark:text-amber-400" />
            <span>负载、安装位姿或重力标定参数已在本地修改（草稿未保存），点击右下角按钮即可下发并写盘保存。</span>
          </div>
          <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-300">
            草稿待保存
          </Badge>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 末端负载卡片 */}
        <Card className="flex flex-col border shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Scale className="size-4" />
                </div>
                <div>
                  <CardTitle className="text-base font-bold">{t('settings:payload.title')}</CardTitle>
                  <CardDescription className="text-xs">
                    {t('settings:payload.description')}
                  </CardDescription>
                </div>
              </div>
              <Button
                variant="outline"
                size="icon-sm"
                onClick={vm.fetchPayload}
                disabled={!vm.canEdit || vm.loadingPayload}
                title={t('common:refresh')}
              >
                <RefreshCw className={`size-3.5 ${vm.loadingPayload ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-4 text-sm justify-between">
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{t('settings:payload.mass')}</label>
                  <NumberField
                    value={mass}
                    onCommit={commit(setMass)}
                    min={0}
                    max={5}
                    step={0.01}
                    disabled={!vm.canEdit}
                    className="mt-1 font-mono text-sm bg-background border-border/80 focus-visible:ring-1 focus-visible:ring-primary shadow-xs"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{t('settings:payload.presets')}</label>
                  <div className="mt-1 flex gap-1.5">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="h-9 flex-1 text-xs font-medium"
                      onClick={() => {
                        setMass(0)
                        setDirty(true)
                      }}
                      disabled={!vm.canEdit}
                    >
                      {t('settings:payload.noPayload')}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="h-9 flex-1 text-xs font-medium"
                      onClick={() => {
                        setMass(0.25)
                        setDirty(true)
                      }}
                      disabled={!vm.canEdit}
                    >
                      0.25kg
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="h-9 flex-1 text-xs font-medium"
                      onClick={() => {
                        setMass(0.5)
                        setDirty(true)
                      }}
                      disabled={!vm.canEdit}
                    >
                      0.5kg
                    </Button>
                  </div>
                </div>
              </div>

              <div className="space-y-1.5 rounded-lg border bg-muted/20 p-3">
                <div className="text-xs font-semibold text-foreground">{t('settings:payload.comTitle')}</div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="font-mono text-[0.6875rem] text-muted-foreground">COM X</label>
                    <NumberField
                      value={comX}
                      onCommit={commit(setComX)}
                      min={-1}
                      max={1}
                      step={0.005}
                      disabled={!vm.canEdit}
                      className="mt-0.5 font-mono text-xs bg-background border-border/80 focus-visible:ring-1 focus-visible:ring-primary shadow-xs"
                    />
                  </div>
                  <div>
                    <label className="font-mono text-[0.6875rem] text-muted-foreground">COM Y</label>
                    <NumberField
                      value={comY}
                      onCommit={commit(setComY)}
                      min={-1}
                      max={1}
                      step={0.005}
                      disabled={!vm.canEdit}
                      className="mt-0.5 font-mono text-xs bg-background border-border/80 focus-visible:ring-1 focus-visible:ring-primary shadow-xs"
                    />
                  </div>
                  <div>
                    <label className="font-mono text-[0.6875rem] text-muted-foreground">COM Z</label>
                    <NumberField
                      value={comZ}
                      onCommit={commit(setComZ)}
                      min={-1}
                      max={1}
                      step={0.005}
                      disabled={!vm.canEdit}
                      className="mt-0.5 font-mono text-xs bg-background border-border/80 focus-visible:ring-1 focus-visible:ring-primary shadow-xs"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <Button
                onClick={handleSavePayload}
                disabled={!vm.canEdit || vm.savingPayload}
                className="gap-1.5 font-semibold text-xs"
              >
                <Save className="size-3.5" />
                {vm.savingPayload ? t('settings:payload.saving') : t('settings:payload.saveBtn')}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* 安装位姿与重力补偿卡片 */}
        <Card className="flex flex-col border shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="flex size-8 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600">
                  <Compass className="size-4" />
                </div>
                <div>
                  <CardTitle className="text-base font-bold">{t('settings:payload.installationTitle')}</CardTitle>
                  <CardDescription className="text-xs">
                    {t('settings:payload.installationDesc')}
                  </CardDescription>
                </div>
              </div>
              <Button
                variant="outline"
                size="icon-sm"
                onClick={vm.fetchInstallation}
                disabled={!vm.canEdit || vm.loadingInstallation}
                title={t('common:refresh')}
              >
                <RefreshCw className={`size-3.5 ${vm.loadingInstallation ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-4 text-sm justify-between">
            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground">{t('settings:payload.baseRpy')}</label>
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1.5 text-[0.6875rem]"
                      onClick={() => {
                        setRoll(0)
                        setPitch(0)
                        setYaw(0)
                        setDirty(true)
                      }}
                      disabled={!vm.canEdit}
                    >
                      {t('settings:payload.standardInstall')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1.5 text-[0.6875rem]"
                      onClick={() => {
                        setRoll(Math.PI)
                        setPitch(0)
                        setYaw(0)
                        setDirty(true)
                      }}
                      disabled={!vm.canEdit}
                    >
                      {t('settings:payload.invertedInstall')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1.5 text-[0.6875rem]"
                      onClick={() => {
                        setRoll(0)
                        setPitch(Math.PI / 2)
                        setYaw(0)
                        setDirty(true)
                      }}
                      disabled={!vm.canEdit}
                    >
                      {t('settings:payload.sideInstall')}
                    </Button>
                  </div>
                </div>
                <div className="mt-1.5 grid grid-cols-3 gap-2">
                  <div>
                    <label className="font-mono text-[0.6875rem] text-muted-foreground">{t('settings:payload.roll')}</label>
                    <NumberField
                      value={roll}
                      onCommit={commit(setRoll)}
                      min={-6.2832}
                      max={6.2832}
                      step={0.05}
                      disabled={!vm.canEdit}
                      className="mt-0.5 font-mono text-xs bg-background border-border/80 focus-visible:ring-1 focus-visible:ring-primary shadow-xs"
                    />
                  </div>
                  <div>
                    <label className="font-mono text-[0.6875rem] text-muted-foreground">{t('settings:payload.pitch')}</label>
                    <NumberField
                      value={pitch}
                      onCommit={commit(setPitch)}
                      min={-6.2832}
                      max={6.2832}
                      step={0.05}
                      disabled={!vm.canEdit}
                      className="mt-0.5 font-mono text-xs bg-background border-border/80 focus-visible:ring-1 focus-visible:ring-primary shadow-xs"
                    />
                  </div>
                  <div>
                    <label className="font-mono text-[0.6875rem] text-muted-foreground">{t('settings:payload.yaw')}</label>
                    <NumberField
                      value={yaw}
                      onCommit={commit(setYaw)}
                      min={-6.2832}
                      max={6.2832}
                      step={0.05}
                      disabled={!vm.canEdit}
                      className="mt-0.5 font-mono text-xs bg-background border-border/80 focus-visible:ring-1 focus-visible:ring-primary shadow-xs"
                    />
                  </div>
                </div>
                <div className="mt-2 flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleSaveRpy}
                    disabled={!vm.canEdit || vm.savingInstallation}
                    className="h-8 gap-1 text-xs font-medium"
                  >
                    <Save className="size-3.5" />
                    {t('settings:payload.updateRpy')}
                  </Button>
                </div>
              </div>

              <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-foreground">
                      {t('settings:payload.gravityScaleTitle')}
                    </div>
                    <div className="mt-0.5 text-[0.6875rem] leading-relaxed text-muted-foreground">
                      {t('settings:payload.gravityScaleDesc')}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {vm.gravityScale.easing && (
                      <Badge variant="outline" className="gap-1 border-blue-500/40 text-[0.625rem] text-blue-600 dark:text-blue-300">
                        <span className="size-1.5 rounded-full bg-blue-500 animate-pulse" />
                        {t('settings:payload.easingHint')}
                      </Badge>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      onClick={vm.fetchGravityScale}
                      disabled={!vm.canEdit || vm.loadingGravityScale}
                      title={t('common:refresh')}
                    >
                      <RefreshCw className={`size-3 ${vm.loadingGravityScale ? 'animate-spin' : ''}`} />
                    </Button>
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-7">
                  {Array.from({ length: 7 }, (_, i) => (
                    <div key={i} className="min-w-0">
                      <div className="flex items-center justify-center gap-1 pb-0.5">
                        <span className="size-1.5 rounded-full" style={{ backgroundColor: JOINT_COLORS[i] }} />
                        <label className="font-mono text-[0.625rem] text-muted-foreground">J{i + 1}</label>
                      </div>
                      <NumberField
                        value={scaleDraft[i]}
                        onCommit={(v) => updateScale(i, v)}
                        min={0}
                        max={10}
                        step={0.05}
                        disabled={!vm.canEdit}
                        className="h-8 w-full font-mono text-xs bg-background border-border/80 focus-visible:ring-1 focus-visible:ring-primary shadow-xs"
                      />
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-between gap-2 pt-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-1.5 text-[0.6875rem] text-muted-foreground"
                    onClick={resetGravityScale}
                    disabled={!vm.canEdit}
                  >
                    <RotateCcw className="mr-1 size-3" />
                    {t('settings:payload.resetScale')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleSaveGravityScale}
                    disabled={!vm.canEdit || vm.savingGravityScale}
                    className="h-8 gap-1 text-xs font-medium"
                  >
                    <Save className="size-3.5" />
                    {vm.savingGravityScale ? t('settings:payload.saving') : t('settings:payload.applyGravityScale')}
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

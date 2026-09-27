import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { NumberField } from '@/components/ui/number-field'
import { Badge } from '@/components/ui/badge'
import { ShieldCheck, ShieldAlert, RefreshCw, Layers, Save, CheckCircle2, AlertCircle, Lock } from 'lucide-react'
import type { SettingsState } from './useSettingsState'
import { JOINT_COLORS } from '@/lib/colors'

// 默认 7 轴软限位与偏置 fallback
const DEFAULT_LIMITS = [
  [-2.8, 2.8],
  [-1.8, 1.8],
  [-2.8, 2.8],
  [-2.0, 2.0],
  [-2.8, 2.8],
  [-1.8, 1.8],
  [-3.14, 3.14],
]

export function SafetyLimitsPanel({ vm }: { vm: SettingsState }) {
  const { t } = useTranslation(['common', 'settings'])

  // 1. 本地草稿状态：关节限位 (min / max) 与零点偏置
  const [limitsDraft, setLimitsDraft] = useState<{ min: number; max: number }[]>(() =>
    DEFAULT_LIMITS.map(([min, max]) => ({ min, max })),
  )
  const [offsetsDraft, setOffsetsDraft] = useState<number[]>(() => Array(7).fill(0))

  // 2. 本地草稿状态：笛卡尔限幅
  const [linearVel, setLinearVel] = useState<number>(1.0)
  const [angularVel, setAngularVel] = useState<number>(1.0)
  const [linearAcc, setLinearAcc] = useState<number>(2.0)
  const [angularAcc, setAngularAcc] = useState<number>(2.0)

  // 3. 本地草稿状态：碰撞检测
  const [collisionEnabled, setCollisionEnabled] = useState<boolean>(false)
  const [collisionSensitivity, setCollisionSensitivity] = useState<number>(1.0)

  // 草稿修改标记
  const [dirty, setDirty] = useState(false)

  // 从后台获取最新值同步至本地草稿（未被编辑修改时）
  useEffect(() => {
    if (dirty) return

    // 同步关节限位
    if (vm.jointLimits?.limits && Array.isArray(vm.jointLimits.limits)) {
      const parsed = vm.jointLimits.limits.map((item, i) => {
        const fallback = DEFAULT_LIMITS[i] || [-3.14, 3.14]
        if (Array.isArray(item)) return { min: Number(item[0]) || fallback[0], max: Number(item[1]) || fallback[1] }
        return { min: Number(item?.min) || fallback[0], max: Number(item?.max) || fallback[1] }
      })
      setLimitsDraft(parsed)
    }

    // 同步零点偏置
    if (vm.zeroOffsets?.offsets && Array.isArray(vm.zeroOffsets.offsets)) {
      setOffsetsDraft(vm.zeroOffsets.offsets.map((v) => Number(v) || 0))
    }

    // 同步笛卡尔限幅
    if (vm.cartesianLimits) {
      const cl = vm.cartesianLimits
      if (cl.linear_velocity != null) setLinearVel(Number(cl.linear_velocity) || 1.0)
      if (cl.angular_velocity != null) setAngularVel(Number(cl.angular_velocity) || 1.0)
      if (cl.linear_acceleration != null) setLinearAcc(Number(cl.linear_acceleration) || 2.0)
      if (cl.angular_acceleration != null) setAngularAcc(Number(cl.angular_acceleration) || 2.0)
    }

    // 同步碰撞检测
    if (vm.collisionConfig) {
      const cc = vm.collisionConfig
      if (cc.enabled != null) setCollisionEnabled(Boolean(cc.enabled))
      if (cc.sensitivity != null) setCollisionSensitivity(Number(cc.sensitivity) || 1.0)
    }
  }, [vm.jointLimits, vm.zeroOffsets, vm.cartesianLimits, vm.collisionConfig, dirty])

  // 更新单个关节限位
  const updateJointLimit = (index: number, key: 'min' | 'max', value: number) => {
    setLimitsDraft((prev) => {
      const next = [...prev]
      next[index] = { ...next[index], [key]: value }
      return next
    })
    setDirty(true)
  }

  // 更新单个关节零点偏置
  const updateJointOffset = (index: number, value: number) => {
    setOffsetsDraft((prev) => {
      const next = [...prev]
      next[index] = value
      return next
    })
    setDirty(true)
  }

  // 保存关节限位与偏置
  const handleSaveJointSafety = async () => {
    const limitsPayload = {
      limits: limitsDraft.map((l) => [l.min, l.max]),
    }
    const offsetsPayload = {
      offsets: offsetsDraft,
    }
    const [ok1, ok2] = await Promise.all([
      vm.saveJointLimits(limitsPayload),
      vm.saveZeroOffsets(offsetsPayload),
    ])
    if (ok1 && ok2) setDirty(false)
  }

  // 保存笛卡尔与碰撞配置
  const handleSaveCartesianAndCollision = async () => {
    const cartesianPayload = {
      linear_velocity: linearVel,
      angular_velocity: angularVel,
      linear_acceleration: linearAcc,
      angular_acceleration: angularAcc,
    }
    const collisionPayload = {
      enabled: collisionEnabled,
      sensitivity: collisionSensitivity,
    }
    const [ok1, ok2] = await Promise.all([
      vm.saveCartesianLimits(cartesianPayload),
      vm.saveCollisionConfig(collisionPayload),
    ])
    if (ok1 && ok2) setDirty(false)
  }

  // 保存全部安全配置
  const handleSaveAllSafety = async () => {
    const results = await Promise.all([
      vm.saveJointLimits({ limits: limitsDraft.map((l) => [l.min, l.max]) }),
      vm.saveZeroOffsets({ offsets: offsetsDraft }),
      vm.saveCartesianLimits({
        linear_velocity: linearVel,
        angular_velocity: angularVel,
        linear_acceleration: linearAcc,
        angular_acceleration: angularAcc,
      }),
      vm.saveCollisionConfig({
        enabled: collisionEnabled,
        sensitivity: collisionSensitivity,
      }),
    ])
    if (results.every(Boolean)) {
      setDirty(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 严格安全模式提示栏 */}
      {!vm.canEdit && (
        <div className="flex items-center justify-between rounded-lg bg-muted/60 border border-border/80 px-3.5 py-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <Lock className="size-4 text-muted-foreground" />
            <span>严格安全锁定：控制器未连接，当前处于只读模式。请连接机械臂。</span>
          </div>
        </div>
      )}

      {/* 草稿待保存提示栏 */}
      {dirty && (
        <div className="flex items-center justify-between rounded-lg bg-amber-500/10 border border-amber-500/30 px-3.5 py-2 text-xs text-amber-800 dark:text-amber-300">
          <div className="flex items-center gap-2">
            <AlertCircle className="size-4 text-amber-600 dark:text-amber-400" />
            <span>参数已在本地修改（草稿未保存），点击右下角按钮即可下发并写盘保存。</span>
          </div>
          <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-300">
            草稿待保存
          </Badge>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 左侧卡片：7 轴软限位与零点偏移微调 */}
        <Card className="flex flex-col border shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="flex size-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600">
                  <ShieldCheck className="size-4" />
                </div>
                <div>
                  <CardTitle className="text-base font-bold">{t('settings:safety.title')}</CardTitle>
                  <CardDescription className="text-xs">
                    {t('settings:safety.description')}
                  </CardDescription>
                </div>
              </div>
              <Button
                variant="outline"
                size="icon-sm"
                onClick={vm.fetchLimits}
                disabled={!vm.canEdit || vm.loadingLimits}
                title={t('common:refresh')}
              >
                <RefreshCw className={`size-3.5 ${vm.loadingLimits ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col justify-between gap-4 text-sm">
            <div className="overflow-hidden rounded-lg border bg-card">
              <table className="w-full text-left text-xs">
                <thead className="border-b bg-muted/60 font-medium text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 w-16">{t('settings:safety.colJoint')}</th>
                    <th className="px-3 py-2 font-mono">{t('settings:safety.colMin')}</th>
                    <th className="px-3 py-2 font-mono">{t('settings:safety.colMax')}</th>
                    <th className="px-3 py-2 font-mono">{t('settings:safety.colOffset')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {Array.from({ length: 7 }, (_, i) => {
                    const lim = limitsDraft[i] || { min: -3.14, max: 3.14 }
                    const off = offsetsDraft[i] != null ? offsetsDraft[i] : 0
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
                            value={lim.min}
                            min={-6.28}
                            max={lim.max - 0.01}
                            step={0.01}
                            onCommit={(v) => updateJointLimit(i, 'min', v)}
                            disabled={!vm.canEdit}
                            className="h-8 text-xs font-mono bg-background border-border/80 focus-visible:ring-1 focus-visible:ring-primary shadow-xs"
                          />
                        </td>
                        <td className="px-2 py-1">
                          <NumberField
                            value={lim.max}
                            min={lim.min + 0.01}
                            max={6.28}
                            step={0.01}
                            onCommit={(v) => updateJointLimit(i, 'max', v)}
                            disabled={!vm.canEdit}
                            className="h-8 text-xs font-mono bg-background border-border/80 focus-visible:ring-1 focus-visible:ring-primary shadow-xs"
                          />
                        </td>
                        <td className="px-2 py-1">
                          <NumberField
                            value={off}
                            min={-3.14}
                            max={3.14}
                            step={0.005}
                            onCommit={(v) => updateJointOffset(i, v)}
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
              <div className="text-[11px] text-muted-foreground">{t('settings:safety.hint')}</div>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleSaveJointSafety}
                disabled={!vm.canEdit || vm.savingLimits}
                className="gap-1.5 text-xs font-medium"
              >
                <Save className="size-3.5" />
                {t('settings:safety.saveLimits')}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* 右侧卡片：笛卡尔空间限幅与碰撞安全设置 */}
        <Card className="flex flex-col border shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="flex size-8 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600">
                  <ShieldAlert className="size-4" />
                </div>
                <div>
                  <CardTitle className="text-base font-bold">{t('settings:safety.cartesianTitle')}</CardTitle>
                  <CardDescription className="text-xs">
                    {t('settings:safety.cartesianDesc')}
                  </CardDescription>
                </div>
              </div>
              <Button
                variant="outline"
                size="icon-sm"
                onClick={vm.fetchLimits}
                disabled={!vm.canEdit || vm.loadingLimits}
                title={t('common:refresh')}
              >
                <RefreshCw className={`size-3.5 ${vm.loadingLimits ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col justify-between gap-4 text-sm">
            <div className="space-y-4">
              {/* 笛卡尔限幅参数 */}
              <div className="rounded-lg border bg-muted/20 p-3.5 space-y-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  <Layers className="size-3.5 text-primary" /> {t('settings:safety.cartesianSpaceLimits')}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-muted-foreground">
                      {t('settings:safety.linearVel')}
                    </label>
                    <NumberField
                      value={linearVel}
                      min={0.01}
                      max={5.0}
                      step={0.05}
                      onCommit={(v) => {
                        setLinearVel(v)
                        setDirty(true)
                      }}
                      disabled={!vm.canEdit}
                      className="h-8 text-xs font-mono bg-background border-border/80 focus-visible:ring-1 focus-visible:ring-primary shadow-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-muted-foreground">
                      {t('settings:safety.angularVel')}
                    </label>
                    <NumberField
                      value={angularVel}
                      min={0.01}
                      max={10.0}
                      step={0.1}
                      onCommit={(v) => {
                        setAngularVel(v)
                        setDirty(true)
                      }}
                      disabled={!vm.canEdit}
                      className="h-8 text-xs font-mono bg-background border-border/80 focus-visible:ring-1 focus-visible:ring-primary shadow-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-muted-foreground">
                      {t('settings:safety.linearAcc')}
                    </label>
                    <NumberField
                      value={linearAcc}
                      min={0.1}
                      max={20.0}
                      step={0.1}
                      onCommit={(v) => {
                        setLinearAcc(v)
                        setDirty(true)
                      }}
                      disabled={!vm.canEdit}
                      className="h-8 text-xs font-mono bg-background border-border/80 focus-visible:ring-1 focus-visible:ring-primary shadow-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-muted-foreground">
                      {t('settings:safety.angularAcc')}
                    </label>
                    <NumberField
                      value={angularAcc}
                      min={0.1}
                      max={30.0}
                      step={0.5}
                      onCommit={(v) => {
                        setAngularAcc(v)
                        setDirty(true)
                      }}
                      disabled={!vm.canEdit}
                      className="h-8 text-xs font-mono bg-background border-border/80 focus-visible:ring-1 focus-visible:ring-primary shadow-xs"
                    />
                  </div>
                </div>
              </div>

              {/* 碰撞检测配置 */}
              <div className="rounded-lg border bg-muted/20 p-3.5 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                    <ShieldAlert className="size-3.5 text-amber-600" /> {t('settings:safety.collisionConfig')}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant={collisionEnabled ? 'default' : 'outline'}
                      size="sm"
                      className="h-7 text-xs px-2.5 font-medium transition-all"
                      onClick={() => {
                        setCollisionEnabled((prev) => !prev)
                        setDirty(true)
                      }}
                      disabled={!vm.canEdit}
                    >
                      {collisionEnabled ? '已开启安全监测' : '未开启 (默认模式)'}
                    </Button>
                  </div>
                </div>

                <div className="space-y-1.5 pt-1">
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>{t('settings:safety.sensitivity')}</span>
                    <span className="font-mono font-semibold text-foreground">{collisionSensitivity.toFixed(2)}</span>
                  </div>
                  <NumberField
                    value={collisionSensitivity}
                    min={0.1}
                    max={5.0}
                    step={0.1}
                    onCommit={(v) => {
                      setCollisionSensitivity(v)
                      setDirty(true)
                    }}
                    disabled={!vm.canEdit}
                    className="h-8 text-xs font-mono bg-background border-border/80 focus-visible:ring-1 focus-visible:ring-primary shadow-xs"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end pt-1">
              <Button
                variant="secondary"
                size="sm"
                onClick={handleSaveCartesianAndCollision}
                disabled={!vm.canEdit || vm.savingLimits}
                className="gap-1.5 text-xs font-medium"
              >
                <Save className="size-3.5" />
                {t('settings:safety.saveCartesian')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 底部全量保存栏 */}
      <div className="flex items-center justify-between rounded-xl border bg-card p-4 shadow-xs">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <CheckCircle2 className="size-4 text-emerald-600 shrink-0" />
          <span>保存后参数将立即同步至控制器限幅层与软安全监视器</span>
        </div>
        <Button
          size="sm"
          onClick={handleSaveAllSafety}
          disabled={!vm.canEdit || vm.savingLimits}
          className="gap-1.5 text-xs font-semibold"
        >
          <Save className="size-3.5" />
          {vm.savingLimits ? t('common:saving') : t('settings:safety.saveAllSafety')}
        </Button>
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Wrench,
  RefreshCw,
  Power,
  PowerOff,
  Lock,
} from 'lucide-react'
import type { SettingsState } from './useSettingsState'

export function EndEffectorPanel({ vm }: { vm: SettingsState }) {
  const { t } = useTranslation(['common', 'settings'])

  // 当前选中的末端类别与型号
  const [selectedCategory, setSelectedCategory] = useState('')
  const [selectedSubtype, setSelectedSubtype] = useState('')
  const [selectedCanIface, setSelectedCanIface] = useState('can0')

  const deviceTypes = vm.deviceTypes
  const active = vm.activeDevice
  const isMounted = active?.configured && active?.enabled
  const activeCategory = active?.category ?? ''
  const activeSubtype = active?.subtype ?? ''
  const activeCanIface = active?.can_iface ?? ''

  // 型号列表只来自服务端。默认选中：已挂载设备的型号（便于“重新挂载”），
  // 否则选中列表第一项；不再内置写死 linkerhand / litegrip。
  useEffect(() => {
    if (deviceTypes.length === 0) return
    const mountedType = isMounted
      ? deviceTypes.find((d) => d.category === activeCategory && d.subtype === activeSubtype)
      : undefined
    const preferred = mountedType ?? deviceTypes[0]
    setSelectedCategory(preferred.category)
    setSelectedSubtype(preferred.subtype)
    if (isMounted && activeCanIface) {
      setSelectedCanIface(activeCanIface)
    }
  }, [deviceTypes, isMounted, activeCategory, activeSubtype, activeCanIface])

  const categories = [...new Set(deviceTypes.map((d) => d.category))].sort((a, b) => {
    const order = ['gripper', 'hand']
    const ai = order.indexOf(a)
    const bi = order.indexOf(b)
    return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi)
  })

  const categoryLabel = (category: string) => {
    if (category === 'gripper') return t('settings:endEffector.deviceCatGripper')
    if (category === 'hand') return t('settings:endEffector.deviceCatHand')
    return category
  }

  const handleMount = async () => {
    await vm.connectDevice(selectedCategory, selectedSubtype, selectedCanIface)
  }

  const handleUnmount = async () => {
    await vm.disconnectDevice(active?.device_id || 'end_0')
  }

  return (
    <div className="flex flex-col gap-4 w-full">
      {/* 严格安全模式提示栏 */}
      {!vm.canEdit && (
        <div className="flex items-center justify-between rounded-lg bg-muted/60 border border-border/80 px-3.5 py-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <Lock className="size-4 text-muted-foreground" />
            <span>严格安全锁定：控制器未连接，末端设备处于只读保护状态。请连接机械臂。</span>
          </div>
        </div>
      )}

      {/* 原本单卡片直接拉伸满宽 (w-full) */}
      <Card className="flex flex-col border shadow-sm w-full">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Wrench className="size-4" />
              </div>
              <div>
                <CardTitle className="text-base font-bold">{t('settings:endEffector.mountTitle')}</CardTitle>
                <CardDescription className="text-xs">
                  {t('settings:endEffector.mountDesc')}
                </CardDescription>
              </div>
            </div>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={vm.fetchDeviceStatus}
              disabled={!vm.canEdit || vm.loadingDevice}
              title={t('common:refresh')}
            >
              <RefreshCw className={`size-3.5 ${vm.loadingDevice ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-4 text-sm justify-between">
          <div className="space-y-4">
            {/* 当前激活设备状态 Banner */}
            <div className="flex items-center justify-between rounded-xl border bg-muted/20 p-3.5">
              <div className="flex items-center gap-2.5">
                <div className={`flex size-3 rounded-full ${isMounted ? (active?.online ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500') : 'bg-muted-foreground/50'}`} />
                <div>
                  <div className="text-xs font-semibold text-foreground">
                    {isMounted
                      ? t('settings:endEffector.mountedStatus', { subtype: active?.subtype })
                      : t('settings:endEffector.notMounted')}
                  </div>
                  <div className="text-[11px] text-muted-foreground font-mono">
                    {isMounted
                      ? t('settings:endEffector.interfaceStatus', {
                          iface: active?.can_iface || 'can0',
                          status: active?.online ? t('settings:endEffector.statusOnline') : t('settings:endEffector.statusOffline'),
                        })
                      : t('settings:endEffector.selectAndMountHint')}
                  </div>
                </div>
              </div>
              {isMounted && (
                <Badge variant={active?.online ? 'success' : 'outline'} className="text-[10px] font-mono">
                  {active?.online ? 'ONLINE' : 'OFFLINE'}
                </Badge>
              )}
            </div>

            {/* 设备类型与型号选择 */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">
                {t('settings:endEffector.deviceType')}
              </label>
              {deviceTypes.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                  <div className="font-medium">{t('settings:endEffector.noDeviceTypes')}</div>
                  <div className="mt-1 text-[11px]">{t('settings:endEffector.noDeviceTypesDesc')}</div>
                </div>
              ) : (
                <div className="space-y-3">
                  {categories.map((category) => (
                    <div key={category} className="space-y-1.5">
                      <div className="text-[11px] font-semibold text-muted-foreground">
                        {categoryLabel(category)}
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        {deviceTypes
                          .filter((d) => d.category === category)
                          .map((type) => {
                            const selected =
                              selectedCategory === type.category &&
                              selectedSubtype === type.subtype
                            return (
                              <button
                                key={`${type.category}/${type.subtype}`}
                                type="button"
                                disabled={!vm.canEdit}
                                onClick={() => {
                                  setSelectedCategory(type.category)
                                  setSelectedSubtype(type.subtype)
                                }}
                                className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-all ${
                                  selected
                                    ? 'border-primary bg-primary/5 text-foreground ring-1 ring-primary'
                                    : 'border-border bg-card text-muted-foreground hover:border-primary/50'
                                }`}
                              >
                                <div className="flex items-center gap-1.5 font-bold text-xs">
                                  <span>{type.icon || '🔧'}</span>
                                  <span>{type.name || type.subtype}</span>
                                </div>
                                {(type.model || type.vendor) && (
                                  <span className="text-[10px] text-muted-foreground">
                                    {[type.model, type.vendor].filter(Boolean).join(' · ')}
                                  </span>
                                )}
                              </button>
                            )
                          })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* CAN 总线接口配置 */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">
                {t('settings:endEffector.canIface')}
              </label>
              <div className="grid grid-cols-3 gap-2">
                {['can0', 'can1', 'can2'].map((iface) => (
                  <Button
                    key={iface}
                    type="button"
                    variant={selectedCanIface === iface ? 'default' : 'outline'}
                    size="sm"
                    disabled={!vm.canEdit}
                    onClick={() => setSelectedCanIface(iface)}
                    className="h-8 text-xs font-mono"
                  >
                    {iface}
                  </Button>
                ))}
              </div>
            </div>
          </div>

          {/* 挂载与卸载操作栏 */}
          <div className="flex items-center justify-between pt-2 border-t">
            <span className="text-[11px] text-muted-foreground">
              {isMounted ? t('settings:endEffector.persistedHint') : t('settings:endEffector.autoStartHint')}
            </span>
            <div className="flex items-center gap-2">
              {isMounted && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleUnmount}
                  disabled={!vm.canEdit || vm.connectingDevice}
                  className="gap-1.5 text-xs text-destructive hover:text-destructive font-medium"
                >
                  <PowerOff className="size-3.5" />
                  {t('settings:endEffector.unmount')}
                </Button>
              )}
              <Button
                size="sm"
                onClick={handleMount}
                disabled={!vm.canEdit || vm.connectingDevice || !selectedSubtype}
                className="gap-1.5 text-xs font-semibold"
              >
                <Power className="size-3.5" />
                {vm.connectingDevice
                  ? t('common:saving')
                  : isMounted
                    ? t('settings:endEffector.remount')
                    : t('settings:endEffector.mount')}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

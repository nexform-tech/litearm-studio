import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, FolderOpen, RefreshCw, ScanLine, Upload } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { NumberField } from '@/components/ui/number-field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Toggle } from '@/components/ui/toggle'
import { useGripperSettings, TRAVEL_MAX_MM, TRAVEL_MIN_MM } from './useGripperSettings'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[0.6875rem] font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

/**
 * 设置页里的夹爪段（§6.2）：这一路 CAN 接口上的 LiteGrip 怎么接、用哪份标定。
 *
 * 只做配置。操作夹爪（张开/闭合/夹取/急停）在夹爪页，两处共用同一个客户端。
 */
export function GripperSection() {
  const { t } = useTranslation(['common', 'gripper'])
  const vm = useGripperSettings()
  const [picking, setPicking] = useState(false)
  const [writingZero, setWritingZero] = useState(false)

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4 rounded-[0.875rem] p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-foreground">{t('gripper:settings.title')}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('gripper:settings.description')}</p>
          </div>
          <Badge
            id="gripper-settings-status"
            data-testid="gripper-settings-status"
            variant={vm.connected ? 'success' : 'outline'}
            className="h-auto flex-none rounded-full px-2.5 py-0.5 text-[0.71875rem] font-semibold"
          >
            {vm.present
              ? vm.connected
                ? t('common:connected')
                : t('common:disconnected')
              : t('common:statusOffline')}
          </Badge>
        </div>

        {!vm.present ? (
          <p className="rounded-lg border border-line bg-muted/40 px-3 py-2 text-[0.71875rem] text-muted-foreground">
            {t('gripper:connection.noSession')}
          </p>
        ) : null}

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Field label={t('gripper:settings.channel')}>
            <Select value={vm.channel} onValueChange={vm.setChannel}>
              <SelectTrigger id="gripper-channel" data-testid="gripper-channel">
                {/* 内核枚举到的接口；一个都没有时仍显示当前配置，便于排查 */}
                <SelectValue placeholder={vm.conn?.channel || '—'} />
              </SelectTrigger>
              <SelectContent>
                {(vm.channels.length ? vm.channels : [vm.conn?.channel || 'can0']).map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('gripper:settings.canId')}>
            <NumberField
              value={vm.canId}
              min={0}
              max={0x7ff}
              step={1}
              onCommit={vm.setCanId}
            />
          </Field>
          <Field label={t('gripper:settings.mstId')}>
            <NumberField
              value={vm.mstId ?? 0}
              min={0}
              max={0x7ff}
              step={1}
              onCommit={(v) => vm.setMstId(v === 0 ? null : v)}
            />
          </Field>
          {/* 行程不再是"实测"要填的东西，而是 mm/rad 换算的分母：由它和标定角度
              定出每 rad 多少毫米，所以它随配置卡一起提交。 */}
          <Field label={t('gripper:settings.travel')}>
            <NumberField
              value={vm.travel}
              min={TRAVEL_MIN_MM}
              max={TRAVEL_MAX_MM}
              step={0.5}
              onCommit={vm.setTravel}
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            id="gripper-apply"
            data-testid="gripper-apply"
            size="sm"
            disabled={!vm.present || vm.applying}
            onClick={() => void vm.apply()}
          >
            <RefreshCw className={vm.applying ? 'size-3.5 animate-spin' : 'size-3.5'} />
            {vm.applying ? t('gripper:settings.applying') : t('gripper:settings.apply')}
          </Button>
          {!vm.connected ? (
            <span className="text-[0.6875rem] text-muted-foreground">{t('gripper:settings.needsDisconnect')}</span>
          ) : null}
          {/* 声明恒为正向：这句话说的是设备**实际**在跑的方向，不一致时提醒接线。 */}
          {vm.conn && vm.conn.mount !== vm.mount ? (
            <span id="gripper-effective-mount" data-testid="gripper-effective-mount" className="text-[0.6875rem] text-warn">
              {t('gripper:settings.effectiveMount', {
                mount: t(`gripper:connection.mount${vm.conn.mount === 'reverse' ? 'Reverse' : 'Normal'}`),
              })}
            </span>
          ) : null}
        </div>
        <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">{t('gripper:settings.travelDesc')}</p>
      </Card>

      <Card className="flex flex-col gap-3 rounded-[0.875rem] p-5">
        <div>
          <h2 className="text-sm font-bold text-foreground">{t('gripper:settings.import')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('gripper:settings.importDesc')}</p>
        </div>

        <div className="flex gap-2">
          <Input
            id="gripper-import-path"
            data-testid="gripper-import-path"
            value={vm.importPath}
            placeholder={t('gripper:settings.importPlaceholder')}
            spellCheck={false}
            onChange={(e) => vm.setImportPath(e.target.value)}
          />
          <Button
            id="gripper-import-browse"
            data-testid="gripper-import-browse"
            size="sm"
            variant="outline"
            // 选文件是文件系统问题，免连接；导入才需要连接。对话框由**本地程序**弹
            // （原生打开对话框），所以它必须在场（`present`）。
            disabled={!vm.present || picking}
            onClick={() => {
              setPicking(true)
              void vm.pickCalibration().finally(() => setPicking(false))
            }}
          >
            <FolderOpen className="size-3.5" />
            {t('gripper:settings.browse')}
          </Button>
          <Button
            id="gripper-import"
            data-testid="gripper-import"
            size="sm"
            variant="outline"
            disabled={!vm.connected || vm.importPath.trim() === ''}
            onClick={() => void vm.importCalibration()}
          >
            <Upload className="size-3.5" />
            {t('common:import')}
          </Button>
        </div>
      </Card>

      <Card className="flex flex-col gap-3 rounded-[0.875rem] p-5">
        <div>
          <h2 className="text-sm font-bold text-foreground">{t('gripper:writeZero.title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('gripper:writeZero.desc')}</p>
        </div>

        <div className="flex items-center gap-3">
          <Button
            id="gripper-write-zero"
            data-testid="gripper-write-zero"
            size="sm"
            disabled={!vm.connected || !vm.enabled || writingZero}
            onClick={() => {
              setWritingZero(true)
              void vm.writeZero().finally(() => setWritingZero(false))
            }}
          >
            <ScanLine className="size-3.5" />
            {writingZero ? t('gripper:writeZero.running') : t('gripper:writeZero.button')}
          </Button>
          {vm.state ? (
            <span className="text-[0.6875rem] text-muted-foreground">
              {t('gripper:writeZero.current', {
                pos: vm.state.positionMm == null ? t('gripper:readout.unknown') : `${vm.state.positionMm.toFixed(2)} mm`,
              })}
            </span>
          ) : null}
        </div>

        <p className="text-[0.6875rem] leading-relaxed text-warn">{t('gripper:writeZero.warning')}</p>
        {!vm.enabled && vm.connected ? (
          <p className="text-[0.6875rem] text-warn">{t('gripper:writeZero.needsEnabled')}</p>
        ) : null}
      </Card>

      <Card className="flex flex-col gap-3 rounded-[0.875rem] p-5">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 flex-none text-warn" />
          <div className="flex-1">
            <h2 className="text-sm font-bold text-foreground">{t('gripper:settings.allowFactory')}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('gripper:settings.allowFactoryDesc')}</p>
          </div>
          <Toggle
            id="gripper-allow-factory"
            data-testid="gripper-allow-factory"
            aria-label={t('gripper:settings.allowFactory')}
            pressed={vm.conn?.allowFactory === true}
            disabled={!vm.present}
            onPressedChange={(pressed) => void vm.setAllowFactory(pressed)}
          />
        </div>
      </Card>
    </div>
  )
}

import { HandMetal, ShieldCheck, Settings2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Pill } from '../../components/Pill'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { useEffect, useState } from 'react'
import { armClient, formatArmError, useArmConnection } from '@/lib/arm'

const GESTURE_DEFS = [
  { id: 'open', emoji: '🖐️' },
  { id: 'close', emoji: '✊' },
  { id: 'pinch', emoji: '🤏' },
  { id: 'point', emoji: '☝️' },
  { id: 'ok', emoji: '👌' },
  { id: 'peace', emoji: '✌️' },
  { id: 'rock', emoji: '🤘' },
  { id: 'thumb_up', emoji: '👍' },
]

const HAND_ID = 'end_0'
const HAND_TORQUE_STORAGE_KEY = 'litearm.hand.torquePct'
// 旧 LinkerHand L10 契约：10 个关节，力矩范围为 0~255。
// 若上游 litearm-device 的真实 adapter 采用不同自由度/量程，需按 manifest 同步调整。
const HAND_DOF = 10
const HAND_TORQUE_MAX = 255

type DeviceConnectionStatus = 'idle' | 'connecting' | 'ready' | 'error'

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

function readStoredTorque(): number {
  const raw = window.localStorage.getItem(HAND_TORQUE_STORAGE_KEY)
  if (raw == null || raw === '') return 100
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return 100
  return Math.min(100, Math.max(10, parsed))
}

export function HandPanel({ simMode = false }: { simMode?: boolean }) {
  const { t } = useTranslation(['common', 'solo'])
  const [torquePct, setTorquePct] = useState(readStoredTorque)
  const [deviceStatus, setDeviceStatus] = useState<DeviceConnectionStatus>('idle')
  const [deviceError, setDeviceError] = useState('')
  const [activeGesture, setActiveGesture] = useState<string | null>(null)
  const [testingGesture, setTestingGesture] = useState(false)
  const { status } = useArmConnection()
  const connected = status === 'connected'
  const canControl = connected && !simMode && deviceStatus === 'ready'

  const fail = (op: string) => (err: unknown) => {
    const msg = formatArmError(err)
    toast.error(t('solo:hand.opFailed', { op, message: msg }), { id: 'hand-action-error' })
    console.error(`${op} failed`, err)
  }

  useEffect(() => {
    window.localStorage.setItem(HAND_TORQUE_STORAGE_KEY, String(torquePct))
  }, [torquePct])

  // 设备连接与检测生命周期：根据服务端配置与在线状态决定
  // 若未在设置中启用挂载，保持 idle（未挂载）状态，不自动拉起 daemon 报错；
  // 若已启用且在线，则进入 ready 控制态。
  useEffect(() => {
    if (!connected || simMode) {
      setDeviceStatus('idle')
      setDeviceError('')
      return
    }

    let cancelled = false

    const ensureHand = async () => {
      setDeviceError('')
      try {
        let active = null
        try {
          active = await withTimeout(armClient.getActiveDevice(HAND_ID), 3000, '查询末端设备状态超时')
        } catch {
          active = null
        }

        if (cancelled) return

        if (active?.online && active.category === 'hand') {
          setDeviceStatus('ready')
          return
        }

        // 如果服务端未配置或未使能末端设备，保持 idle 状态
        if (!active?.configured || !active?.enabled) {
          setDeviceStatus('idle')
          return
        }

        // 如果配置了且处于使能态，但当前未在线，尝试按配置连接
        setDeviceStatus('connecting')
        const result = await withTimeout(
          armClient.connectDevice(active.category, active.subtype, {
            deviceId: HAND_ID,
            canIface: active.can_iface || undefined,
          }),
          10000,
          '连接灵巧手设备超时',
        )
        if (cancelled) return

        if (result.ok) {
          setDeviceStatus('ready')
        } else {
          setDeviceStatus('idle')
          setDeviceError(result.error || '')
        }
      } catch (err) {
        if (cancelled) return
        setDeviceStatus('idle')
        setDeviceError(formatArmError(err))
      }
    }

    ensureHand()
    return () => {
      cancelled = true
    }
  }, [connected, simMode])

  const handleGesture = async (gestureId: string) => {
    setActiveGesture(gestureId)
    if (simMode) {
      toast.success(t(`solo:hand.gestures.${gestureId}`))
      return
    }
    if (!canControl) return
    setTestingGesture(true)
    try {
      const proxy = armClient.device(HAND_ID)
      if (!proxy) throw new Error('末端设备代理不可用')
      const res = (await proxy.setGesture(gestureId)) as { ok?: boolean; error?: string } | undefined
      if (res && res.ok === false) {
        throw new Error(res.error || '手势执行失败')
      }
      toast.dismiss('hand-action-error')
    } catch (err) {
      fail(t(`solo:hand.gestures.${gestureId}`))(err)
    } finally {
      setTestingGesture(false)
    }
  }

  const commitTorque = async (val: number) => {
    setTorquePct(val)
    if (!canControl) return
    try {
      const proxy = armClient.device(HAND_ID)
      if (!proxy) throw new Error('末端设备代理不可用')
      // 沿袭旧 LinkerHand L10 契约：力矩限制百分比 → 每个关节 0~255 的力矩值。
      const torque = Array.from(
        { length: HAND_DOF },
        () => Math.round((Math.min(100, Math.max(10, val)) / 100) * HAND_TORQUE_MAX),
      )
      const res = (await proxy.call('set_torque', { torque })) as { ok?: boolean; error?: string }
      if (res && res.ok === false) {
        throw new Error(res.error || '设置力矩失败')
      }
      toast.dismiss('hand-action-error')
    } catch (err) {
      fail(t('solo:hand.torqueLimit'))(err)
    }
  }

  const clearFaults = async () => {
    if (!canControl) return
    try {
      const proxy = armClient.device(HAND_ID)
      if (!proxy) throw new Error('末端设备代理不可用')
      const res = (await proxy.clearFaults()) as { ok?: boolean; error?: string }
      if (res && res.ok === false) {
        throw new Error(res.error || '清除故障失败')
      }
      toast.success('灵巧手故障已清除')
    } catch (err) {
      fail(t('solo:hand.clearFaults'))(err)
    }
  }

  return (
    <Card
      className="flex-none min-h-[20.5rem] gap-[0.6875rem] rounded-[0.875rem] px-3.5 py-[0.8125rem]"
      style={simMode ? { opacity: 0.55, pointerEvents: 'none' } : undefined}
    >
      <div className="flex items-center gap-[0.5625rem]">
        <div className="flex size-7 items-center justify-center rounded-lg bg-indigo-600 text-white">
          <HandMetal size="0.875rem" />
        </div>
        <div className="flex-1">
          <div className="text-[0.90625rem] leading-tight font-semibold text-foreground">{t('solo:hand.title')}</div>
          <div className="text-[0.71875rem] text-muted-foreground">{t('solo:hand.subtitle')}</div>
        </div>
        {simMode ? (
          <Pill dot="#f5a524" bg="var(--warn-soft)" bd="var(--warn-line)" fg="var(--warn)" padding="0.1875rem 0.5625rem" fontSize={11.5}>
            {t('common:sim')}
          </Pill>
        ) : !connected ? (
          <Pill dot="var(--line-strong)" bg="var(--line-soft)" bd="var(--line)" fg="var(--ink-subtle)" padding="0.1875rem 0.5625rem" fontSize={11.5}>
            {t('common:disconnected')}
          </Pill>
        ) : deviceStatus === 'ready' ? (
          <Pill dot="var(--ok)" bg="var(--ok-soft)" bd="var(--ok-line)" fg="var(--ok)" padding="0.1875rem 0.5625rem" fontSize={11.5}>
            {t('common:ready')}
          </Pill>
        ) : deviceStatus === 'connecting' ? (
          <Pill dot="#f5a524" bg="var(--warn-soft)" bd="var(--warn-line)" fg="var(--warn)" padding="0.1875rem 0.5625rem" fontSize={11.5}>
            {t('common:connecting')}
          </Pill>
        ) : deviceStatus === 'error' ? (
          <div title={deviceError || undefined}>
            <Pill dot="var(--danger)" bg="var(--danger-soft)" bd="var(--danger-line)" fg="var(--danger)" padding="0.1875rem 0.5625rem" fontSize={11.5}>
              {t('solo:hand.faultStatus')}
            </Pill>
          </div>
        ) : (
          <Pill dot="var(--line-strong)" bg="var(--line-soft)" bd="var(--line)" fg="var(--ink-subtle)" padding="0.1875rem 0.5625rem" fontSize={11.5}>
            {t('common:disconnected')}
          </Pill>
        )}
      </div>

      {/* 快捷手势库 */}
      <div className="flex flex-col gap-2 rounded-xl border border-line bg-card p-2.5 shadow-[0_0.0625rem_0.25rem_rgba(16,24,40,0.05)]">
        <div className="flex items-center justify-between">
          <div className="text-[0.8125rem] font-semibold text-ink">{t('solo:hand.presetGestures')}</div>
          <Button
            variant="ghost"
            size="sm"
            disabled={!canControl}
            onClick={clearFaults}
            className="h-6 gap-1 px-1.5 text-[11px] text-amber-600 hover:text-amber-700 hover:bg-amber-50"
          >
            <ShieldCheck size="0.75rem" />
            <span>{t('solo:hand.clearFaults')}</span>
          </Button>
        </div>

        <div className="grid grid-cols-4 gap-1.5">
          {GESTURE_DEFS.map((g) => {
            const label = t(`solo:hand.gestures.${g.id}`, g.id)
            const isCurrent = activeGesture === g.id
            return (
              <Button
                key={g.id}
                type="button"
                variant={isCurrent ? 'default' : 'outline'}
                size="sm"
                disabled={!canControl || testingGesture}
                onClick={() => handleGesture(g.id)}
                className="h-12 flex flex-col items-center justify-center p-1 gap-0.5 text-xs rounded-lg"
              >
                <span className="text-base leading-none">{g.emoji}</span>
                <span className="text-[10px] font-medium leading-none truncate max-w-full">{label}</span>
              </Button>
            )
          })}
        </div>
      </div>

      {/* 灵巧手参数：握持力矩限制 */}
      <div className="flex flex-col gap-2.5 rounded-xl border bg-muted/40 px-3 py-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[0.71875rem] font-semibold text-ink-muted">
            <Settings2 size="0.8125rem" />
            {t('solo:hand.torqueLimit')}
          </div>
          <span className="font-mono text-[0.875rem] font-semibold text-foreground">{torquePct}%</span>
        </div>
        <Slider
          value={[torquePct]}
          min={10}
          max={100}
          step={5}
          disabled={!canControl}
          onValueChange={([v]) => setTorquePct(v)}
          onValueCommit={([v]) => commitTorque(v)}
        />
        <div className="flex justify-between font-mono text-[0.625rem] text-muted-foreground/70">
          <div>10% (轻柔)</div>
          <div>50%</div>
          <div>100% (最大)</div>
        </div>
      </div>
    </Card>
  )
}

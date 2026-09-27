import { Grip, Maximize2, Minimize2, Settings2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Pill } from '../../components/Pill'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { useEffect, useRef, useState } from 'react'
import { armClient, formatArmError, useArmConnection } from '@/lib/arm'
import {
  GRIPPER_FORCE_MAX_N,
  GRIPPER_FORCE_SET_MAX_N,
  GRIPPER_STROKE_MM,
  forceToNorm,
} from '@/lib/arm/gripper'

const GRIPPER_ID = 'end_0'
const GRIPPER_STATE_POLL_MS = 1000
const GRIPPER_SPEED_MIN_MM_S = 5
const GRIPPER_SPEED_MAX_MM_S = 150
const DEFAULT_GRIPPER_SPEED_MM_S = 50
const GRIPPER_SPEED_STORAGE_KEY = 'litearm.gripper.speedMmS'

type DeviceConnectionStatus = 'idle' | 'connecting' | 'ready' | 'error'

function numberFromState(state: Record<string, unknown>, key: string): number | null {
  const value = state[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

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

function readStoredSpeedMmS(): number {
  const raw = window.localStorage.getItem(GRIPPER_SPEED_STORAGE_KEY)
  if (raw == null || raw === '') return DEFAULT_GRIPPER_SPEED_MM_S
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return DEFAULT_GRIPPER_SPEED_MM_S
  return Math.min(GRIPPER_SPEED_MAX_MM_S, Math.max(GRIPPER_SPEED_MIN_MM_S, parsed))
}

export function GripperPanel({ simMode = false }: { simMode?: boolean }) {
  const { t } = useTranslation(['common', 'solo'])
  const [opening, setOpening] = useState(0)
  const openingRef = useRef(0)
  const [openingLoaded, setOpeningLoaded] = useState(false)
  const [strokeMaxMm, setStrokeMaxMm] = useState(GRIPPER_STROKE_MM)
  const [targetForceN, setTargetForceN] = useState(12)
  const draggingRef = useRef(false)
  const [speedMmS, setSpeedMmS] = useState(readStoredSpeedMmS)
  const [deviceStatus, setDeviceStatus] = useState<DeviceConnectionStatus>('idle')
  const [deviceError, setDeviceError] = useState('')
  const { status } = useArmConnection()
  const connected = status === 'connected'
  const canControl = connected && !simMode && deviceStatus === 'ready'

  const fail = (op: string) => (err: unknown) => {
    const msg = formatArmError(err)
    toast.error(t('solo:gripper.opFailed', { op, message: msg }), { id: 'gripper-action-error' })
    console.error(`${op} failed`, err)
  }

  // 切回实机时丢弃仿真期间调整的本地夹爪状态
  useEffect(() => {
    if (simMode) {
      openingRef.current = 40
      setOpening(40)
      setOpeningLoaded(true)
      setStrokeMaxMm(GRIPPER_STROKE_MM)
    } else {
      openingRef.current = 0
      setOpening(0)
      setOpeningLoaded(false)
      setStrokeMaxMm(GRIPPER_STROKE_MM)
      setTargetForceN(12)
      draggingRef.current = false
    }
  }, [simMode])

  useEffect(() => {
    window.localStorage.setItem(GRIPPER_SPEED_STORAGE_KEY, String(speedMmS))
  }, [speedMmS])

  // 新版 litearm-js 的末端设备生命周期：查询服务端已配置的末端设备状态。
  // 若未在设置中启用挂载，保持 idle（未挂载）状态，不自动拉起 daemon 报错；
  // 若已启用且在线，则进入 ready 控制态。
  useEffect(() => {
    if (!connected || simMode) {
      setDeviceStatus('idle')
      setDeviceError('')
      setOpeningLoaded(false)
      return
    }

    let cancelled = false

    const ensureGripper = async () => {
      setDeviceError('')
      try {
        let active = null
        try {
          active = await withTimeout(armClient.getActiveDevice(GRIPPER_ID), 3000, '查询末端设备状态超时')
        } catch {
          active = null
        }

        if (cancelled) return

        if (active?.online && active.category === 'gripper') {
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
            deviceId: GRIPPER_ID,
            canIface: active.can_iface || undefined,
          }),
          10000,
          '连接末端设备超时',
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

    ensureGripper()
    return () => {
      cancelled = true
    }
  }, [connected, simMode])

  // 连接就绪后周期读取夹爪状态：位置/行程在未拖动时同步。
  useEffect(() => {
    if (deviceStatus !== 'ready') return
    let cancelled = false
    let inFlight = false
    let timer: ReturnType<typeof setInterval> | null = null

    const readState = async () => {
      if (inFlight) return
      const statePromise = armClient.device(GRIPPER_ID)?.call('get_state')
      if (!statePromise) return
      inFlight = true
      try {
        const raw = await withTimeout(statePromise, 8000, '读取夹爪状态超时')
        if (cancelled || !raw || typeof raw !== 'object') return
        const state = raw as Record<string, unknown>
        const positionMm = numberFromState(state, 'position_mm')
        const travelMm = numberFromState(state, 'travel_mm')
        if (!draggingRef.current && positionMm != null) {
          const clamped = Math.min(Math.max(positionMm, 0), travelMm ?? GRIPPER_STROKE_MM)
          openingRef.current = clamped
          setOpening(clamped)
        }
        if (travelMm != null && travelMm > 0) setStrokeMaxMm(travelMm)
        setOpeningLoaded(true)
      } catch {
        // 单次轮询失败时保留上次显示值
      } finally {
        inFlight = false
      }
    }

    readState()
    timer = setInterval(readState, GRIPPER_STATE_POLL_MS)
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [deviceStatus])

  const gripper = () => armClient.device(GRIPPER_ID)

  // 位置控制走 move_at_speed(target_mm, speed_mm_s)：
  // LiteGrip SDK 只有 move_at_speed 会按 mm/s 匀速插值，
  // goto 的 duration 只是“目标位保持时长”，并不限制移动速度。
  const setOpeningMm = (mm: number) => {
    openingRef.current = mm
    setOpening(mm)
    if (canControl) setOpeningLoaded(true)
    if (!canControl) return
    gripper()
      ?.call('move_at_speed', { target_mm: mm, speed_mm_s: speedMmS })
      .then(() => toast.dismiss('gripper-action-error'))
      .catch(fail(t('solo:gripper.openingPosition')))
  }

  const commitTargetForceN = (n: number) => {
    setTargetForceN(n)
    if (!canControl) return
    gripper()
      ?.call('set_force', { force: forceToNorm(n, GRIPPER_FORCE_SET_MAX_N) })
      .then(() => toast.dismiss('gripper-action-error'))
      .catch(fail(t('solo:gripper.targetForce')))
  }

  const open = () => {
    openingRef.current = strokeMaxMm
    setOpening(strokeMaxMm)
    if (canControl) setOpeningLoaded(true)
    if (canControl) {
      gripper()
        ?.call('move_at_speed', { target_mm: strokeMaxMm, speed_mm_s: speedMmS })
        .then(() => toast.dismiss('gripper-action-error'))
        .catch(fail(t('solo:gripper.open')))
    }
  }

  const close = async () => {
    openingRef.current = 0
    setOpening(0)
    if (canControl) setOpeningLoaded(true)
    if (canControl) {
      const device = gripper()
      try {
        await device?.call('move_at_speed', { target_mm: 0, speed_mm_s: speedMmS })
        toast.dismiss('gripper-action-error')
      } catch (err) {
        fail(t('solo:gripper.close'))(err)
      }
    }
  }

  return (
    <Card
      className="flex-none min-h-[20.5rem] gap-[0.6875rem] rounded-[0.875rem] px-3.5 py-[0.8125rem]"
      style={simMode ? { opacity: 0.55, pointerEvents: 'none' } : undefined}
    >
      <div className="flex items-center gap-[0.5625rem]">
        <div className="flex size-7 items-center justify-center rounded-lg bg-chip text-chip-fg">
          <Grip size="0.875rem" />
        </div>
        <div className="flex-1">
          <div className="text-[0.90625rem] leading-tight font-semibold text-foreground">{t('solo:gripper.title')}</div>
          <div className="text-[0.71875rem] text-muted-foreground">{t('solo:gripper.subtitle', { max: strokeMaxMm.toFixed(0) })}</div>
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
              {t('solo:gripper.faultStatus')}
            </Pill>
          </div>
        ) : (
          <Pill dot="var(--line-strong)" bg="var(--line-soft)" bd="var(--line)" fg="var(--ink-subtle)" padding="0.1875rem 0.5625rem" fontSize={11.5}>
            {t('common:disconnected')}
          </Pill>
        )}
      </div>

      {/* 开合位置：主控制 */}
      <div className="flex flex-col gap-2 rounded-xl border border-line bg-card px-3 py-2.5 shadow-[0_0.0625rem_0.25rem_rgba(16,24,40,0.05)]">
        <div className="flex items-baseline justify-between">
          <div className="text-[0.8125rem] font-semibold text-ink">{t('solo:gripper.openingPosition')}</div>
          <div className="font-mono text-[1.375rem] leading-none font-bold text-foreground">
            {openingLoaded ? (
              <>
                {opening.toFixed(1)}
                <span className="ml-[0.1875rem] text-[0.6875rem] font-medium text-muted-foreground">mm</span>
              </>
            ) : (
              <span className="text-[0.9375rem] font-medium text-muted-foreground">--</span>
            )}
          </div>
        </div>
        <Slider
          value={[opening]}
          max={strokeMaxMm}
          disabled={!canControl}
          onValueChange={([v]) => {
            draggingRef.current = true
            openingRef.current = v
            setOpening(v)
          }}
          onValueCommit={([v]) => {
            draggingRef.current = false
            setOpeningMm(v)
          }}
        />
        <div className="flex justify-between font-mono text-[0.625rem] text-muted-foreground/70">
          <div>{t('solo:gripper.closeLabel')}</div>
          <div>{t('solo:gripper.openLabel', { max: strokeMaxMm.toFixed(0) })}</div>
        </div>
      </div>

      <div className="flex gap-[0.4375rem]">
        <Button
          type="button"
          variant="outline"
          disabled={!canControl}
          onClick={open}
          className="h-[2.375rem] flex-1 gap-[0.4375rem] rounded-lg text-[0.84375rem] font-semibold text-ink-strong"
        >
          <Maximize2 size="0.8125rem" /> {t('solo:gripper.open')}
        </Button>
        <Button type="button" disabled={!canControl} onClick={close} className="h-[2.375rem] flex-1 gap-[0.4375rem] rounded-lg text-[0.84375rem] font-semibold">
          <Minimize2 size="0.8125rem" /> {t('solo:gripper.close')}
        </Button>
      </div>

      {/* 夹爪参数：夹持力 / 移动速度 */}
      <div className="flex flex-col gap-3 rounded-xl border bg-muted/40 px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-[0.71875rem] font-semibold text-ink-muted">
          <Settings2 size="0.8125rem" />
          {t('solo:gripper.paramsTitle')}
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <span className="text-[0.8125rem] font-medium text-ink-strong">{t('solo:gripper.targetForce')}</span>
            <span className="font-mono text-[0.875rem] font-semibold text-foreground">{targetForceN} N</span>
          </div>
          <Slider
            value={[targetForceN]}
            min={1}
            max={GRIPPER_FORCE_MAX_N}
            disabled={!canControl}
            onValueChange={([v]) => setTargetForceN(v)}
            onValueCommit={([v]) => commitTargetForceN(v)}
          />
          <div className="flex justify-between font-mono text-[0.625rem] text-muted-foreground/70">
            <div>1 N</div>
            <div>{GRIPPER_FORCE_MAX_N} N</div>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <span className="text-[0.8125rem] font-medium text-ink-strong">{t('solo:gripper.moveSpeed')}</span>
            <span className="font-mono text-[0.875rem] font-semibold text-foreground">{speedMmS} mm/s</span>
          </div>
          <Slider
            value={[speedMmS]}
            min={GRIPPER_SPEED_MIN_MM_S}
            max={GRIPPER_SPEED_MAX_MM_S}
            disabled={!canControl}
            onValueChange={([v]) => setSpeedMmS(v)}
          />
          <div className="flex justify-between font-mono text-[0.625rem] text-muted-foreground/70">
            <div>{GRIPPER_SPEED_MIN_MM_S} mm/s</div>
            <div>{GRIPPER_SPEED_MAX_MM_S} mm/s</div>
          </div>
        </div>
      </div>

    </Card>
  )
}

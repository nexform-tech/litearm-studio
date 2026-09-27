import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SegmentedControl, type SegItem } from '../../components/SegmentedControl'
import { DirectionPad, type PadCell } from '../../components/DirectionPad'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { MoveRight, RefreshCw, Compass } from 'lucide-react'

export function CartesianPanel({
  simMode = false,
  frames,
  frameOrigin,
  transCells,
  rotCells,
  onJogPress,
  onJogRelease,
  transSteps,
  rotSteps,
  transStep,
  rotStep,
  setTransStep,
  setRotStep,
  onMovelTarget,
  onSyncCurrentPose,
}: {
  simMode?: boolean
  frames: SegItem[]
  frameOrigin: string
  transCells: PadCell[]
  rotCells: PadCell[]
  onJogPress: (label: string) => void
  onJogRelease?: () => void
  transSteps: readonly string[]
  rotSteps: readonly string[]
  transStep: string
  rotStep: string
  setTransStep: (v: string) => void
  setRotStep: (v: string) => void
  onMovelTarget?: (pos: [number, number, number], rpy: [number, number, number]) => Promise<void>
  onSyncCurrentPose?: () => Promise<{ pos: [number, number, number]; rpy: [number, number, number] } | null>
}) {
  const { t } = useTranslation(['common', 'solo'])
  const [subMode, setSubMode] = useState<'jog' | 'target'>('jog')
  const [targetX, setTargetX] = useState<number>(0.32)
  const [targetY, setTargetY] = useState<number>(0)
  const [targetZ, setTargetZ] = useState<number>(0.45)
  const [targetRoll, setTargetRoll] = useState<number>(0)
  const [targetPitch, setTargetPitch] = useState<number>(1.57)
  const [targetYaw, setTargetYaw] = useState<number>(0)
  const [syncing, setSyncing] = useState(false)
  const [moving, setMoving] = useState(false)

  const handleSyncPose = async () => {
    if (!onSyncCurrentPose) return
    setSyncing(true)
    try {
      const res = await onSyncCurrentPose()
      if (res) {
        setTargetX(Number(res.pos[0].toFixed(4)))
        setTargetY(Number(res.pos[1].toFixed(4)))
        setTargetZ(Number(res.pos[2].toFixed(4)))
        setTargetRoll(Number(res.rpy[0].toFixed(4)))
        setTargetPitch(Number(res.rpy[1].toFixed(4)))
        setTargetYaw(Number(res.rpy[2].toFixed(4)))
      }
    } finally {
      setSyncing(false)
    }
  }

  const handleMovel = async () => {
    if (!onMovelTarget) return
    setMoving(true)
    try {
      await onMovelTarget([targetX, targetY, targetZ], [targetRoll, targetPitch, targetYaw])
    } finally {
      setMoving(false)
    }
  }

  return (
    <Card className="min-h-[16.25rem] flex-1 gap-3 rounded-[0.875rem] px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2.5 gap-y-2">
        <div className="text-[0.90625rem] font-semibold text-foreground">{t('solo:cartesian.title')}</div>
        {simMode ? (
          <div className="rounded-full bg-warn-soft px-2 py-0.5 text-[0.6875rem] font-medium text-warn">
            {t('solo:cartesian.simHint')}
          </div>
        ) : null}

        {/* 子模式切换：点动 vs 绝对目标 */}
        <div className="flex rounded-lg bg-muted/60 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setSubMode('jog')}
            className={`rounded-md px-2.5 py-1 font-semibold transition-colors ${
              subMode === 'jog' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t('solo:cartesian.jogSubMode')}
          </button>
          <button
            type="button"
            onClick={() => setSubMode('target')}
            className={`rounded-md px-2.5 py-1 font-semibold transition-colors ${
              subMode === 'target' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t('solo:cartesian.targetSubMode')}
          </button>
        </div>

        {subMode === 'jog' && (
          <>
            <SegmentedControl
              items={frames}
              containerStyle={{ display: 'flex', gap: '0.1875rem', background: 'var(--line-soft)', borderRadius: '0.5625rem', padding: '0.1875rem' }}
              itemStyle={{ padding: '0.3125rem 0.75rem', borderRadius: '0.4375rem', fontSize: '0.78125rem', color: 'var(--ink-subtle)', fontWeight: 500 }}
              activeItemStyle={{ background: 'var(--seg-active)', color: 'var(--ink)', fontWeight: 600, boxShadow: '0 0.0625rem 0.125rem rgba(16,24,40,.08)' }}
            />
            <div className="flex items-center gap-1.5 rounded-lg border bg-muted/40 px-2.5 py-[0.3125rem]">
              <div className="text-[0.71875rem] text-muted-foreground">{t('solo:cartesian.origin')}</div>
              <div className="font-mono text-xs font-semibold text-ink-muted">{frameOrigin}</div>
            </div>
            <div className="flex-1" />
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">{t('solo:cartesian.transStep')}</span>
              <Select value={transStep} onValueChange={setTransStep}>
                <SelectTrigger size="sm" className="font-mono text-[0.8125rem] font-semibold">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {transSteps.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">{t('solo:cartesian.rotStep')}</span>
              <Select value={rotStep} onValueChange={setRotStep}>
                <SelectTrigger size="sm" className="font-mono text-[0.8125rem] font-semibold">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {rotSteps.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </>
        )}
      </div>

      {subMode === 'jog' ? (
        <div className="flex min-h-0 flex-1 gap-3" style={simMode ? { opacity: 0.45, pointerEvents: 'none' } : undefined}>
          <div className="flex min-h-0 flex-1 flex-col gap-2.5 rounded-xl border bg-muted/40 p-3.5">
            <div className="text-xs font-bold tracking-wide text-ink-muted">{t('solo:cartesian.transTitle')}</div>
            <DirectionPad cells={transCells} onPress={onJogPress} onRelease={onJogRelease} />
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-2.5 rounded-xl border bg-muted/40 p-3.5">
            <div className="text-xs font-bold tracking-wide text-ink-muted">{t('solo:cartesian.rotTitle')}</div>
            <DirectionPad cells={rotCells} onPress={onJogPress} onRelease={onJogRelease} />
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 rounded-xl border bg-muted/20 p-3.5" style={simMode ? { opacity: 0.45, pointerEvents: 'none' } : undefined}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
              <Compass className="size-4 text-primary" />
              {t('solo:cartesian.targetPoseTitle')}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleSyncPose}
              disabled={syncing}
              className="h-7 gap-1 text-xs"
            >
              <RefreshCw className={`size-3 ${syncing ? 'animate-spin' : ''}`} />
              {t('solo:cartesian.syncCurrentPose')}
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
            <div>
              <label className="font-mono text-[0.6875rem] text-muted-foreground">X (m)</label>
              <Input
                type="number"
                step="0.005"
                value={targetX}
                onChange={(e) => setTargetX(Number(e.target.value))}
                className="mt-0.5 font-mono text-xs"
              />
            </div>
            <div>
              <label className="font-mono text-[0.6875rem] text-muted-foreground">Y (m)</label>
              <Input
                type="number"
                step="0.005"
                value={targetY}
                onChange={(e) => setTargetY(Number(e.target.value))}
                className="mt-0.5 font-mono text-xs"
              />
            </div>
            <div>
              <label className="font-mono text-[0.6875rem] text-muted-foreground">Z (m)</label>
              <Input
                type="number"
                step="0.005"
                value={targetZ}
                onChange={(e) => setTargetZ(Number(e.target.value))}
                className="mt-0.5 font-mono text-xs"
              />
            </div>
            <div>
              <label className="font-mono text-[0.6875rem] text-muted-foreground">Roll (rad)</label>
              <Input
                type="number"
                step="0.05"
                value={targetRoll}
                onChange={(e) => setTargetRoll(Number(e.target.value))}
                className="mt-0.5 font-mono text-xs"
              />
            </div>
            <div>
              <label className="font-mono text-[0.6875rem] text-muted-foreground">Pitch (rad)</label>
              <Input
                type="number"
                step="0.05"
                value={targetPitch}
                onChange={(e) => setTargetPitch(Number(e.target.value))}
                className="mt-0.5 font-mono text-xs"
              />
            </div>
            <div>
              <label className="font-mono text-[0.6875rem] text-muted-foreground">Yaw (rad)</label>
              <Input
                type="number"
                step="0.05"
                value={targetYaw}
                onChange={(e) => setTargetYaw(Number(e.target.value))}
                className="mt-0.5 font-mono text-xs"
              />
            </div>
          </div>

          <div className="mt-auto flex justify-end">
            <Button
              type="button"
              onClick={handleMovel}
              disabled={moving}
              className="gap-1.5"
            >
              <MoveRight className="size-4" />
              {moving ? t('solo:cartesian.movelMoving') : t('solo:cartesian.movelBtn')}
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}

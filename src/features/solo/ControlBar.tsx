import { TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SegmentedControl, type SegItem } from '../../components/SegmentedControl'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Toggle } from '@/components/ui/toggle'
import { Slider } from '@/components/ui/slider'
import { Separator } from '@/components/ui/separator'

export function ControlBar({
  enableBg,
  enableFg,
  enableBd,
  enableDot,
  enabled,
  toggleEnable,
  modes,
  speed,
  setSpeed,
  fault,
  faultReason,
  clearFault,
  homeJoints,
  zeroJoints,
}: {
  enableBg: string
  enableFg: string
  enableBd: string
  enableDot: string
  enabled: boolean
  toggleEnable: () => void
  modes: SegItem[]
  speed: number
  setSpeed: (v: number) => void
  fault: boolean
  faultReason: string | null
  clearFault: () => void
  homeJoints: () => void
  zeroJoints: () => void
}) {
  const { t } = useTranslation(['common', 'solo'])

  // 速度滑条只接受 (0,1]：0% 会被服务端拒绝，所以步进器把下限钳在 1。
  const nudge = (delta: number) => setSpeed(Math.min(100, Math.max(1, speed + delta)))

  return (
    <Card className="flex-none flex-col gap-2.5 rounded-[0.875rem] px-[0.8125rem] py-[0.6875rem]">
      {/* 第一行：使能与三个一次性动作，模式切换靠右 */}
      <div className="flex flex-wrap items-center gap-2.5">
        <Toggle
          pressed={enabled}
          onPressedChange={toggleEnable}
          // 背景/描边走内联样式（会盖掉 hover:bg-*），所以用 brightness 做悬停反馈。
          className="h-11 min-w-[8.25rem] cursor-pointer gap-2.5 rounded-[0.6875rem] border px-4 text-[0.9375rem] font-semibold shadow-[0_0.0625rem_0.125rem_rgba(16,24,40,.06)] hover:brightness-95 active:brightness-90"
          style={{ background: enableBg, color: enableFg, borderColor: enableBd }}
        >
          <div className="size-[0.5625rem] rounded-full" style={{ background: enableDot }} />
          {enabled ? t('common:enabled') : t('common:disabled')}
        </Toggle>

        <div className="flex gap-[0.4375rem]">
          <Button
            type="button"
            variant="outline"
            disabled={!fault}
            onClick={clearFault}
            className="h-11 rounded-[0.6875rem] px-3 text-sm font-medium text-ink-strong"
          >
            {t('solo:controlBar.clearFault')}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={homeJoints}
            title={t('solo:controlBar.readyPoseTitle')}
            className="h-11 rounded-[0.6875rem] px-3 text-sm font-medium text-ink-strong"
          >
            {t('solo:controlBar.readyPose')}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={zeroJoints}
            title={t('solo:controlBar.zeroPoseTitle')}
            className="h-11 rounded-[0.6875rem] px-3 text-sm font-medium text-ink-strong"
          >
            {t('solo:controlBar.zeroPose')}
          </Button>
        </div>

        <div className="ml-auto flex items-center gap-2.5">
          <Separator orientation="vertical" className="h-7" />
          <SegmentedControl
            items={modes}
            containerStyle={{ display: 'flex', gap: '0.1875rem', background: 'var(--line-soft)', borderRadius: '0.6875rem', padding: '0.1875rem' }}
            itemStyle={{ padding: '0.5rem 0.8125rem', borderRadius: '0.5rem', fontSize: '0.84375rem', color: 'var(--ink-subtle)', fontWeight: 500 }}
            activeItemStyle={{ background: 'var(--seg-active)', color: 'var(--ink)', fontWeight: 650, boxShadow: '0 0.0625rem 0.125rem rgba(16,24,40,.1)' }}
          />
        </div>
      </div>

      {/* 第二行：速度值独占一行，滑条 + 步进器 */}
      <div className="flex items-center gap-[0.5625rem]">
        <div className="text-[0.84375rem] font-semibold text-ink-strong">{t('solo:controlBar.speed')}</div>
        <Slider
          value={[speed]}
          min={1}
          max={100}
          onValueChange={([v]) => setSpeed(v)}
          className="min-w-0 flex-1"
        />
        <div className="flex flex-none items-center overflow-hidden rounded-[0.5625rem] border border-line-strong">
          <button
            type="button"
            aria-label={t('solo:controlBar.speedDown')}
            title={t('solo:controlBar.speedDown')}
            onClick={() => nudge(-1)}
            className="h-8 w-8 cursor-pointer text-[1rem] leading-none text-muted-foreground transition-colors hover:bg-[var(--hover)] hover:text-foreground"
          >
            −
          </button>
          <div className="w-[3.25rem] text-center font-mono text-[0.875rem] font-bold text-foreground">
            {speed}%
          </div>
          <button
            type="button"
            aria-label={t('solo:controlBar.speedUp')}
            title={t('solo:controlBar.speedUp')}
            onClick={() => nudge(1)}
            className="h-8 w-8 cursor-pointer text-[1rem] leading-none text-muted-foreground transition-colors hover:bg-[var(--hover)] hover:text-foreground"
          >
            +
          </button>
        </div>
      </div>

      {faultReason ? (
        <div className="flex items-start gap-1.5 rounded-[0.5rem] bg-danger-soft px-2.5 py-1.5 text-[0.78125rem] leading-[1.4] text-danger">
          <TriangleAlert size="0.875rem" className="mt-px shrink-0" />
          <span>{faultReason}</span>
        </div>
      ) : null}
    </Card>
  )
}

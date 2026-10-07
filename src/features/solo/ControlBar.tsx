import { TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Toggle } from '@/components/ui/toggle'
import { Slider } from '@/components/ui/slider'

/** 一行三颗等宽大按钮（使能开关 / 复位 / 回零点），撑满卡片宽度 —— 就是速度滑条上方那一行。
 *  皮肤全部交给现有 Button / Toggle 变体：扁平纯色、无渐变、无投影，尺寸与排版只在这里加。 */
const BIG_BUTTON = 'h-11! w-full cursor-pointer gap-2.5! rounded-[0.6875rem]! text-[0.9375rem]! font-semibold!'

/** 「复位」是这一行唯一的主操作：`--ok-solid` 实心绿，其余两颗走 outline 变体，
 *  一行里只留一颗实心，层次才不会糊。 */
const RESET_BUTTON = cn(BIG_BUTTON, 'border-transparent! bg-ok-solid! text-ok-solid-fg! hover:bg-ok-solid/85!')

/** 使能开关按下 = 机械臂已使能，用 `--ok-soft` 压一层扁平的绿底，配合左侧圆点说明
 *  "现在带电" —— 这颗按钮一点就会失力下坠，状态不能只靠文字。 */
const ENABLE_BUTTON = cn(BIG_BUTTON, 'aria-pressed:bg-ok-soft! data-[state=on]:bg-ok-soft!')

export function ControlBar({
  enabled,
  enableDot,
  toggleEnable,
  speed,
  setSpeed,
  faultReason,
  clearFault,
  zeroJoints,
}: {
  enabled: boolean
  enableDot: string
  toggleEnable: () => void
  speed: number
  setSpeed: (v: number) => void
  faultReason: string | null
  clearFault: () => void
  zeroJoints: () => void
}) {
  const { t } = useTranslation('solo')

  // 速度滑条只接受 (0,1]：0% 会被服务端拒绝，所以步进器把下限钳在 1。
  const nudge = (delta: number) => setSpeed(Math.min(100, Math.max(1, speed + delta)))

  return (
    <Card className="flex-none flex-col gap-2.5 rounded-[0.875rem] px-[0.8125rem] py-[0.6875rem]">
      {/* 第一行：三个大按钮。模式切换（位置 / 零重力）不在这里 —— 它是控制模式而不是
          一次性动作，已经挪到 3D 预览卡片下方，见 PreviewPanel。 */}
      <div className="grid grid-cols-3 gap-2.5">
        <Toggle
          variant="outline"
          pressed={enabled}
          onPressedChange={toggleEnable}
          title={enabled ? t('controlBar.disableTitle') : t('controlBar.enableTitle')}
          className={ENABLE_BUTTON}
        >
          <div className="size-[0.5625rem] flex-none rounded-full" style={{ background: enableDot }} />
          {enabled ? t('controlBar.disable') : t('controlBar.enable')}
        </Toggle>

        {/* 复位不锁状态：故障发生时它必须一点就有，不该先去想为什么它是灰的。 */}
        <Button
          type="button"
          variant="outline"
          onClick={clearFault}
          title={t('controlBar.resetTitle')}
          className={RESET_BUTTON}
        >
          {t('controlBar.reset')}
        </Button>

        <Button
          type="button"
          variant="outline"
          onClick={zeroJoints}
          title={t('controlBar.homeTitle')}
          className={BIG_BUTTON}
        >
          {t('controlBar.home')}
        </Button>
      </div>

      {/* 第二行：速度值独占一行，滑条 + 步进器 */}
      <div className="flex items-center gap-[0.5625rem]">
        <div className="text-[0.84375rem] font-semibold text-ink-strong">{t('controlBar.speed')}</div>
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
            aria-label={t('controlBar.speedDown')}
            title={t('controlBar.speedDown')}
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
            aria-label={t('controlBar.speedUp')}
            title={t('controlBar.speedUp')}
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

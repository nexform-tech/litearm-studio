import { Feather, House, Power, RotateCcw, Target, TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Toggle } from '@/components/ui/toggle'
import { Slider } from '@/components/ui/slider'

/** 一行六颗等宽大按钮（使能 / 零重力 / 复位 / 清除故障 / 回零点 / 就绪姿态），撑满卡片宽度
 *  —— 就是速度滑条上方那一行。顺序按操作性质分组：两颗开关在前、两颗故障恢复居中、
 *  两颗运动指令在后，不加分隔线。图标取自夹爪面板已经用熟的那一套（电源／羽毛／回转／
 *  警告三角／房子），同一个动作用同一个字形。
 *  皮肤全部交给现有 Button / Toggle 变体：扁平纯色、无渐变、无投影，尺寸与排版只在这里加。
 *  ⚠ 宽度是这一行最容易翻车的地方，加了图标之后更紧：中间列最窄只有 23rem（368px），
 *  扣掉卡片内边距后每颗只剩 52px，而「清除故障」这四个汉字在 13px 字号下就要 52px。
 *  所以窄卡片走 3 列两行，够宽（`@[50rem]`）才摊平成一整行。判据挂在**卡片自己的宽度**上
 *  （容器查询 `@container`，见下面 Card），不是视口断点：中间列宽随左右两列的 clamp 变，
 *  视口宽推不出这一行到底有多少地方。
 *  ⚠ 图标横排是要花宽度的：每颗的内容宽度是「内边距 + 图标 + 间距 + 文字」，六颗里最宽的
 *  那颗说了算。对着构建出的 CSS 在 Chromium 里量（`en` 的 "Zero Gravity" 最宽、`zh` 的是
 *  「清除故障」）：**英文要 48.0rem、中文要 33.1rem** 才放得下六颗。门槛取 50rem 而不是
 *  48rem —— 多出来的 2rem 摊到六颗上只有约 4.6px 余量，正好够字体渲染的抖动（门槛贴着
 *  实测值设，英文那两颗就会顶着边框）。
 *  1440 窗口里这一行只有约 39–40rem（左侧导航先拿走 5rem）⇒ 这个宽度上它折成 3 列两行 ——
 *  这是有意的取舍：宁可多一行，也不让文字顶出按钮边框。1920 窗口（约 53rem）是一行六颗。
 *  改字号、改横排为竖排或改按钮文案之前，先把两种语言都在中间列最窄的窗口下量一遍 ——
 *  门槛按英文最宽那颗算，不是按中文估的。 */
const BIG_BUTTON =
  'h-11! w-full min-w-0 cursor-pointer gap-1.5! rounded-[0.6875rem]! px-1! text-[0.8125rem]! font-semibold!'

/** 按钮图标统一尺寸：base 的 `[&_svg:not([class*='size-'])]:size-4`（1rem）对这颗 11px 的
 *  标签偏大，带上 `size-3.5` 这个类正好让那条规则让位（选择器靠 `class*=size-` 判断）。 */
const ICON = 'size-3.5 flex-none'

/** 「复位」是这一行唯一的主操作：`--ok-solid` 实心绿，其余五颗走 outline 变体，
 *  一行里只留一颗实心，层次才不会糊。 */
const RESET_BUTTON = cn(BIG_BUTTON, 'border-transparent! bg-ok-solid! text-ok-solid-fg! hover:bg-ok-solid/85!')

/** 使能开关：按下 = 机械臂已使能。已使能时压一层 `--ok-soft` 绿底 —— 与「复位」同一族的绿色
 *  表示"这台臂现在带电、在持位"，一眼可辨；实心只留给「复位」那一颗，一行里仍然只有一颗
 *  实心按钮。
 *  ⚠ 绿底在这里只表示**状态**，不表示"按了安全"：这一按是切断力矩、让臂掉下来。掉臂的警告
 *  只写在按钮的 tooltip（`disableTitle`）里，界面上没有常驻提示 —— 按钮自己的文字（已使能时
 *  写「失能」= 下一按会做什么）是唯一随手可见的线索。 */
const ENABLE_BUTTON = cn(BIG_BUTTON, 'aria-pressed:bg-ok-soft! data-[state=on]:bg-ok-soft!')

/** 零重力按一下进入、再按一下退出，所以是开关而不是一次性动作。按下时压一层蓝底：
 *  它和使能的绿底必须一眼分得开 —— 绿色是"带电锁位"，蓝色是"零力矩、可以用手拖"。 */
const ZERO_G_BUTTON = cn(
  BIG_BUTTON,
  'aria-pressed:border-info-line! aria-pressed:bg-info-soft! aria-pressed:text-[var(--info)]!',
  'data-[state=on]:border-info-line! data-[state=on]:bg-info-soft! data-[state=on]:text-[var(--info)]!',
)

export function ControlBar({
  enabled,
  enableColor,
  toggleEnable,
  speed,
  setSpeed,
  faultReason,
  reset,
  clearFault,
  zeroJoints,
  zeroGravity,
  toggleZeroGravity,
  readyPose,
}: {
  enabled: boolean
  /** 使能状态色：电源图标染成它（带电绿 / 未带电琥珀）。 */
  enableColor: string
  toggleEnable: () => void
  speed: number
  setSpeed: (v: number) => void
  faultReason: string | null
  /** 复位控制器（`reset`）：清锁存故障并把轨迹参考重新锚定到当前位姿。 */
  reset: () => void
  /** 清除故障（`clear_faults`）：只清驱动器 RAM 里的锁存故障位。 */
  clearFault: () => void
  zeroJoints: () => void
  /** 零重力开关当前是否激活（实机跟随广播，指令在途时跟随意图）。 */
  zeroGravity: boolean
  toggleZeroGravity: () => void
  readyPose: () => void
}) {
  const { t } = useTranslation('solo')

  // 速度滑条只接受 (0,1]：0% 会被服务端拒绝，所以步进器把下限钳在 1。
  const nudge = (delta: number) => setSpeed(Math.min(100, Math.max(1, speed + delta)))

  return (
    <Card className="@container flex-none flex-col gap-2.5 rounded-[0.875rem] px-[0.8125rem] py-[0.6875rem]">
      {/* 第一行：六颗大按钮。前两颗是改状态的开关（使能、零重力），中间两颗是故障恢复
          （复位、清除故障），后两颗是运动指令（回零点、就绪姿态）——改状态的挨着改状态的、
          故障恢复的挨着故障恢复的，靠顺序分组，不加分隔线。
          零重力不再和「位置」配对成预览卡片下方的模式页签：它是一颗可以反复开关的按钮，
          再按一下就是退出，页签里的「位置」项因此没有存在的必要。
          列数只分两档（见 BIG_BUTTON 上的宽度账）：卡片窄时 3 列两行，够宽起 6 列一行。 */}
      <div data-testid="control-bar-actions" className="grid grid-cols-3 gap-1.5 @[50rem]:grid-cols-6">
        <Toggle
          variant="outline"
          pressed={enabled}
          onPressedChange={toggleEnable}
          title={enabled ? t('controlBar.disableTitle') : t('controlBar.enableTitle')}
          className={ENABLE_BUTTON}
        >
          <Power className={ICON} style={{ color: enableColor }} />
          {enabled ? t('controlBar.disable') : t('controlBar.enable')}
        </Toggle>

        <Toggle
          variant="outline"
          pressed={zeroGravity}
          onPressedChange={toggleZeroGravity}
          title={zeroGravity ? t('controlBar.zeroGravityOnTitle') : t('controlBar.zeroGravityOffTitle')}
          className={ZERO_G_BUTTON}
        >
          <Feather className={ICON} />
          {t('modes.drag')}
        </Toggle>

        {/* 复位不锁状态：故障发生时它必须一点就有，不该先去想为什么它是灰的。 */}
        <Button
          type="button"
          variant="outline"
          onClick={reset}
          title={t('controlBar.resetTitle')}
          className={RESET_BUTTON}
        >
          <RotateCcw className={ICON} />
          {t('controlBar.reset')}
        </Button>

        {/* 清除故障挨着复位：轴级报警（过流、过温）恢复后先按它，复位是更重的一档。 */}
        <Button
          type="button"
          variant="outline"
          onClick={clearFault}
          title={t('controlBar.clearFaultTitle')}
          className={BIG_BUTTON}
        >
          <TriangleAlert className={ICON} />
          {t('controlBar.clearFault')}
        </Button>

        <Button
          type="button"
          variant="outline"
          onClick={zeroJoints}
          title={t('controlBar.homeTitle')}
          className={BIG_BUTTON}
        >
          <House className={ICON} />
          {t('controlBar.home')}
        </Button>

        <Button
          type="button"
          variant="outline"
          onClick={readyPose}
          title={t('controlBar.readyPoseTitle')}
          className={BIG_BUTTON}
        >
          <Target className={ICON} />
          {t('controlBar.readyPose')}
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

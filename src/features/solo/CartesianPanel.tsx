import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SegmentedControl, type SegItem } from '../../components/SegmentedControl'
import { DirectionPad, type PadCell } from '../../components/DirectionPad'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { MoveRight, RefreshCw, Compass } from 'lucide-react'

/** 步长选择器：标题行右侧的「平移: 10 mm / 旋转: 5 °」。 */
function StepPicker({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: readonly string[]
  onChange: (v: string) => void
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[0.75rem] text-muted-foreground">{label}:</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger size="sm" className="h-7 font-mono text-[0.8125rem] font-semibold">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((s) => (
            <SelectItem key={s} value={s}>
              {s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/** 目标位姿的一个数字输入：标签在上、输入在下，窄栏里两列也放得下。 */
function PoseField({
  label,
  value,
  step,
  onChange,
}: {
  label: string
  value: number
  step: string
  onChange: (v: number) => void
}) {
  return (
    <label className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate font-mono text-[0.59375rem] text-muted-foreground">{label}</span>
      <Input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-7 px-1.5 font-mono text-[0.71875rem]"
      />
    </label>
  )
}

/**
 * 笛卡尔空间 —— **左右两张卡片**，同屏并存，没有子模式页签要切：
 *
 * - 左：末端点位微调。图稿的形态，标题行右侧是两个步长选择器，正文是两个十字点动盘
 *   （见 `DirectionPad` 的 `PadCell`），中间那格写明这个盘是干什么的。参考坐标系由
 *   标题行的切换器表达，所以不再单独显示 BASE_LINK / TOOL0 徽标。
 * - 右：目标位姿 movel。绝对位姿输入 + 同步当前位姿 + 直线运动，竖着排一栏。
 *
 * ⚠ 窗口太窄时（单列放不下两个盘）右卡会换到左卡下方：宁可让表单掉下去，也不把
 * 点动盘压到按不准。
 */
export function CartesianPanel({
  simMode = false,
  /** 固件未编译笛卡尔规划（`conn.cart === false`）：两张卡都不可用。 */
  cartUnsupported = false,
  frames,
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
  cartUnsupported?: boolean
  frames: SegItem[]
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
  const [targetX, setTargetX] = useState<number>(0.32)
  const [targetY, setTargetY] = useState<number>(0)
  const [targetZ, setTargetZ] = useState<number>(0.45)
  const [targetRoll, setTargetRoll] = useState<number>(0)
  const [targetPitch, setTargetPitch] = useState<number>(1.57)
  const [targetYaw, setTargetYaw] = useState<number>(0)
  const [syncing, setSyncing] = useState(false)
  const [moving, setMoving] = useState(false)

  // 面板不可用的两种原因：仿真模式（不下发指令）与固件缺少笛卡尔规划。
  // 头部控件仍然可点，便于在不可用时查看坐标系/步长设置。
  const inactive = simMode || cartUnsupported
  const disabledStyle = inactive ? { opacity: 0.45, pointerEvents: 'none' as const } : undefined

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
    /* 左右两张卡：右卡固定 13rem，左卡吃掉其余宽度。用显式轨道而不是 flex 分配，
       两点动盘在左卡里居中，宽度不随右侧表单的内容漂移。
       注：根字号是流式的 clamp(13px, 1.522vh, 36px)，所以 13rem 在 900px 高的
       窗口下约 178px，不是 208px。 */
    <div className="grid flex-[1_1_auto] grid-cols-[minmax(0,1fr)_13rem] items-stretch gap-3">
      {/* 左：方向点动 */}
      <Card className="min-h-[15rem] gap-3 rounded-[0.875rem] px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 border-b pb-2.5">
          <div className="flex items-center gap-1.5 text-[0.90625rem] font-semibold text-foreground">
            <Compass className="size-4 text-primary" />
            {t('solo:cartesian.title')}
          </div>
          {simMode ? (
            <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[0.6875rem] font-medium text-warn">
              {t('solo:cartesian.simHint')}
            </span>
          ) : cartUnsupported ? (
            <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[0.6875rem] font-medium text-warn">
              {t('solo:cartesian.unsupportedHint')}
            </span>
          ) : null}

          <div className="flex-1" />

          <SegmentedControl
            items={frames}
            containerStyle={{ display: 'flex', gap: '0.1875rem', background: 'var(--line-soft)', borderRadius: '0.5625rem', padding: '0.1875rem' }}
            itemStyle={{ padding: '0.25rem 0.625rem', borderRadius: '0.4375rem', fontSize: '0.75rem', color: 'var(--ink-subtle)', fontWeight: 500 }}
            activeItemStyle={{ background: 'var(--seg-active)', color: 'var(--ink)', fontWeight: 600, boxShadow: '0 0.0625rem 0.125rem rgba(16,24,40,.08)' }}
          />
          <div className="h-5 w-px bg-line" />
          <div className="flex items-center gap-x-2.5">
            <StepPicker label={t('solo:cartesian.transTitle')} value={transStep} options={transSteps} onChange={setTransStep} />
            <StepPicker label={t('solo:cartesian.rotTitle')} value={rotStep} options={rotSteps} onChange={setRotStep} />
          </div>
        </div>

        <div className="flex min-h-0 flex-1 items-center justify-center gap-5 py-1" style={disabledStyle}>
          <div className="w-full min-w-0 max-w-[12rem]">
            <DirectionPad cells={transCells} onPress={onJogPress} onRelease={onJogRelease} />
          </div>
          <div className="w-full min-w-0 max-w-[12rem]">
            <DirectionPad cells={rotCells} onPress={onJogPress} onRelease={onJogRelease} />
          </div>
        </div>
      </Card>

      {/* 右：目标位姿直线运动 */}
      <Card className="flex min-w-0 flex-col gap-2.5 rounded-[0.875rem] px-3.5 py-3">
        <div className="flex items-center gap-1.5 text-[0.90625rem] font-semibold text-foreground">
          <MoveRight className="size-4 text-primary" />
          {t('solo:cartesian.targetSubMode')}
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleSyncPose}
          disabled={syncing || inactive}
          className="h-7 w-full gap-1 text-[0.6875rem]"
        >
          <RefreshCw className={`size-3 ${syncing ? 'animate-spin' : ''}`} />
          {t('solo:cartesian.syncCurrentPose')}
        </Button>

        <div className="grid grid-cols-2 gap-x-2 gap-y-2" style={disabledStyle}>
          <PoseField label="X (m)" value={targetX} step="0.005" onChange={setTargetX} />
          <PoseField label="Y (m)" value={targetY} step="0.005" onChange={setTargetY} />
          <PoseField label="Z (m)" value={targetZ} step="0.005" onChange={setTargetZ} />
          <PoseField label="Roll (rad)" value={targetRoll} step="0.05" onChange={setTargetRoll} />
          <PoseField label="Pitch (rad)" value={targetPitch} step="0.05" onChange={setTargetPitch} />
          <PoseField label="Yaw (rad)" value={targetYaw} step="0.05" onChange={setTargetYaw} />
        </div>

        <Button
          type="button"
          onClick={handleMovel}
          disabled={moving || inactive}
          className="mt-auto h-auto w-full gap-1 px-2 py-1.5 text-[0.71875rem] leading-tight whitespace-normal"
        >
          <MoveRight className="size-3.5 shrink-0" />
          {moving ? t('solo:cartesian.movelMoving') : t('solo:cartesian.movelBtn')}
        </Button>
      </Card>
    </div>
  )
}

import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { Card } from '@/components/ui/card'

export type PoseRow = { k: string; v: string; u: string }

function PoseCard({
  title,
  items,
  unavailable,
  style,
}: {
  title: string
  items: PoseRow[] | null
  unavailable?: string
  style?: CSSProperties
}) {
  return (
    <Card className="min-h-[5.5rem] gap-2 rounded-[0.875rem] px-3.5 py-3" style={style}>
      <div className="text-[0.90625rem] font-semibold text-foreground">{title}</div>
      {items ? (
        <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-2 gap-x-5 gap-y-1">
          {items.map((p) => (
            <div key={p.k} className="flex min-h-0 items-center justify-between border-b border-dashed">
              <div className="flex items-center gap-1.5">
                <div className="size-1.5 rounded-full bg-muted-foreground" />
                <div className="font-mono text-[0.78125rem] text-muted-foreground">{p.k}</div>
              </div>
              <div className="font-mono text-sm font-semibold text-foreground">
                {p.v}
                <span className="ml-[0.1875rem] text-[0.65625rem] text-muted-foreground">{p.u}</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="px-2 py-3 text-center text-[0.71875rem] leading-relaxed text-muted-foreground">
          {unavailable}
        </div>
      )}
    </Card>
  )
}

/**
 * 当前位姿 —— 关节与笛卡尔是**两张独立的卡片**，各自带标题，不再挤在一张卡里用页签切换。
 *
 * ⚠ 两张卡按各自的**行数**分配高度（两列网格下 7 轴 = 4 行、6 个笛卡尔量 = 3 行 ⇒ 4:3）。
 * 两者等分的话，关节那张的行距会明显小于笛卡尔那张，同一列里两种节奏。
 */
export function PoseCards({
  jointPose,
  cartPose,
}: {
  jointPose: PoseRow[]
  /** null = 固件没有笛卡尔规划，读不到 TCP 位姿（不是"还没读到"）。 */
  cartPose: PoseRow[] | null
}) {
  const { t } = useTranslation(['common', 'solo'])

  const jointRows = Math.max(1, Math.ceil(jointPose.length / 2))
  const cartRows = cartPose ? Math.max(1, Math.ceil(cartPose.length / 2)) : 0
  const total = jointRows + cartRows || 1

  return (
    <>
      <PoseCard
        title={t('solo:pose.jointTitle')}
        items={jointPose}
        style={{ flexGrow: jointRows / total, flexShrink: 1, flexBasis: 0 }}
      />
      <PoseCard
        title={t('solo:pose.cartTitle')}
        items={cartPose}
        unavailable={t('solo:cartesian.poseUnavailable')}
        style={
          cartPose
            ? { flexGrow: cartRows / total, flexShrink: 1, flexBasis: 0 }
            : { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' }
        }
      />
    </>
  )
}

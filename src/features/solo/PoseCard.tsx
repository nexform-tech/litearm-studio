import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { Card } from '@/components/ui/card'

export type PoseRow = { k: string; v: string; u: string }

function PoseGroup({
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
    <div className="flex min-h-0 flex-col" style={style}>
      <div className="mb-1 text-[0.6875rem] font-semibold tracking-wide text-muted-foreground">
        {title}
      </div>
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
    </div>
  )
}

/**
 * 当前位姿 —— 关节与笛卡尔**同时展示**，不再用页签二选一。
 *
 * ⚠ 两组按各自的**行数**分配高度（两列网格下 7 轴 = 4 行、6 个笛卡尔量 = 3 行 ⇒ 4:3）。
 * 若改成各占一半，关节那半的行距会比笛卡尔那半明显大一截，同一张卡里两种节奏。
 */
export function PoseCard({
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
    <Card className="min-h-[11rem] flex-1 gap-2 rounded-[0.875rem] px-3.5 py-3">
      <div className="text-[0.90625rem] font-semibold text-foreground">{t('common:currentPose')}</div>
      <PoseGroup
        title={t('solo:submodes.joint')}
        items={jointPose}
        style={{ flexGrow: jointRows / total, flexShrink: 1, flexBasis: 0 }}
      />
      <div className="border-t" />
      <PoseGroup
        title={t('solo:submodes.cartesian')}
        items={cartPose}
        unavailable={t('solo:cartesian.poseUnavailable')}
        style={
          cartPose
            ? { flexGrow: cartRows / total, flexShrink: 1, flexBasis: 0 }
            : { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' }
        }
      />
    </Card>
  )
}

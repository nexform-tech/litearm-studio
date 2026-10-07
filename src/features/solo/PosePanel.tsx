import { useTranslation } from 'react-i18next'
import { Card } from '@/components/ui/card'

export type PoseRow = { k: string; v: string; u: string }

/**
 * 当前位姿 —— 关节与笛卡尔是**同一张卡片的左右两栏**。
 *
 * 老版本是两张各自带标题的卡片上下叠着，同一列里两套节奏；合并后只留一个标题、
 * 一行空隙，J1–J7 与 X/Y/Z/RX/RY/RZ 逐行对齐，扫一眼就能把关节角和 TCP 位姿对上。
 *
 * ⚠ 两栏行数不同（7 轴 = 7 行、6 个笛卡尔量 = 6 行），所以是两列各自堆叠，
 * 不是按行配对的网格——配对网格会在最后一格留一个空位。
 */
export function PosePanel({
  jointPose,
  cartPose,
}: {
  jointPose: PoseRow[]
  /** null = 固件没有笛卡尔规划，读不到 TCP 位姿（不是"还没读到"）。 */
  cartPose: PoseRow[] | null
}) {
  const { t } = useTranslation(['common', 'solo'])

  return (
    <Card className="flex-none gap-2 rounded-[0.875rem] px-3.5 py-3">
      <div className="text-[0.90625rem] font-semibold text-foreground">{t('common:currentPose')}</div>
      <div className="grid min-h-0 grid-cols-2 gap-x-5">
        <PoseColumn items={jointPose} />
        {cartPose ? (
          <PoseColumn items={cartPose} />
        ) : (
          <div className="flex items-center px-2 text-center text-[0.71875rem] leading-relaxed text-muted-foreground">
            {t('solo:cartesian.poseUnavailable')}
          </div>
        )}
      </div>
    </Card>
  )
}

function PoseColumn({ items }: { items: PoseRow[] }) {
  return (
    <div className="flex min-h-0 flex-col">
      {items.map((p) => (
        <div key={p.k} className="flex min-h-0 items-center justify-between border-b border-dashed py-[0.1875rem]">
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
  )
}

import { useTranslation } from 'react-i18next'
import { SegmentedControl, type SegItem } from '../../components/SegmentedControl'
import { Card } from '@/components/ui/card'

export function PoseCard({ poseTabs, pose }: { poseTabs: SegItem[]; pose: { k: string; v: string; u: string }[] }) {
  const { t } = useTranslation(['common', 'solo'])

  return (
    <Card className="min-h-[11rem] flex-1 rounded-[0.875rem] px-3.5 py-3">
      <div className="mb-2.5 flex items-center justify-between">
        <div className="text-[0.90625rem] font-semibold text-foreground">{t('common:currentPose')}</div>
        <SegmentedControl
          items={poseTabs}
          containerStyle={{ display: 'flex', gap: '0.25rem', background: 'var(--line-soft)', borderRadius: '0.5rem', padding: '0.125rem' }}
          itemStyle={{ padding: '0.1875rem 0.625rem', borderRadius: '0.375rem', fontSize: '0.71875rem', color: 'var(--ink-subtle)', fontWeight: 500 }}
          activeItemStyle={{ background: 'var(--seg-active)', color: 'var(--ink)', fontWeight: 600, boxShadow: '0 0.0625rem 0.125rem rgba(16,24,40,.08)' }}
        />
      </div>
      {/* `auto-rows-fr` + `flex-1`：曲线搬走后这张卡吃掉左列剩余高度，每一行等分，
          读数行距随之拉开，而不是在卡底留一块空白。 */}
      <div className="grid flex-1 auto-rows-fr grid-cols-2 gap-x-5 gap-y-1.5">
        {pose.map((p) => (
          <div key={p.k} className="flex items-baseline justify-between border-b border-dashed pb-1">
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
    </Card>
  )
}

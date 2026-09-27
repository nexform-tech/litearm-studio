import { useTranslation } from 'react-i18next'
import { SegmentedControl, type SegItem } from '../../components/SegmentedControl'
import { Card } from '@/components/ui/card'

export function PoseCard({ poseTabs, pose }: { poseTabs: SegItem[]; pose: { k: string; v: string; u: string }[] }) {
  const { t } = useTranslation(['common', 'solo'])

  return (
    <Card className="flex-none rounded-[0.875rem] px-3.5 py-3">
      <div className="mb-2.5 flex items-center justify-between">
        <div className="text-[0.90625rem] font-semibold text-foreground">{t('common:currentPose')}</div>
        <SegmentedControl
          items={poseTabs}
          containerStyle={{ display: 'flex', gap: '0.25rem', background: 'var(--line-soft)', borderRadius: '0.5rem', padding: '0.125rem' }}
          itemStyle={{ padding: '0.1875rem 0.625rem', borderRadius: '0.375rem', fontSize: '0.71875rem', color: 'var(--ink-subtle)', fontWeight: 500 }}
          activeItemStyle={{ background: 'var(--seg-active)', color: 'var(--ink)', fontWeight: 600, boxShadow: '0 0.0625rem 0.125rem rgba(16,24,40,.08)' }}
        />
      </div>
      <div className="grid grid-cols-2 gap-x-5 gap-y-1.5">
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

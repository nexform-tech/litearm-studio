import type { CSSProperties } from 'react'
import { Card, CardContent } from '@/components/ui/card'

export function StatCard({
  k,
  v,
  u,
  valueColor,
  padding = '0.5rem 0.5625rem',
  valueFontSize = 16,
  style,
}: {
  k: string
  v: string | number
  u?: string
  valueColor?: string
  padding?: string
  valueFontSize?: number
  style?: CSSProperties
}) {
  return (
    <Card className="gap-0 rounded-[0.625rem] bg-muted py-0 ring-0" style={style}>
      <CardContent style={{ padding }} className="flex flex-col gap-0.5">
        <div className="text-[0.6875rem] text-muted-foreground">{k}</div>
        <div className="flex items-baseline gap-[0.1875rem]">
          <div
            className="font-mono font-bold text-foreground"
            style={{ fontSize: valueFontSize, color: valueColor }}
          >
            {v}
          </div>
          {u ? <div className="font-mono text-[0.625rem] text-muted-foreground">{u}</div> : null}
        </div>
      </CardContent>
    </Card>
  )
}

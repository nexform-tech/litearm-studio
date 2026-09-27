import type { CSSProperties, ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'

/**
 * Rounded status badge built on shadcn's `Badge`, with an optional leading dot.
 * Still accepts arbitrary bg/fg/border colors so per-status callers (未迁移到
 * `Badge` variant 的调用点) keep working; new call sites should prefer
 * `<Badge variant="...">` directly.
 */
export function Pill({
  dot,
  bg,
  fg,
  bd,
  padding,
  fontSize = 12.5,
  fontWeight = 600,
  children,
  style,
}: {
  dot?: string
  bg?: string
  fg?: string
  bd?: string
  padding?: string
  fontSize?: number
  fontWeight?: number
  children: ReactNode
  style?: CSSProperties
}) {
  return (
    <Badge
      variant="outline"
      className="h-auto gap-[0.4375rem] rounded-full"
      style={{
        background: bg,
        borderColor: bd,
        padding,
        ...style,
      }}
    >
      {dot ? <div style={{ width: '0.4375rem', height: '0.4375rem', borderRadius: '50%', background: dot }} /> : null}
      <span style={{ fontSize, color: fg, fontWeight }}>{children}</span>
    </Badge>
  )
}

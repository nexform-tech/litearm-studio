import { Badge } from '@/components/ui/badge'


const LEVEL_STYLE: Record<string, { bg: string; fg: string; bd: string }> = {
  DEBUG: { bg: 'var(--line-soft)', fg: 'var(--ink-soft)', bd: 'var(--line)' },
  INFO: { bg: 'var(--info-soft)', fg: 'var(--info)', bd: 'var(--info-line)' },
  WARNING: { bg: 'var(--warn-soft)', fg: 'var(--warn)', bd: 'var(--warn-line)' },
  ERROR: { bg: 'var(--danger-soft)', fg: 'var(--danger)', bd: 'var(--danger-line)' },
  CRITICAL: { bg: 'var(--danger-soft)', fg: 'var(--danger)', bd: 'var(--danger-line)' },
  info: { bg: 'var(--info-soft)', fg: 'var(--info)', bd: 'var(--info-line)' },
  warn: { bg: 'var(--warn-soft)', fg: 'var(--warn)', bd: 'var(--warn-line)' },
  error: { bg: 'var(--danger-soft)', fg: 'var(--danger)', bd: 'var(--danger-line)' },
}

export function LogLevelBadge({ level }: { level: string }) {
  const s = LEVEL_STYLE[level.toUpperCase()] ?? LEVEL_STYLE[level] ?? LEVEL_STYLE.INFO
  return (
    <Badge
      variant="outline"
      className="h-auto rounded-full px-2.5 py-0.5 text-[0.71875rem] font-semibold"
      style={{ color: s.fg, background: s.bg, borderColor: s.bd }}
    >
      {level.toUpperCase()}
    </Badge>
  )
}

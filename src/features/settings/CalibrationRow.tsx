import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { CalibrationCandidate, CalibrationSource } from '@/lib/arm/gripperClient'

const SOURCE_KEYS: Record<CalibrationSource, string> = {
  measured: 'gripper:source.measured',
  template: 'gripper:source.template',
  factory: 'gripper:source.factory',
  missing: 'gripper:source.missing',
}

/**
 * 一份标定候选的**展示**行 —— 浏览对话框里用它渲染每个 `*.json` 文件。
 *
 * 抽出来是为了让"行渲染只有一份"由**构造**保证，而不是靠复制粘贴去维持：字段/
 * 措辞改动只落一处。给它 `onSelect` 就变成可点的一行（对话框里用它选文件）。
 */
export function CalibrationRow({
  row,
  inUse,
  onSelect,
}: {
  row: CalibrationCandidate
  /** 覆盖 `row.inUse`（daemon 已经标注"生效中"，这里可再覆盖）。 */
  inUse?: boolean
  onSelect?: (path: string) => void
}) {
  const { t } = useTranslation(['gripper'])
  const active = inUse ?? row.inUse ?? false

  const body = (
    <>
      <div className="flex items-center gap-2">
        <Badge
          variant={row.valid ? 'outline' : 'destructive'}
          className="h-auto rounded-full px-2 py-0 text-[0.65625rem] font-semibold"
        >
          {row.valid ? t('gripper:settings.valid') : t('gripper:settings.invalid')}
        </Badge>
        <span className="text-[0.75rem] font-semibold text-ink-strong">{t(SOURCE_KEYS[row.source])}</span>
        {row.template ? (
          <span className="font-mono text-[0.65625rem] text-muted-foreground">{row.template}</span>
        ) : null}
        {active ? (
          <Badge variant="success" className="h-auto rounded-full px-2 py-0 text-[0.65625rem] font-semibold">
            {t('gripper:settings.inUse')}
          </Badge>
        ) : null}
      </div>
      <div className="truncate font-mono text-[0.65625rem] text-muted-foreground" title={row.path}>
        {row.path}
      </div>
      <div className="flex flex-wrap gap-3 font-mono text-[0.65625rem] text-muted-foreground">
        <span>
          {t('gripper:source.closed')} {row.closedRad == null ? '—' : row.closedRad.toFixed(4)}
        </span>
        <span>
          {t('gripper:source.open')} {row.openRad == null ? '—' : row.openRad.toFixed(4)}
        </span>
        <span>
          {t('gripper:source.derived')} {row.fileRadToMm == null ? '—' : row.fileRadToMm.toFixed(2)}
        </span>
      </div>
      {row.problems.length ? (
        <div className="text-[0.65625rem] text-destructive">
          {t('gripper:settings.problems')}: {row.problems.join('；')}
        </div>
      ) : null}
      {row.warnings.length ? (
        <div className="text-[0.65625rem] text-warn">
          {t('gripper:settings.warnings')}: {row.warnings.join('；')}
        </div>
      ) : null}
    </>
  )

  const className = 'flex w-full flex-col gap-1 rounded-lg border border-line px-3 py-2'

  if (onSelect) {
    return (
      <button
        type="button"
        data-testid="gripper-browse-file"
        className={cn(className, 'text-left transition-colors hover:bg-muted/60')}
        onClick={() => onSelect(row.path)}
      >
        {body}
      </button>
    )
  }
  return <div className={className}>{body}</div>
}

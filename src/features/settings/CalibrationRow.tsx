import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import type { CalibrationCandidate, CalibrationSource } from '@/lib/arm/gripperClient'

const SOURCE_KEYS: Record<CalibrationSource, string> = {
  measured: 'gripper:source.measured',
  template: 'gripper:source.template',
  factory: 'gripper:source.factory',
  missing: 'gripper:source.missing',
}

/**
 * 一份标定候选的**展示**行 —— 设置页清单里的只读一行。
 *
 * ⚠ 曾经与页内的浏览对话框共用同一份 markup；选择器改成控制机的原生对话框之后
 * （见 `lib/pickFile.ts`），这里不再需要可点的分支。
 */
export function CalibrationRow({
  row,
  inUse,
}: {
  row: CalibrationCandidate
  /** 覆盖 `row.inUse`；设置页用它把 `activePath` 也算进来。 */
  inUse?: boolean
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

  return <div className={className}>{body}</div>
}

import { useTranslation } from 'react-i18next'
import { ArrowUp, Folder, House } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { hasCandidate } from '@/lib/arm/gripperClient'
import { CalibrationRow } from './CalibrationRow'
import { useGripperBrowse } from './useGripperBrowse'

/**
 * 目录/文件选择对话框 —— 列的是**控制机**（运行 daemon 那台机器）的文件系统。
 *
 * 为什么不是浏览器的文件对话框：`gripper.import_calibration` 要的是一个**主机路径**
 * （daemon pin 住它、重连时按路径重新解析），而 `File` 对象给不出真实路径。只有
 * daemon 能枚举并校验它自己那台机器上的文件。标题与说明里都写明这一点 —— 操作员
 * 人可能在另一台机器上，这个区别必须显眼。
 *
 * 选中一份 `*.json` 就回调它的路径并关闭：路径写回设置页**同一个**输入框，导入流程
 * 一行不改。
 */
export function GripperBrowserDialog({
  open,
  onOpenChange,
  onPick,
  initialPath,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 选中一个文件：把它的绝对路径交回去。 */
  onPick: (path: string) => void
  /** 打开时先落到的目录（由所输路径推出）；缺省或推不出就回家目录。 */
  initialPath?: string
}) {
  const { t } = useTranslation(['common', 'gripper'])
  const vm = useGripperBrowse(open, initialPath)

  const pick = (path: string) => {
    onPick(path)
    onOpenChange(false)
  }

  /**
   * 这一层里**列不出来**的东西 (issue #103)。
   *
   * 选择器只显示子目录与 `*.json` —— 这是有意的，但它在界面上看不见。于是"我的标定
   * 就在这个目录里"与"这个目录什么都没有"长得一模一样，操作员只能得出后一个结论。
   * 把数出来的条数说出来，并指一下旁边的输入框，那条出路才存在。
   */
  const hiddenHint = vm.skippedFiles > 0 ? (
    <p data-testid="gripper-browse-skipped" className="text-[0.6875rem] text-warn">
      {t('gripper:settings.browseSkipped', { count: vm.skippedFiles })}
    </p>
  ) : null

  /** 能画出来的行。⚠ 与 `hiddenHint` 同理: 一条都画不出来时必须说话, 不能留白框。 */
  const rows = vm.entries.map((entry) =>
    entry.type === 'dir' ? (
      <li key={entry.path}>
        <button
          type="button"
          data-testid="gripper-browse-dir"
          disabled={!entry.readable}
          onClick={() => vm.navigate(entry.path)}
          className="flex w-full items-center gap-2 rounded-lg border border-line px-3 py-2 text-left transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Folder className="size-4 flex-none text-muted-foreground" />
          <span className="truncate text-[0.75rem]">{entry.name}</span>
          {entry.symlink ? (
            <span className="flex-none text-[0.625rem] text-muted-foreground">↗</span>
          ) : null}
        </button>
      </li>
    ) : hasCandidate(entry) ? (
      <li key={entry.path}>
        <CalibrationRow row={entry} onSelect={pick} />
      </li>
    ) : null,
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85vh] max-w-lg overflow-y-auto"
        data-testid="gripper-browse-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t('gripper:settings.browseTitle')}</DialogTitle>
          <DialogDescription>{t('gripper:settings.browseDesc')}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          {/* 仓库没有 Breadcrumb 原语：路径栏就是一行可截断的等宽文本 + Up/Home。 */}
          <div
            data-testid="gripper-browse-path"
            className="min-w-0 flex-1 truncate rounded-md border border-line bg-muted/40 px-2 py-1 font-mono text-[0.6875rem] text-muted-foreground"
            title={vm.dir ?? ''}
          >
            {vm.dir ?? '—'}
          </div>
          <Button
            data-testid="gripper-browse-up"
            size="sm"
            variant="outline"
            aria-label={t('gripper:settings.home')}
            disabled={vm.parent == null}
            onClick={vm.up}
          >
            <ArrowUp className="size-3.5" />
          </Button>
          <Button
            data-testid="gripper-browse-home"
            size="sm"
            variant="outline"
            onClick={() => vm.navigate('')}
          >
            <House className="size-3.5" />
            {t('gripper:settings.home')}
          </Button>
        </div>

        {vm.loading ? (
          <p className="text-xs text-muted-foreground">{t('common:loading')}</p>
        ) : vm.error ? (
          <p data-testid="gripper-browse-error" className="text-xs text-destructive">
            {vm.error}
          </p>
        ) : rows.every((row) => row === null) ? (
          // ⚠ 判据是"一行都画不出来", 不是"daemon 没给条目" —— 两者都会留下一个空框,
          // 而空框不解释任何事。
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">{t('gripper:settings.browseEmpty')}</p>
            {hiddenHint}
          </div>
        ) : (
          <ul data-testid="gripper-browse-entries" className="flex flex-col gap-2">
            {vm.truncated ? (
              <li className="text-[0.6875rem] text-warn">{t('gripper:settings.browseTruncated')}</li>
            ) : null}
            {rows}
            {hiddenHint ? <li>{hiddenHint}</li> : null}
          </ul>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

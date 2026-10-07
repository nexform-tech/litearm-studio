import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, X, Send } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { jointRangeLabel } from './soloUtils'

type Joint = { key: number; name: string; val: string; pct: number; dot: string; dotRing: string; dotTitle: string }

export function JointSpacePanel({
  joints,
  releaseOnly,
  toggleReleaseOnly,
  disabled,
  onDispatch,
  onDispatchAll,
  radOfPct,
}: {
  joints: Joint[]
  releaseOnly: boolean
  toggleReleaseOnly: () => void
  disabled: boolean
  onDispatch: (key: number, pct: number) => void
  onDispatchAll: (targetPct: number[]) => void
  radOfPct: (pct: number, joint: number) => string
}) {
  const { t } = useTranslation('solo')
  // “松手即下发”关闭时，各关节滑条调整后的暂存值（以关节 key 为索引）
  const [staged, setStaged] = useState<Record<number, number>>({})

  // 切回“松手即下发”时丢弃尚未发送的暂存值，避免界面显示与实际姿态不一致
  useEffect(() => {
    if (releaseOnly) setStaged({})
  }, [releaseOnly])

  const stage = (key: number, pct: number) =>
    setStaged((prev) => {
      const next = { ...prev, [key]: pct }
      const current = joints.find((j) => j.key === key)?.pct
      if (current !== undefined && next[key] === current) delete next[key]
      return next
    })

  // 立即下发某个关节并清掉它的暂存值（松手即下发模式直接走这里）
  const commit = (key: number, pct: number) => {
    onDispatch(key, pct)
    setStaged((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  const sendAll = () => {
    // 以当前姿态为基准，覆盖所有暂存值，合成完整目标后只发一次 movej
    const base = joints.map((j) => j.pct)
    const entries = Object.entries(staged)
    const target = base.map((v, i) => (entries.length ? (staged[i] ?? v) : v))
    onDispatchAll(target)
    setStaged({})
  }

  return (
    <Card className="flex-none gap-2.5 rounded-[0.875rem] px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-[0.5625rem]">
          <div className="text-[0.90625rem] font-semibold text-foreground">{t('jointSpace.title')}</div>
          <div className="text-xs text-muted-foreground">{jointRangeLabel(joints.length)}</div>
        </div>
        <div className="flex flex-wrap items-center gap-[0.5625rem]">
          {!releaseOnly && (
            <Button
              type="button"
              size="sm"
              onClick={sendAll}
              title={t('jointSpace.sendTitle')}
              className="h-auto gap-1 rounded-[0.4375rem] px-2.5 py-1 text-[0.78125rem]"
            >
              <Send size="0.75rem" />
              {t('jointSpace.send')}
            </Button>
          )}
          <button
            type="button"
            onClick={toggleReleaseOnly}
            title={t('jointSpace.releaseOnlyTitle')}
            className="flex items-center gap-[0.4375rem] text-[0.78125rem] text-ink-soft transition-opacity hover:opacity-80"
          >
            <span
              className={cn(
                'inline-flex size-[0.9375rem] items-center justify-center rounded text-chip-fg transition-colors',
                releaseOnly ? 'bg-ink-muted' : 'bg-line-strong',
              )}
            >
              {releaseOnly ? <Check size="0.625rem" /> : <X size="0.625rem" />}
            </span>
            {t('jointSpace.releaseOnly')}
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-0.5">
        {joints.map((j) => (
          <JointRow
            key={j.key}
            joint={j}
            releaseOnly={releaseOnly}
            disabled={disabled}
            staged={staged[j.key] ?? null}
            onStage={(pct) => stage(j.key, pct)}
            onCommit={(pct) => commit(j.key, pct)}
            radOfPct={radOfPct}
          />
        ))}
      </div>
    </Card>
  )
}

function JointRow({
  joint,
  releaseOnly,
  disabled,
  staged,
  onStage,
  onCommit,
  radOfPct,
}: {
  joint: Joint
  releaseOnly: boolean
  disabled: boolean
  staged: number | null
  onStage: (pct: number) => void
  onCommit: (pct: number) => void
  radOfPct: (pct: number, joint: number) => string
}) {
  // “松手即下发”开启时拖动/步进直接下发；关闭时数值先暂存，等待右上角“发送”统一下发
  const shown = staged ?? joint.pct

  return (
    <div className="flex items-center gap-[0.5625rem] border-b border-line-soft py-[0.3125rem]">
      <div title={joint.dotTitle} className="flex w-[4.125rem] flex-none items-center gap-[0.4375rem]">
        <div className="size-[0.4375rem] flex-none rounded-full" style={{ background: joint.dot, boxShadow: joint.dotRing }} />
        <div className="text-[0.8125rem] font-semibold text-ink-strong">{joint.name}</div>
      </div>
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        size="icon"
        onClick={() => (releaseOnly ? onCommit(Math.max(0, shown - 1)) : onStage(Math.max(0, shown - 1)))}
        className="size-[1.375rem] rounded-md text-[0.8125rem] text-muted-foreground disabled:opacity-100"
      >
        −
      </Button>
      <Slider
        value={[shown]}
        disabled={disabled}
        onValueChange={([v]) => onStage(v)}
        onValueCommit={([v]) => (releaseOnly ? onCommit(v) : onStage(v))}
        className="flex-1"
      />
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        size="icon"
        onClick={() => (releaseOnly ? onCommit(Math.min(100, shown + 1)) : onStage(Math.min(100, shown + 1)))}
        className="size-[1.375rem] rounded-md text-[0.8125rem] text-muted-foreground disabled:opacity-100"
      >
        +
      </Button>
      {/* 百分比读数：滑条量程是软限位，弧度只说明"现在在哪"，百分比说明"还差多少" */}
      <div className="w-[2.5rem] flex-none text-right font-mono text-[0.75rem] text-muted-foreground">
        {Math.round(shown)}%
      </div>
      <div className="w-[4.5rem] rounded-[0.4375rem] border bg-muted/40 px-2 py-1 text-right font-mono text-[0.8125rem] text-foreground">
        {radOfPct(shown, joint.key)}
      </div>
    </div>
  )
}

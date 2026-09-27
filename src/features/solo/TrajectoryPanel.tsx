import { RefreshCw, Circle, Play, Trash2, Square, Repeat } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { SegmentedControl, type SegItem } from '../../components/SegmentedControl'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Toggle } from '@/components/ui/toggle'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

type TrajItem = {
  key: string
  i: string
  name: string
  meta: string
  dur: string
  pts: string
  expanded: boolean
  select?: () => void
  play?: () => void
  opacity: number
  cursor: string
  playFg: string
  bg: string
  bd: string
  idxBg: string
  idxFg: string
  remove: () => void
}

export function TrajectoryPanel({
  simMode = false,
  traj,
  trajName,
  setTrajName,
  recording,
  toggleRecording,
  refreshTraj,
  recElapsed,
  recOpacity,
  recEvents,
  playing,
  playBtnLabel,
  playBtnBg,
  playBtnFg,
  playBtnBd,
  togglePlay,
  stopPlay,
  toggleLoop,
  loop,
  loopBd,
  loopBg,
  loopFg,
  rates,
  lockNote,
  lockFg,
  pendingDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  simMode?: boolean
  traj: TrajItem[]
  trajName: string
  setTrajName: (v: string) => void
  recording: boolean
  toggleRecording: () => void
  refreshTraj: () => void
  recElapsed: string
  recOpacity: number
  recEvents: 'auto' | 'none'
  playing: boolean
  playBtnLabel: string
  playBtnBg: string
  playBtnFg: string
  playBtnBd: string
  togglePlay: () => void
  stopPlay: () => void
  toggleLoop: () => void
  loop: boolean
  loopBd: string
  loopBg: string
  loopFg: string
  rates: SegItem[]
  lockNote: string
  lockFg: string
  pendingDelete: { id: string; name: string } | null
  onCancelDelete: () => void
  onConfirmDelete: () => void
}) {
  const { t } = useTranslation(['common', 'solo'])
  const listRef = useRef<HTMLDivElement>(null)
  const expandedSig = traj.map((tItem) => `${tItem.key}:${tItem.expanded ? 1 : 0}`).join('|')

  // 展开回放区（点行或点播放键）时，把当前项滚进列表可视区，
  // 保证进度条/停止/循环/倍速等回放控件完整可见，而不是被列表底部裁掉。
  useEffect(() => {
    const openItem = listRef.current?.querySelector<HTMLElement>('[data-open="true"]')
    openItem?.scrollIntoView({ block: 'nearest' })
  }, [expandedSig])

  return (
    <Card
      className="min-h-[17.5rem] flex-1 gap-[0.6875rem] rounded-[0.875rem] px-3.5 py-3.5"
      style={simMode ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="text-[0.90625rem] font-semibold text-foreground">
            {t('solo:trajectory.title')}{' '}
            <span className="text-[0.8125rem] font-medium text-muted-foreground">{traj.length}</span>
          </div>
          {simMode ? (
            <div className="rounded-full bg-warn-soft px-2 py-0.5 text-[0.6875rem] font-medium text-warn">
              {t('solo:trajectory.simHint')}
            </div>
          ) : null}
        </div>
        <div className="flex gap-2.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={refreshTraj}
            className="h-auto gap-1 px-1.5 py-1 text-xs text-muted-foreground"
          >
            <RefreshCw size="0.75rem" />
            {t('solo:trajectory.refresh')}
          </Button>
        </div>
      </div>

      <div
        className="flex items-center gap-2.5 rounded-[0.6875rem] border bg-muted/30 py-2 pr-2.5 pl-3"
        style={{ opacity: recOpacity, pointerEvents: recEvents }}
      >
        <input
          value={trajName}
          onChange={(e) => setTrajName(e.target.value)}
          disabled={recording}
          placeholder={t('solo:trajectory.namePlaceholder')}
          className="min-w-0 flex-1 bg-transparent text-[0.8125rem] text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-60"
        />
        <div className="font-mono text-xs text-muted-foreground">{recElapsed}</div>
        <Button
          type="button"
          onClick={toggleRecording}
          className="h-9 gap-[0.4375rem] rounded-[0.5625rem] px-[0.9375rem] text-[0.84375rem] font-semibold"
          style={recording ? { background: 'var(--danger-soft)', color: 'var(--danger)' } : undefined}
        >
          <Circle size="0.625rem" color="#f0424a" fill="#f0424a" />
          {recording ? t('solo:trajectory.stopAndSave') : t('solo:trajectory.record')}
        </Button>
      </div>

      <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
        {traj.map((tItem) => (
          <div
            key={tItem.key}
            data-open={tItem.expanded ? 'true' : undefined}
            onClick={tItem.select}
            className="shrink-0 overflow-hidden rounded-[0.6875rem] border transition-colors hover:border-line"
            style={{ borderColor: tItem.bd, background: tItem.bg, cursor: tItem.cursor, opacity: tItem.opacity }}
          >
            <div className="flex items-center gap-2.5 px-[0.6875rem] py-2.5">
              <div
                className="flex size-[1.625rem] items-center justify-center rounded-[0.4375rem] font-mono text-[0.6875rem]"
                style={{ background: tItem.idxBg, color: tItem.idxFg }}
              >
                {tItem.i}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[0.8125rem] font-semibold text-foreground">{tItem.name}</div>
                <div className="font-mono text-[0.6875rem] text-muted-foreground">
                  {tItem.meta} · {tItem.dur} · {tItem.pts}
                </div>
              </div>
              <div className="flex gap-[0.3125rem]">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={(e) => {
                    e.stopPropagation()
                    tItem.play?.()
                  }}
                  className="size-[1.625rem] rounded-[0.4375rem]"
                  style={{ color: tItem.playFg }}
                >
                  <Play size="0.6875rem" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={(e) => {
                    e.stopPropagation()
                    tItem.remove()
                  }}
                  className="size-[1.625rem] rounded-[0.4375rem] text-muted-foreground"
                >
                  <Trash2 size="0.6875rem" />
                </Button>
              </div>
            </div>

            {tItem.expanded ? (
              <div className="flex flex-col gap-2.5 px-[0.6875rem] pb-[0.6875rem]">
                {playing ? (
                  <div className="flex items-center gap-1.5 text-[0.75rem] font-semibold text-ok">
                    <span className="size-1.5 rounded-full bg-ok" />
                    {t('solo:trajectory.playing')}
                  </div>
                ) : null}
                <div className="flex gap-[0.4375rem]" onClick={(e) => e.stopPropagation()}>
                  <Button
                    type="button"
                    onClick={togglePlay}
                    className="h-[2.375rem] flex-1 gap-[0.4375rem] rounded-[0.5625rem] text-[0.84375rem] font-semibold"
                    style={{ background: playBtnBg, color: playBtnFg, border: `0.0625rem solid ${playBtnBd}` }}
                  >
                    {playBtnLabel}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={stopPlay}
                    className="h-[2.375rem] w-[2.625rem] rounded-[0.5625rem] text-ink-soft"
                  >
                    <Square size="0.6875rem" />
                  </Button>
                  <Toggle
                    pressed={loop}
                    onPressedChange={toggleLoop}
                    className="h-[2.375rem] w-[2.625rem] rounded-[0.5625rem] hover:bg-transparent"
                    style={{ border: `0.0625rem solid ${loopBd}`, background: loopBg, color: loopFg }}
                  >
                    <Repeat size="0.8125rem" />
                  </Toggle>
                  <SegmentedControl
                    items={rates}
                    containerStyle={{ display: 'flex', gap: '0.125rem', background: 'var(--line-soft)', borderRadius: '0.5625rem', padding: '0.125rem' }}
                    itemStyle={{
                      padding: '0 0.5rem',
                      display: 'flex',
                      alignItems: 'center',
                      borderRadius: '0.4375rem',
                      fontFamily: "'JetBrains Mono',monospace",
                      fontSize: '0.6875rem',
                      color: 'var(--ink-subtle)',
                      fontWeight: 500,
                    }}
                    activeItemStyle={{ background: 'var(--seg-active)', color: 'var(--ink)', fontWeight: 700, boxShadow: '0 0.0625rem 0.125rem rgba(16,24,40,.08)' }}
                  />
                </div>
                <div className="text-[0.71875rem] leading-[1.35]" style={{ color: lockFg }}>
                  {lockNote}
                </div>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <Dialog open={pendingDelete != null} onOpenChange={(open) => !open && onCancelDelete()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('solo:trajectory.deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('solo:trajectory.deleteConfirmText', { name: pendingDelete?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={onCancelDelete}>
              {t('common:cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={onConfirmDelete}>
              {t('common:delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

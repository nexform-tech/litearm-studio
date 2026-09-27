import { Suspense, forwardRef, lazy, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Box, Maximize2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { SegmentedControl, type SegItem } from '../../components/SegmentedControl'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import type { RobotViewportHandle } from '@/components/RobotViewport'
import { armClient } from '@/lib/arm'
import type { PreviewFeed } from './useSoloState'

const HOME_Q = [0, 0, 0, 0, 0, 0, 0]

// 3D 视口按需加载：three.js / urdf-loader 体积大（压缩后约数百 KB），
// 只在进入机械臂控制台、真正需要渲染模型时才下载，避免拖慢首屏与其它页面。
const RobotViewport = lazy(() => import('@/components/RobotViewport').then((m) => ({ default: m.RobotViewport })))

export function PreviewPanel(vm: { viewTabs: SegItem[]; viewBadge: string; preview: PreviewFeed }) {
  const { t } = useTranslation(['common', 'solo'])
  const [showAxes, setShowAxes] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const miniRef = useRef<RobotViewportHandle>(null)
  const expandedRef = useRef<RobotViewportHandle>(null)

  // 实机模式下最后一次广播的实际关节角：切到仿真时用它作为起始姿态，
  // 避免模型从零点或旧指令姿态跳变。
  const lastRealQRef = useRef<number[] | null>(null)
  // 仿真的当前展示姿态，在 rAF 循环里本地插值，不经过 React 渲染循环。
  const simQRef = useRef<number[] | null>(null)
  const targetQRef = useRef<number[] | null>(null)
  targetQRef.current = vm.preview.mode === 'sim' ? vm.preview.q : null

  // 离开仿真模式时清掉插值进度，下次进入仿真重新从实机姿态起步；
  // 仿真内部（如速度滑块变化）重跑动画 effect 时则保留当前进度，避免跳变。
  useEffect(() => {
    if (vm.preview.mode === 'real') simQRef.current = null
  }, [vm.preview.mode])

  // 实机：3D 直接订阅 60Hz 原始状态广播，命令式驱动模型（imperative ref 调用）。
  // 走 subscribeStateFast 每帧通道：既不经过 React 渲染循环，也不受 10Hz 降频影响。
  useEffect(() => {
    if (vm.preview.mode !== 'real') return
    const apply = () => {
      const q = armClient.state?.q
      if (!q) return
      lastRealQRef.current = q
      miniRef.current?.setJointPositions(q)
      expandedRef.current?.setJointPositions(q)
    }
    apply()
    return armClient.subscribeStateFast(apply)
  }, [vm.preview.mode])

  // 仿真：以平滑插值让模型逐步趋近纯前端虚拟姿态（jointPct），未连接时也能预览。
  useEffect(() => {
    if (vm.preview.mode !== 'sim') return
    if (!simQRef.current) {
      simQRef.current = [...(lastRealQRef.current ?? targetQRef.current ?? HOME_Q)]
    }
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1)
      last = now
      const sim = simQRef.current!
      const target = targetQRef.current
      if (target) {
        // 跟手：固定使用足够快的趋近速率（约 0.05s 到达 63%），
        // 让模型几乎立即跟上指令姿态，不受速度滑块拖慢。
        const k = 1 - Math.exp(-dt * 20)
        for (let i = 0; i < sim.length; i++) {
          sim[i] += (target[i] - sim[i]) * k
        }
      }
      miniRef.current?.setJointPositions(sim)
      expandedRef.current?.setJointPositions(sim)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
    }
  }, [vm.preview.mode])

  const focusAll = () => {
    miniRef.current?.focus()
    expandedRef.current?.focus()
  }
  const topViewAll = () => {
    miniRef.current?.topView()
    expandedRef.current?.topView()
  }

  return (
    <Card className="flex-none gap-2.5 rounded-[0.875rem] p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[0.90625rem] font-semibold text-foreground">
          <Box size="0.9375rem" /> {t('solo:preview.title')}
        </div>
        <SegmentedControl
          items={vm.viewTabs}
          containerStyle={{ display: 'flex', gap: '0.1875rem', background: 'var(--line-soft)', borderRadius: '0.5625rem', padding: '0.1875rem' }}
          itemStyle={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.3125rem 0.75rem', borderRadius: '0.4375rem', fontSize: '0.78125rem', color: 'var(--ink-subtle)', fontWeight: 500 }}
          activeItemStyle={{ background: 'var(--seg-active)', color: 'var(--ink)', fontWeight: 650, boxShadow: '0 0.0625rem 0.125rem rgba(16,24,40,.1)' }}
        />
      </div>

      <div className="flex gap-[0.3125rem]">
        <Button
          type="button"
          variant="outline"
          aria-pressed={showAxes}
          onClick={() => setShowAxes((v) => !v)}
          className={cn(
            'h-auto flex-1 rounded-[0.4375rem] py-[0.3125rem] text-xs font-normal text-ink-soft',
            // 用 ! 覆盖 Button outline variant 的 dark:bg-input/* 默认值
            showAxes && 'border-chip! bg-chip! text-chip-fg! hover:bg-chip! hover:text-chip-fg!',
          )}
        >
          {t('solo:preview.axes')}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={focusAll}
          className="h-auto flex-1 rounded-[0.4375rem] py-[0.3125rem] text-xs font-normal text-ink-soft"
        >
          {t('solo:preview.focus')}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={topViewAll}
          className="h-auto flex-1 rounded-[0.4375rem] py-[0.3125rem] text-xs font-normal text-ink-soft"
        >
          {t('solo:preview.topView')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => setExpanded(true)}
          className="h-auto w-[2.375rem] rounded-[0.4375rem] py-[0.3125rem] text-ink-soft"
        >
          <Maximize2 size="0.75rem" />
        </Button>
      </div>

      <PreviewViewport
        ref={miniRef}
        viewBadge={vm.viewBadge}
        showAxes={showAxes}
        paused={expanded}
        hidden={expanded}
      />

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="flex h-[85vh] w-[92vw] max-w-6xl flex-col gap-3 overflow-hidden p-4 sm:max-w-6xl">
          <DialogTitle className="flex items-center gap-2 text-[0.9375rem]">
            <Box size="1rem" /> {t('solo:preview.title')}
          </DialogTitle>
          <div className="min-h-0 flex-1">
            <PreviewViewport ref={expandedRef} viewBadge={vm.viewBadge} showAxes={showAxes} fill />
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

const PreviewViewport = forwardRef<
  RobotViewportHandle,
  { viewBadge: string; showAxes: boolean; fill?: boolean; paused?: boolean; hidden?: boolean }
>(function PreviewViewport({ viewBadge, showAxes, fill, paused, hidden }, ref) {
  const { t } = useTranslation('solo')
  const baseStyle: CSSProperties = fill
    ? {
        width: '100%',
        height: '100%',
        borderRadius: '0.625rem',
        position: 'relative',
        overflow: 'hidden',
      }
    : {
        // aspect-ratio (not a fixed px height) lets the box scale with the
        // fluid column width instead of overflowing on narrow columns or
        // looking tiny on a 4K one.
        aspectRatio: '5 / 3',
        minHeight: '11.25rem',
        maxHeight: '21.25rem',
        borderRadius: '0.625rem',
        position: 'relative',
        overflow: 'hidden',
      }
  return (
    <div
      style={hidden ? { ...baseStyle, visibility: 'hidden' } : baseStyle}
    >
      <Suspense
        fallback={
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '0.75rem',
              color: '#8b97a6',
            }}
          >
            {t('solo:preview.loading')}
          </div>
        }
      >
        <RobotViewport ref={ref} showAxes={showAxes} paused={paused} />
      </Suspense>
      <div
        style={{
          position: 'absolute',
          left: '0.875rem',
          bottom: '0.75rem',
          fontFamily: "'JetBrains Mono',monospace",
          fontSize: '0.6875rem',
          color: 'var(--ink-muted)',
          background: 'var(--overlay)',
          padding: '0.1875rem 0.4375rem',
          borderRadius: '0.375rem',
          zIndex: 2,
        }}
      >
        {viewBadge}
      </div>
    </div>
  )
})

import { useCallback, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/**
 * 点动盘的格子，**数组顺序就是它在盘面上的位置**（十字形，不是 3×3）：
 *
 * ```
 *           [Z+] [Z−]        ← 顶部一对（+ / −），左右对称
 *           [   X+   ]       ← 上（横跨中间两列）
 *   [Y+]    [  (mm)  ] [Y−]  ← 左 / 中间标签 / 右
 *           [   X−   ]
 * ```
 *
 * `[label, sub?, center?]`：`sub` 只作为悬停提示（图面上不显示小字），`center`
 * 是中间那个只显示文字的格子。
 */
export type PadCell = [label: string, sub?: string, center?: true] | null

/**
 * 4 列 × 4 行：中轴落在第 2/3 列之间，所以顶部那一对紧挨着对称摆放，而上下两个
 * 轴按钮横跨中间两列——比 5 列均分宽得多（同一张卡里 1 格从 29px 变 48px）。
 */
const PLACEMENT = [
  'col-start-2 row-start-1',
  'col-start-3 row-start-1',
  'col-span-2 col-start-2 row-start-2',
  'col-start-1 row-start-3',
  'col-span-2 col-start-2 row-start-3',
  'col-start-4 row-start-3',
  'col-span-2 col-start-2 row-start-4',
]

/** 十字点动盘：按下触发 onPress(label)，松开/移出/取消触发 onRelease()
 *  （长按连续点动由调用方实现，这里只负责可靠的按下/释放语义）。 */
export function DirectionPad({
  cells,
  onPress,
  onRelease,
}: {
  cells: PadCell[]
  onPress: (label: string) => void
  onRelease?: () => void
}) {
  const pressedRef = useRef(false)
  const onPressRef = useRef(onPress)
  const onReleaseRef = useRef(onRelease)
  onPressRef.current = onPress
  onReleaseRef.current = onRelease

  const press = useCallback((label: string) => {
    if (pressedRef.current) return
    pressedRef.current = true
    onPressRef.current(label)
  }, [])

  const release = useCallback(() => {
    if (!pressedRef.current) return
    pressedRef.current = false
    onReleaseRef.current?.()
  }, [])

  // 在按钮外松手/取消触摸时也要停止重复；卸载时清理定时器。
  useEffect(() => {
    const rel = () => release()
    window.addEventListener('pointerup', rel)
    window.addEventListener('pointercancel', rel)
    return () => {
      window.removeEventListener('pointerup', rel)
      window.removeEventListener('pointercancel', rel)
      rel()
    }
  }, [release])

  return (
    <div className="grid w-full grid-cols-4 grid-rows-4 gap-[0.5rem]">
      {cells.map((c, i) => {
        const place = PLACEMENT[i] ?? ''
        if (!c) return <div key={i} className={place} />
        const [label, sub, center] = c
        if (center) {
          return (
            <div
              key={i}
              className={cn('flex flex-col items-center justify-center leading-tight', place)}
            >
              <div className="text-[0.75rem] text-muted-foreground">{label}</div>
              {sub ? <div className="text-[0.625rem] text-muted-foreground/80">{sub}</div> : null}
            </div>
          )
        }
        return (
          <Button
            key={i}
            type="button"
            // 图稿里顶部那一对是描边，十字上的四个方向是实心主色。
            variant={i < 2 ? 'outline' : 'default'}
            title={sub}
            onPointerDown={(e) => {
              e.preventDefault()
              // 捕获指针：即使在按钮外松手，也能收到 pointerup。
              try {
                e.currentTarget.setPointerCapture(e.pointerId)
              } catch {
                /* 某些指针类型不支持捕获时忽略 */
              }
              press(label)
            }}
            onPointerUp={release}
            onPointerLeave={release}
            onPointerCancel={release}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                e.preventDefault()
                press(label)
              }
            }}
            onKeyUp={(e) => {
              if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') release()
            }}
            onBlur={release}
            className={cn('h-[2.75rem] touch-none p-0', place)}
          >
            <span className="font-mono text-[1.0625rem] font-semibold">{label}</span>
          </Button>
        )
      })}
    </div>
  )
}

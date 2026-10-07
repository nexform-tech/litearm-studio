import { useCallback, useEffect, useRef, type CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/**
 * 点动盘的格子，**数组顺序就是它在盘面上的位置**（十字形）：
 *
 * ```
 *        [0] [1]        ← 顶部一对（+ / −），居中
 *        [ ] [2] [ ]     ← 上
 *        [3] [4] [5]     ← 左 / 中间标签 / 右
 *        [ ] [6] [ ]     ← 下
 * ```
 *
 * `[label, sub?, center?]`：`sub` 只作为悬停提示（图面上不显示小字），`center`
 * 是中间那个只显示文字的格子。
 *
 * ⚠ **盘上每个按钮同宽**：下面是 3 列等宽网格，顶部那一对是两个居中的独立按钮，
 * 宽度用同一条算式（`CELL`）算出来，所以 1 格宽 = 顶部按钮宽。
 */
export type PadCell = [label: string, sub?: string, center?: true] | null

/** 3 列 + 2 个 0.5rem 间隙里的一格宽。 */
const CELL: CSSProperties = { width: 'calc((100% - 1rem) / 3)' }

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

  const button = (cell: PadCell, key: number, width?: CSSProperties) => {
    if (!cell) return <div key={key} />
    const [label, sub] = cell
    return (
      <Button
        key={key}
        type="button"
        // 图稿里顶部那一对是描边，十字上的四个方向是实心主色。
        variant={width ? 'outline' : 'default'}
        title={sub}
        style={width}
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
        className={cn('h-full max-h-[3.25rem] min-h-[2.5rem] touch-none p-0', !width && 'w-full')}
      >
        <span className="font-mono text-[1.0625rem] font-semibold">{label}</span>
      </Button>
    )
  }

  const center = (cell: PadCell, key: number) => {
    const [label, sub] = cell ?? ['', '']
    return (
      <div key={key} className="flex flex-col items-center justify-center leading-tight">
        <div className="text-[0.75rem] text-muted-foreground">{label}</div>
        {sub ? <div className="text-[0.625rem] text-muted-foreground/80">{sub}</div> : null}
      </div>
    )
  }

  return (
    /* 4 行等高：顶部一对是"一行里居中放两个"，下面三行各自是 3 列。
       按钮宽度 = 3 列里的一格（CELL），行高由这 4 行平分，所以整盘每格完全等大。 */
    <div className="grid h-full min-h-0 grid-rows-4 gap-[0.5rem]">
      <div className="flex items-center justify-center gap-[0.5rem]">
        {button(cells[0], 0, CELL)}
        {button(cells[1], 1, CELL)}
      </div>
      <div className="grid grid-cols-3 items-center gap-[0.5rem]">
        <div />
        {button(cells[2], 2)}
        <div />
      </div>
      <div className="grid grid-cols-3 items-center gap-[0.5rem]">
        {button(cells[3], 3)}
        {center(cells[4], 4)}
        {button(cells[5], 5)}
      </div>
      <div className="grid grid-cols-3 items-center gap-[0.5rem]">
        <div />
        {button(cells[6], 6)}
        <div />
      </div>
    </div>
  )
}

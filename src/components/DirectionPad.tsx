import { useCallback, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

export type PadCell = [label: string, sub?: string, center?: true] | null

/** Ports Component.pad(): a 3x3 grid of jog buttons with a disabled center cell.
 *  按下触发 onPress(label)，松开/移出/取消触发 onRelease()（长按连续点动由
 *  调用方实现，这里只负责可靠的按下/释放语义）。 */
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
    <div className="grid flex-1 grid-cols-3 grid-rows-3 gap-[0.5625rem]">
      {cells.map((c, i) => {
        if (!c) return <div key={i} />
        const [label, sub, center] = c
        return (
          <Button
            key={i}
            type="button"
            variant="outline"
            disabled={!!center}
            onPointerDown={center ? undefined : (e) => {
              e.preventDefault()
              // 捕获指针：即使在按钮外松手，也能收到 pointerup。
              try {
                e.currentTarget.setPointerCapture(e.pointerId)
              } catch {
                /* 某些指针类型不支持捕获时忽略 */
              }
              press(label)
            }}
            onPointerUp={center ? undefined : release}
            onPointerLeave={center ? undefined : release}
            onPointerCancel={center ? undefined : release}
            onKeyDown={center ? undefined : (e) => {
              if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                e.preventDefault()
                press(label)
              }
            }}
            onKeyUp={center ? undefined : (e) => {
              if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') release()
            }}
            onBlur={center ? undefined : release}
            className={cn(
              'h-auto flex-col gap-0.5 rounded-[0.5625rem] touch-none disabled:opacity-100',
              center && 'border-dashed bg-transparent',
            )}
          >
            <div className={cn('font-mono text-[0.9375rem] font-semibold', center && 'text-[0.6875rem] text-muted-foreground')}>
              {label}
            </div>
            <div className="text-[0.625rem] text-muted-foreground">{sub}</div>
          </Button>
        )
      })}
    </div>
  )
}

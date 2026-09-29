import type { CSSProperties, ReactNode } from 'react'
import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui'

export type SegItem = {
  key: string
  label: ReactNode
  active: boolean
  onClick: () => void
  /** 置灰且不可选。用于「该能力在当前硬件上不存在」的标签，而不是临时忙碌态。 */
  disabled?: boolean
  /** 不可选原因的悬停提示。 */
  disabledTitle?: string
}

/**
 * Single-select "pill group" built on Radix's `ToggleGroup` primitive for
 * real roving-tabindex / aria-pressed semantics, while still letting callers
 * fully control the visual styling per item via containerStyle/itemStyle/
 * activeItemStyle (kept for backwards compatibility with existing call sites).
 */
export function SegmentedControl({
  items,
  containerStyle,
  itemStyle,
  activeItemStyle,
  ariaLabel,
}: {
  items: SegItem[]
  containerStyle: CSSProperties
  itemStyle: CSSProperties
  activeItemStyle?: CSSProperties
  /** 组的可访问名称（`aria-label`）；没有可见标题的组必须给一个。 */
  ariaLabel?: string
}) {
  const activeKey = items.find((it) => it.active)?.key

  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={activeKey}
      aria-label={ariaLabel}
      onValueChange={(key) => {
        if (!key) return
        items.find((it) => it.key === key)?.onClick()
      }}
      style={containerStyle}
    >
      {items.map((it) => (
        <ToggleGroupPrimitive.Item
          key={it.key}
          value={it.key}
          disabled={it.disabled}
          title={it.disabled ? it.disabledTitle : undefined}
          style={{
            cursor: it.disabled ? 'not-allowed' : 'pointer',
            opacity: it.disabled ? 0.45 : 1,
            ...itemStyle,
            ...(it.active ? activeItemStyle : undefined),
          }}
        >
          {it.label}
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  )
}

import type { CSSProperties, ReactNode } from 'react'
import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui'

export type SegItem = {
  key: string
  label: ReactNode
  active: boolean
  onClick: () => void
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
}: {
  items: SegItem[]
  containerStyle: CSSProperties
  itemStyle: CSSProperties
  activeItemStyle?: CSSProperties
}) {
  const activeKey = items.find((it) => it.active)?.key

  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={activeKey}
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
          style={{
            cursor: 'pointer',
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

import type { CSSProperties } from 'react'

// Fluid column widths: `clamp(min, preferred-vw, max)` is the standard CSS
// technique for panels that should track viewport width between a hard floor
// and the mockup's original pixel value, instead of a rigid px that overflows
// on laptop-size viewports or looks tiny on 4K. `flex: 0 1 <clamp>` lets the
// column shrink below its basis (down to the clamp floor) but never grow past it.
// minWidth is a real floor (browsers honor it over flex-shrink); the clamp()
// inside `flex` is the *preferred* fluid size between that floor and the
// mockup's original px value.
export const SIDE_COL_WIDE: CSSProperties = { flex: '0 1 clamp(20rem, 27vw, 31rem)', minWidth: '20rem' }

// A scrollable flex column: content that doesn't fit the viewport height
// scrolls inside its own panel instead of being clipped by the page.
//
// ⚠ Panels that should fill the remaining height must use `flex: 1 0 auto`,
// never a bare `flex: 1`: basis 0 + shrink lets a short viewport squeeze them
// below their content, and `Card`'s `overflow-hidden` then clips that content
// with nothing to scroll — the column's scrollHeight equals its clientHeight,
// so no scrollbar appears.
export const SCROLL_COLUMN: CSSProperties = { display: 'flex', flexDirection: 'column', minHeight: '0rem', overflowY: 'auto' }

// Last-resort escape hatch for the 3-column rows: if every column is already
// at its minimum width and still doesn't fit (very narrow window), scroll
// horizontally rather than silently clipping content — the same pattern wide
// data tables and dense dashboards (Grafana, admin consoles) use.
export const ROW_OVERFLOW: CSSProperties = { overflowX: 'auto' }

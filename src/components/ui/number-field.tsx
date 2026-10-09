import { useState } from 'react'
import { Input } from '@/components/ui/input'

/**
 * 数字输入框：编辑期间用本地草稿，清空/非法输入不提交（保留旧值），
 * 失焦或回车时按 [min, max] 收敛后提交，避免空串变成 0 下发到控制器。
 */
export function NumberField({
  value,
  onCommit,
  min,
  max,
  step,
  disabled,
  className,
  digits,
}: {
  value: number | undefined
  onCommit: (v: number) => void
  min: number
  max: number
  step?: number
  disabled?: boolean
  className?: string
  /**
   * 固定小数位显示（如 `digits={4}` ⇒ `1.5707963…` 显示成 `1.5708`）。
   *
   * ⚠ 只影响**显示**：没编辑就直接失焦时 `commit()` 原样保留旧值，所以读回/预设的
   * 全精度数字不会被这一层舍入悄悄改掉（见 `installationPose.ts`）。
   */
  digits?: number
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? (value == null ? '' : digits == null ? String(value) : value.toFixed(digits))

  const commit = () => {
    const raw = draft
    setDraft(null)
    if (raw == null || raw.trim() === '') return
    const n = Number(raw)
    if (!Number.isFinite(n)) return
    onCommit(Math.min(max, Math.max(min, n)))
  }

  return (
    <Input
      type="number"
      disabled={disabled}
      value={shown}
      step={step}
      min={min}
      max={max}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        }
      }}
      className={className}
    />
  )
}

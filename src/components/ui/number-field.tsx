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
}: {
  value: number | undefined
  onCommit: (v: number) => void
  min: number
  max: number
  step?: number
  disabled?: boolean
  className?: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? (value == null ? '' : String(value))

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
